# v1.9.0 慢脑知识库 + 应用内 AI 问数助手设计

> 承接 `2026-09-30-ai-trading-pipeline-design.md` 总体设计第 2 步「分析层」的底座部分
> 与 v1.9.0 版本目标（Ollama/云 Key 可配；RAG 引用事实证据；MCP 覆盖选股/题材/催化）。
> 本文档定义的功能在应用版本 **v1.9.0** 发布；前一批「采集增强+题材库」实际发布位为
> v1.8.0，版本路线见总设第十节。

## 一、目标与范围

### 1.1 本批交付（可感知效果）

1. **应用内 AI 问数助手卡**：自然语言提问（"今天市场情绪怎样""某题材为什么涨"
   "我的持仓有什么催化"），慢脑经只读工具查询本地数据仓 + RAG 语义检索后作答，
   流式输出，每个事实结论附可点击证据（跳转对应卡片/原文链接）。
2. **双通道模型配置**：Ollama 本地（默认，数据不出本机）与云端 OpenAI 兼容端点
   （DeepSeek/智谱/Kimi/OpenAI 等，自定义 base_url + Key），设置页可测试连接。
3. **本地语义知识库**：采集数据（催化剂/互动问答/题材/涨停定格）随归因作业自动
   切块入库嵌入；支持手动导入 `.md/.txt`（战法讲解、复盘文章、个人心得）。
4. **内部工具接口层**：按 MCP 语义设计的只读工具注册表，v1.9 仅供应用内 agent
   调用；未来加 transport 即可对外提供标准 MCP 服务。

### 1.2 明确不做（YAGNI）

- 对外标准 MCP transport（HTTP/stdio server、外部客户端接入）→ 后续版本；
- PDF/Word 解析导入 → 后续版本（合规上原文 PDF 本就不落地）；
- 战法 Profile / 因子引擎 / 三战法自动复盘 → v2.0；
- 多模态、语音；会话云端同步；
- 主库 `stock-dock.db` 任何结构变更（v1.9 主库零迁移）。

## 二、关键决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 范围 = 应用内 AI 问数助手 | v2.0 自动复盘的前置底座，工具/prompt/RAG 全部可复用 |
| 2 | OpenAI 兼容协议统一双通道 | Ollama 内置 `/v1` 兼容；云端各厂均兼容；一套客户端代码 |
| 3 | 嵌入 = Ollama/云 embeddings；向量存 SQLite BLOB，Rust 余弦暴力检索 | 个人库万级分块毫秒级；零原生扩展，三平台打包无负担 |
| 4 | MCP 以内部工具接口形态落地 | 控制本批工作量，接口语义对齐 MCP，未来仅加 transport |
| 5 | Agent 循环在 Rust 单环实现 | Key 不出 Rust、Webview CSP 不放开外网、工具直连库、可 mock 测试 |
| 6 | 语料 = 采集数据自动入库 + 手动 md/txt | 个人战法库立即可用，解析成本低 |

合规延续：云 Key 仅存系统凭据箱；外部数据只存标题/摘要/链接；回答保留
「不构成投资建议」；慢脑只能引用工具返回的数字，不得改写。

## 三、架构

### 3.1 模块划分（Rust 新增 `src-tauri/src/ai/`）

```
AI 助手卡（Vue，纯渲染/交互）
   │ invoke: ai_chat_send / ai_chat_abort
   │         ai_get_config / ai_save_config / ai_test_connection
   │         ai_list_sessions / ai_new_session / ai_load_session / ai_delete_session
   │         ai_kb_stats / ai_import_docs / ai_delete_doc / ai_reindex
   │         ai_index_daily（归因后 fire-and-forget）
   │ events: ai://token · ai://tool · ai://done · ai://error
   │         ai://index_progress
   ▼
src-tauri/src/ai/
├── mod.rs        模块导出与命令聚合
├── provider.rs   OpenAI 兼容客户端：chat/completions 流式 SSE、embeddings
├── agent.rs      Agent 循环：历史装配、工具调用、轮数/超时控制、中止
├── tools.rs      只读工具注册表：JSON Schema + 处理函数 + factRef
├── vectordb.rs   边车库 ai.db：连接、迁移(user_version)、CRUD、余弦检索
├── maindb.rs     主库 stock-dock.db 只读旁路(rusqlite mode=ro)
├── ingest.rs     入库管道：记录→文本块→去重→批嵌入；md/txt 切块器
└── config.rs     配置 JSON 读写；云 Key 走系统凭据箱
```

