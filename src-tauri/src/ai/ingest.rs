// 知识库入库：采集记录渲染为中文文本块 → FNV 去重 → 批量嵌入（≤32/批）。
use crate::ai::config::AiConfig;
use crate::ai::fnv1a_hex;
use crate::ai::provider::Embedder;
use crate::ai::vectordb::{self, NewChunk};
use std::path::Path;
use tauri::Emitter;

pub const TARGET_CHARS: usize = 400;
pub const OVERLAP_CHARS: usize = 50;
pub const EMBED_BATCH: usize = 32;

/// Markdown 切块：围栏代码块整块保留；标题在 prose 非空时切段；段落聚合成块。
pub fn split_markdown(text: &str) -> Vec<String> {
    let mut blocks: Vec<String> = Vec::new();
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;
    let mut prose = String::new();
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            if !prose.trim().is_empty() {
                blocks.push(std::mem::take(&mut prose));
            }
            let mut fence = String::from(line);
            fence.push('\n');
            i += 1;
            while i < lines.len() && !lines[i].trim_start().starts_with("```") {
                fence.push_str(lines[i]);
                fence.push('\n');
                i += 1;
            }
            if i < lines.len() {
                fence.push_str(lines[i]); // 收尾围栏；未闭合则保留到文末
                i += 1;
            }
            blocks.push(fence.trim_end().to_string());
        } else {
            if trimmed.starts_with('#') && !prose.trim().is_empty() {
                blocks.push(std::mem::take(&mut prose));
            }
            prose.push_str(line);
            prose.push('\n');
            i += 1;
        }
    }
    if !prose.trim().is_empty() {
        blocks.push(prose.trim().to_string());
    }
    pack_blocks(blocks)
}

/// 纯文本切块：按空行切段，trim、去空后打包。
pub fn split_plain(text: &str) -> Vec<String> {
    let paras: Vec<String> = text
        .split("\n\n")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    pack_blocks(paras)
}

/// 把段落块累计打包到约 TARGET_CHARS；超长单块先 flush 当前块再硬切；
/// 围栏代码块独立成块（代码不与散文混包）；块间以换行连接。
fn pack_blocks(blocks: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut cur = String::new();
    for b in blocks {
        // 围栏代码块独立成块：既保证整块不拆，也不与前后散文混包
        if b.trim_start().starts_with("```") {
            flush_cur(&mut cur, &mut out);
            if !b.trim().is_empty() {
                out.push(b);
            }
            continue;
        }
        if b.chars().count() > TARGET_CHARS {
            flush_cur(&mut cur, &mut out);
            out.extend(hard_split(&b));
            continue;
        }
        if cur.chars().count() + b.chars().count() + 1 > TARGET_CHARS && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push('\n');
        }
        cur.push_str(&b);
    }
    flush_cur(&mut cur, &mut out);
    out.into_iter().filter(|s| !s.trim().is_empty()).collect()
}

fn flush_cur(cur: &mut String, out: &mut Vec<String>) {
    if !cur.trim().is_empty() {
        out.push(std::mem::take(cur));
    }
}

/// 按字符硬切：每段 TARGET_CHARS，下一段起点回退 OVERLAP_CHARS（末段可能更短）。
fn hard_split(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= TARGET_CHARS {
        return vec![s.to_string()];
    }
    let mut out = vec![];
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + TARGET_CHARS).min(chars.len());
        out.push(chars[start..end].iter().collect::<String>());
        if end == chars.len() {
            break;
        }
        start = end.saturating_sub(OVERLAP_CHARS);
    }
    out
}

/// 对未嵌入分块批量补嵌，返回成功补嵌条数。
/// 嵌入服务不可用时保留 embedded=0 待下次补嵌：emit 带 error 的进度后 Ok 降级，不阻断。
pub async fn embed_pending(
    dir: &Path,
    cfg: &AiConfig,
    embedder: &dyn Embedder,
    app: Option<&tauri::AppHandle>,
    limit: usize,
) -> Result<usize, String> {
    let model_hash = format!("{}:{}", cfg.provider, cfg.embed_model);
    let pending = {
        let db = vectordb::open(&dir.join("ai.db"))?;
        vectordb::list_pending(&db.0, limit as i64)?
    };
    let total = pending.len();
    let mut done = 0usize;
    for batch in pending.chunks(EMBED_BATCH) {
        let texts: Vec<String> = batch.iter().map(|p| p.text.clone()).collect();
        let vecs = match embedder.embed(texts).await {
            Ok(v) => v,
            Err(e) => {
                // 嵌入不可用：保留 embedded=0，下次补嵌；不阻断已完成的部分
                if let Some(a) = app {
                    let _ = a.emit(
                        "ai://index_progress",
                        serde_json::json!({"phase":"embed","done":done,"total":total,"error":e}),
                    );
                }
                return Ok(done);
            }
        };
        let db = vectordb::open(&dir.join("ai.db"))?;
        for (p, v) in batch.iter().zip(vecs.into_iter()) {
            vectordb::set_embedding(&db.0, p.id, &model_hash, &v)?;
            done += 1;
        }
        if let Some(a) = app {
            let _ = a.emit(
                "ai://index_progress",
                serde_json::json!({"phase":"embed","done":done,"total":total}),
            );
        }
    }
    Ok(done)
}

/// 日度增量入库：最近 500 条催化剂 + 全部在册题材 + 指定日涨停定格。
/// catalyst/theme 每日全量扫描，靠 content_hash 的 FNV 去重保证幂等（brief 设计）。
pub async fn index_day(
    dir: &Path,
    cfg: &AiConfig,
    embedder: &dyn Embedder,
    trade_date: &str,
    app: Option<&tauri::AppHandle>,
) -> Result<usize, String> {
    let main = crate::ai::maindb::open_readonly(dir)?;

    // 候选三组（source_ref, title, body, dedupe_basis, source_type）
    let mut candidates: Vec<(String, String, String, String, String)> = vec![];
    {
        let mut st = main
            .prepare(
                "SELECT 'cat:'||id, title, COALESCE(summary,title), content_hash, 'catalyst'
                 FROM catalyst ORDER BY id DESC LIMIT 500",
            )
            .map_err(|e| e.to_string())?;
        let rs = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rs {
            candidates.push(r.map_err(|e| e.to_string())?);
        }
    }
    {
        let mut st = main
            .prepare(
                "SELECT 'theme:'||id, name,
                        COALESCE(NULLIF(logic,''), NULLIF(intro,''), name),
                        'theme:'||id||'#'||COALESCE(logic_version,1), 'theme'
                 FROM theme",
            )
            .map_err(|e| e.to_string())?;
        let rs = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rs {
            candidates.push(r.map_err(|e| e.to_string())?);
        }
    }
    {
        let mut st = main
            .prepare(
                "SELECT 'lu:'||trade_date||':'||code,
                        name||' '||boards||'连板',
                        '日期 '||trade_date||'：'||name||'('||code||') '||boards||' 连板，'
                        ||'首次封板 '||COALESCE(first_seal,0)||'，炸板'||broken||' 次，'
                        ||'行业 '||industry||'；概念'||concepts,
                        trade_date||':'||code||':'||COALESCE(boards,1)||':'||COALESCE(first_seal,0),
                        'limitup'
                 FROM limit_up_record WHERE trade_date=?1",
            )
            .map_err(|e| e.to_string())?;
        let rs = st
            .query_map(rusqlite::params![trade_date], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rs {
            candidates.push(r.map_err(|e| e.to_string())?);
        }
    }
    drop(main);

    let db = vectordb::open(&dir.join("ai.db"))?;
    let mut inserted = 0usize;
    for (source_ref, title, body, dedupe_basis, source_type) in candidates {
        let hash = fnv1a_hex(&format!("{source_type}:{source_ref}:{dedupe_basis}"));
        let is_new = vectordb::insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: &body,
                source_type: &source_type,
                source_ref: &source_ref,
                title: &title,
                chunk_index: 0,
                content_hash: &hash,
                model_hash: "",
                embedding: None,
            },
        )?;
        if is_new {
            inserted += 1;
        }
    }
    drop(db);

    if let Some(a) = app {
        let _ = a.emit(
            "ai://index_progress",
            serde_json::json!({"phase":"collect","done":inserted,"total":inserted}),
        );
    }
    if cfg.enable_auto_index {
        // embed_pending 的嵌入失败已是 Ok 降级；? 仅传播真正 Err（如 ai.db 故障）
        embed_pending(dir, cfg, embedder, app, 500).await?;
    }
    Ok(inserted)
}