- **主库只读旁路**：Rust 用 rusqlite 以 `mode=ro` 打开现有 `stock-dock.db`
  （路径由 app_data_dir 解析，与 tauri-plugin-sql 同库同路径），不参与其迁移体系。
- **AI 边车库 `ai.db`**：分块/向量/会话/配置全部独立，Rust 自管 `user_version`
  迁移；损坏时自动备份重建（参考主库备份恢复思路），不影响行情主功能。
- 新增依赖：`rusqlite`（bundled）、`futures-util`/`tokio-stream`（SSE 流处理，
  按实际需要取一）、`keyring`（系统凭据箱）。
- CSP：Webview 不新增任何外部域名白名单；外网请求只从 Rust 发出。

### 3.2 一次问答的数据流

1. 前端 `ai_chat_send(sessionId, text)`；用户消息先持久化到 `ai_message`。
2. Rust 装载该会话历史（最近 N=20 条 + 单会话上下文 token 预算保护），注入系统
   prompt（铁律：只用工具返回的数字；结论必须附证据；不知道就说不知道；
   末尾声明不构成投资建议；当前交易日与日期）。
3. 调 chat completions（stream=true）：
   - 文本 delta 经 `ai://token` 实时推送（前端拼装）；
   - 模型返回 tool_calls → 执行工具，`ai://tool` 推送 {callId, name, args,
     status(running/ok/error), elapsedMs}；结果以 `role=tool` 回灌，继续循环。
4. 循环上限 **6 轮工具调用**；单次 LLM 请求 60s、单个工具 5s 超时；
   工具报错以错误内容回灌，允许模型当轮换工具或改答。
5. 结束：assistant 完整文本 + 本轮 refs 汇总落库，`ai://done` 推送消息 id 与
   refs；中止时 `ai://error`/done(aborted=true) 保留已生成片段。
6. 首轮用户消息自动生成会话标题（取前 16 字，不额外调模型）。

### 3.3 工具集（v1.9，全部只读）

| 工具 | 入参（摘要） | 数据来源 | factRef 跳转 |
|---|---|---|---|
| `market_overview` | date?(默认最近交易日) | limit_up_record 聚合：涨停数/炸板/连板高度/晋级率 | 涨停池卡 |
| `list_themes` | stage?, minScore?, limit? | theme + theme_stock | 题材库卡 |
| `theme_detail` | themeId 或 themeName | theme/theme_stock/limit_up_record/catalyst | 题材库卡详情 |
| `query_catalysts` | code?/theme?/keyword?/kind?/dateRange? | catalyst（+link） | 题材库/公告原文 URL |
| `stock_profile` | code | 行业概念标签、题材角色、近期涨停、催化时间线 | K线/F10 |
| `list_limit_ups` | date?/minBoards?/code? | limit_up_record | 涨停池卡 |
| `semantic_search` | query, topK?(默认5), sourceType? | kb_chunk 向量余弦 top-k | 文档/原文 |
| `paper_positions` | 无 | 主库模拟盘持仓表（只读） | 模拟盘卡 |

约束：
- 每个工具输出 ≤ 约 4k 字符，超出显式截断并提示缩小条件；
- 工具入参全部 JSON Schema 校验，非法入参返回校验错误（不 panic）；
- 每条结果记录携带 `factRef`（`{card:'limitpool'|'themelib'|...', code?/date?}`
  或 `{url}`）；v1.9 前端先实现卡片聚焦与外链两类；
- 代码/日期等入参在 Rust 侧做格式校验（6 位代码、YYYY-MM-DD）。

## 四、知识库入库

### 4.1 自动入库

- 挂载点与触发：每日归因作业在前端成功完成后（`useCollector` / `dailyJob`
  现有流程），以 fire-and-forget 方式 invoke 新命令 `ai_index_daily(tradeDate)`；
  独立 try/catch，**失败不阻断归因作业**，与公告/互动采集的降级模式一致。
- 增量内容：当日新增 catalyst（含公告/互动问答）、发生变化的 theme 简介块、
  当日 limit_up_record 定格摘要。
- 幂等：`ai_index_state(source_type, source_ref, cursor_hash)` 游标 +
  `kb_chunk.content_hash UNIQUE` 双重去重；hash 沿用 FNV-1a 口径。
- 嵌入：批 ≤32；嵌入服务不可用时分块以 `embedded=0` 入库，后台补嵌；
  进度经 `ai://index_progress{done,total,phase}` 推送。
- 每条记录用结构化模板渲染成自然中文一块（含日期/代码/名称等关键事实）。

### 4.2 手动导入

- 入口：AI 卡工具栏 + 设置 → AI 大脑 → 知识库管理；多选 `.md/.txt`。
- 读取：UTF-8（含 BOM 容忍）；解码失败明确报错并跳过该文件。
- 切块：Markdown 按标题层级切，目标 400 字/块、邻接重叠 50 字；围栏代码块
  整块不拆；纯文本按段落聚合到目标长度。
- 元数据：source_type=`manual_doc`，source_ref=文件名，title=首个标题/文件名，
  chunk_index 保留顺序。
- 删除：按文件删除级联删除其全部分块与向量。

### 4.3 分块与检索口径

- 每块：text、source_type、source_ref、title、content_hash、model_hash
  （嵌入模型标识，换模型时用于重建）、dim、embedding BLOB(可空)、created_at。
- 检索：Rust 端对 `embedded=1 且 dim 一致` 的分块算余弦相似度 top-k；
  零分块/零嵌入时 `semantic_search` 返回友好空结果而非报错。
- 重建索引：设置页一键按当前嵌入模型重嵌全部分块。

## 五、数据表（`ai.db`，首版迁移 v1–v4）

```sql
-- v1
CREATE TABLE kb_chunk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  source_type TEXT NOT NULL,          -- catalyst/irm/theme/limitup/manual_doc
  source_ref TEXT NOT NULL,           -- code / themeId / 文件名
  title TEXT NOT NULL DEFAULT '',
  chunk_index INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL UNIQUE,
  model_hash TEXT NOT NULL DEFAULT '',
  dim INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,                     -- f32 LE，可空
  embedded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_kb_chunk_source ON kb_chunk(source_type, source_ref);

-- v2
CREATE TABLE ai_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE ai_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,                 -- user/assistant/tool
  content TEXT NOT NULL,
  tool_calls TEXT NOT NULL DEFAULT '[]',
  refs TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_message_session ON ai_message(session_id, id);

-- v3
CREATE TABLE ai_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- v4
CREATE TABLE ai_index_state (
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  cursor_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_type, source_ref)
);
```

配置 JSON 形状（Key 不在其中）：

```json
{
  "provider": "ollama" | "cloud",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "chatModel": "qwen2.5:7b",
  "embedModel": "nomic-embed-text",
  "temperature": 0.3,
  "enableAutoIndex": true
}
```

云 Key 存系统凭据箱，service 名 `tickgold.ai.cloud-key`，设置页只显示
「已配置/未配置」状态，永不回显明文。

## 六、前端

### 6.1 AI 助手卡

- 卡片尺寸 6×4；`cards.ts` 新增 CardId `aiassistant`，`dock.ts` 新增
  「AI 助手」分组；布局默认尺寸 6×4；review 场景重排且 **总格数仍为 72**
  （由 `tests/unit/scenes.test.ts` 守卫）。