/// 导入一篇文档文本（调用方负责选文件/读文件）；返回新增分块数。
pub fn ingest_document(
    dir: &Path,
    file_name: &str,
    content: &str,
    markdown: bool,
) -> Result<usize, String> {
    let chunks = if markdown {
        split_markdown(content)
    } else {
        split_plain(content)
    };
    let db = vectordb::open(&dir.join("ai.db"))?;
    let mut n = 0;
    for (i, ch) in chunks.iter().enumerate() {
        let head64: String = ch.chars().take(64).collect();
        let hash = fnv1a_hex(&format!("manual_doc:{file_name}:{i}:{head64}"));
        let new = vectordb::insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: ch,
                source_type: "manual_doc",
                source_ref: file_name,
                title: file_name,
                chunk_index: i as i64,
                content_hash: &hash,
                model_hash: "",
                embedding: None,
            },
        )?;
        if new {
            n += 1;
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn markdown_keeps_code_fence_whole() {
        let md = "# 标题\n\n这是一段普通文字，介绍龙头战法的基本要点，".to_string()
            + &"字".repeat(300)
            + "\n\n```rust\nfn main() {\n    println!(\"code\");\n}\n```\n\n尾部。";
        let chunks = split_markdown(&md);
        assert!(chunks.len() >= 2);
        // 代码块完整落在某一个块中
        assert!(chunks.iter().any(
            |c| c.contains("```rust") && c.contains("fn main()") && c.contains("```")
        ));
    }

    #[test]
    fn hard_split_overlaps_50_chars() {
        let s: String = "字".repeat(450);
        let chunks = hard_split(&s);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chars().count(), 400);
        // 第二块 = 末 50 + 后 50 = 100 字
        assert_eq!(chunks[1].chars().count(), 100);
    }

    #[test]
    fn plain_packs_paragraphs() {
        let p1 = "短段一".to_string();
        let p2 = "短段二".to_string();
        let chunks = split_plain(&format!("{p1}\n\n{p2}\n\n  \n\n"));
        assert_eq!(chunks, vec![format!("{p1}\n{p2}")]);
    }

    #[test]
    fn headings_split_sections() {
        let md = "# 一\n内容甲\n# 二\n内容乙";
        let chunks = split_markdown(md);
        assert!(chunks.iter().any(|c| c.contains("内容甲") && c.contains("# 一")));
        assert!(chunks.iter().any(|c| c.contains("内容乙")));
    }

    /// 固定三维向量桩：不触网，任何文本返回同一向量。
    struct MockEmbedder;
    impl Embedder for MockEmbedder {
        fn embed<'a>(
            &'a self,
            texts: Vec<String>,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<f32>>, String>> + Send + 'a>> {
            Box::pin(async move {
                Ok(texts
                    .into_iter()
                    .map(|_| vec![0.1_f32, 0.2_f32, 0.3_f32])
                    .collect())
            })
        }
    }

    /// 临时 data_dir（进程内原子序号防并行撞名）：主库三表 + ai.db 同目录。
    fn seeded_dir() -> std::path::PathBuf {
        static DIR_SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("tickgold-ai-ingest-{}-{}", crate::ai::now_millis(), seq));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = rusqlite::Connection::open(dir.join("stock-dock.db")).unwrap();
        c.execute_batch(
            "CREATE TABLE catalyst(
                id INTEGER PRIMARY KEY,
                kind TEXT DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                summary TEXT,
                content_hash TEXT,
                collected_at INTEGER
             );
             CREATE TABLE theme(
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                intro TEXT DEFAULT '',
                logic TEXT DEFAULT '',
                logic_version INTEGER
             );
             CREATE TABLE limit_up_record(
                trade_date TEXT NOT NULL,
                code TEXT NOT NULL,
                name TEXT DEFAULT '',
                boards INTEGER,
                first_seal INTEGER,
                broken INTEGER DEFAULT 0,
                industry TEXT DEFAULT '',
                concepts TEXT DEFAULT '',
                UNIQUE(trade_date, code)
             );",
        )
        .unwrap();
        c.execute(
            "INSERT INTO catalyst(id,title,summary,content_hash) VALUES(1,'甲公司签订大单',NULL,'cat-hash-1')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO theme(id,name,intro,logic,logic_version) VALUES(1,'机器人','','',NULL)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO limit_up_record(trade_date,code,name,boards,first_seal,broken,industry,concepts)
             VALUES('2026-09-30','300001','甲',2,93100,0,'机械','机器人'),
                   ('2026-09-30','300002','乙',1,94000,1,'电子','芯片')",
            [],
        )
        .unwrap();
        dir
    }

    #[tokio::test]
    async fn index_day_dedupes_and_counts() {
        let dir = seeded_dir();
        let cfg = AiConfig {
            enable_auto_index: false,
            ..AiConfig::default()
        };
        // 首次：1 catalyst + 1 theme + 2 limitup = 4
        let n1 = index_day(&dir, &cfg, &MockEmbedder, "2026-09-30", None)
            .await
            .unwrap();
        assert_eq!(n1, 4);
        // 同参数再跑：FNV content_hash 去重，幂等返回 0
        let n2 = index_day(&dir, &cfg, &MockEmbedder, "2026-09-30", None)
            .await
            .unwrap();
        assert_eq!(n2, 0);
        // ai 库：4 条待嵌入，embedded 全为 0
        let db = vectordb::open(&dir.join("ai.db")).unwrap();
        let pending = vectordb::list_pending(&db.0, 100).unwrap();
        assert_eq!(pending.len(), 4);
        let embedded: i64 = db
            .0
            .query_row("SELECT count(*) FROM kb_chunk WHERE embedded=1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(embedded, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