- 内容：会话切换/新建/删除（左栏或顶部下拉）；消息流（markdown：表格/列表/
  加粗/链接，纯渲染不执行 HTML）；工具调用折叠条（名称、入参摘要、耗时、
  状态）；证据 chip 点击 → 卡片聚焦或外链；流式光标；中止按钮；
  底部快捷提问 chips；空状态引导去配置模型。
- 前端文件：`src/ai/types.ts`、`src/ai/api.ts`（invoke 封装）、
  `src/composables/useAiChat.ts`（事件订阅/流式拼装/中止/会话）、
  `src/components/AiAssistant.vue`（卡片），接入 `CardContent.vue` 分支。
- markdown 渲染采用 `markdown-it`（新增依赖，锁定版本），**`html:false`**
  （原文 HTML 标签被转义，杜绝注入），链接强制 `target="_blank"` 经 opener
  外链打开；渲染管道唯一出口为 `v-html(markdownIt.render(text))`，
  `html:false` 保证 LLM 输出中的原始 HTML 全部被转义，无注入面。

### 6.2 设置 → AI 大脑

- 供应方分段控件（Ollama / 云端）；base_url（各自默认值预填，可改）；
  chat/embedding 模型名；温度；自动入库开关。
- 「测试连接」：分别探活 chat 与 embeddings，显示延迟与可用模型（拉
  `/v1/models`）；失败给区分化文案（未启动/401/超时/网络）。
- Ollama 段明示「数据不出本机」；云端段 Key 状态与设置/清除按钮。
- 知识库管理：分块总数、按 source_type 分布、存储占用、导入 md/txt、
  按文件删除、重建索引、最近入库时间。
- 数据中心（设置现有 dc-rows）增加一行「AI 知识库」。

## 七、错误处理与降级

1. Ollama 未启动/模型不存在：明确中文报错 + 安装/拉取指引，不静默失败。
2. 云端 401/429/5xx/超时：区分文案；进行中可中止；已生成片段保留入库。
3. 工具失败：错误内容回灌模型当轮自救；连续失败达轮数上限则带已知信息作答
   并说明受限项。
4. 嵌入不可用：分块正常入库（embedded=0），不影响问答；语义检索仅搜已嵌入块。
5. ai.db 损坏/迁移失败：自动备份后重建空库并提示；主功能不受影响。
6. 所有回答与空状态均保留「不构成投资建议」口径。

## 八、测试策略

- **Rust 单测**（`cargo test --manifest-path src-tauri/Cargo.toml --lib`）：
  SSE 解析用 fixture 流；tool_calls JSON 解析与 schema 校验；agent 循环用
  mock 服务端脚本覆盖：纯文本/单工具/多轮/工具错误恢复/超轮数/中止；
  md/txt 切块器（中文边界、重叠、代码块）；FNV 去重；余弦检索 top-k 与
  dim 不一致过滤；配置读写与 Key 凭据箱（测试用独立 service 名）。
  所有测试不触网。
- **前端单测**（Vitest，无网络）：流式事件拼装消息、工具条状态、refs→跳转
  映射、设置表单校验与默认值、会话 CRUD 封装 mock、场景 72 格守卫。
- 门禁：`pnpm test`、`pnpm build`、`cargo test --lib`、
  `pnpm tauri build --no-bundle` 全绿。
- **手动联调（用户本机）**：
  1. Ollama 真实一轮问答（含工具调用与证据点击）；
  2. 云端 Key 一轮问答；
  3. 导入一篇战法 md → 语义提问命中该文档；
  4. 归因作业后自动入库计数增长；
  5. Ollama 未启动时的报错与指引。

## 九、与后续版本的衔接

- 工具注册表与 factRef 即未来对外 MCP server 的工具面（仅加 transport/鉴权，
  绑定 127.0.0.1）。
- kb_chunk/RAG/系统 prompt 直接供 v2.0 AI 复盘（三战法候选叙事、相似案例检索）
  使用；v2.0 新增 `factor/`、`strategy/` 与 strategy_profile 表，不在本批。
- 会话与消息表保留 tool_calls/refs，v2.0 复盘报告可复用同一渲染与证据跳转。
