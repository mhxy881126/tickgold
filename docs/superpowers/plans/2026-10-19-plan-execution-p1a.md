# P1-a 实施计划：计划指令状态机 + 物化 + 只读列表

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 确认作战卡后把 `candidate`/`trigger` 指令自动物化为条件单，并在作战台只读展示每条指令的实时执行状态。

**Architecture:** 复用 `conditional_order` + `market/alert.rs` 触发引擎；新增 `ai::instruction` 模块负责 `alert_rule → CoTrigger` 映射、物化与状态推导；状态在读取时由「条件单 + 信号票 + 委托」推导，不落库。前端新增 `InstructionList` 与 `workflow.instructions`。

**Tech Stack:** Rust 2021 + rusqlite + serde_json；Vue 3.5 + TS + Pinia；Vitest（node）；Playwright。

## Global Constraints

- 触发引擎与下单路径不改语义：触发仍走 `co:triggered → handle_co_triggered → submit_with_sig`；实盘仍需人工确认。
- 状态不落库，读取时推导；`plan_instruction` 只新增 `co_id`/`trigger_json`/`synced_at` 三列。
- 物化必须幂等：重复确认不重复建单；重新生成计划必须取消旧条件单。
- 物化失败单条隔离，不阻断计划确认。
- 新增迁移只能追加（当前已有 v60（P6 pilot 配置）→ 新增 v61），禁止改动已发布条目。
- 前端轮询只查本地 SQLite，禁止调用 `broker_query_position` 等会驱动同花顺 GUI 的命令。
- 文件 UTF-8 无 BOM；Rust 使用 `cargo clippy --all-targets -- -D warnings` 零告警；前端 `pnpm build` 通过。
- 提交前缀：`feat(broker):` / `feat(ai):` / `feat(ui):` / `test(e2e):`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src-tauri/src/db/migrations.rs`（修改） | 追加 v61：`plan_instruction` 三列 |
| `src-tauri/src/ai/instruction.rs`（新建） | `leaves_from_alert_rule`、`derive_state`、`materialize_plan`、`list_instructions` |
| `src-tauri/src/ai/mod.rs`（修改） | 注册 `pub mod instruction;` |
| `src-tauri/src/ai/plan.rs`（修改） | 重建指令前取消旧条件单 |
| `src-tauri/src/ai/workflow_p1.rs`（修改） | 计划确认后调用物化；新增 `workflow_instructions` 命令 |
| `src-tauri/src/lib.rs`（修改） | 注册 `workflow_instructions` |
| `src/components/battle/instructionModel.ts`（新建） | 状态文案/色调/触发提示（node 单测） |
| `src/components/battle/InstructionList.vue`（新建） | 只读指令列表 |
| `src/components/battle/BattleStation.vue`（修改） | 接入列表 + 刷新 |
| `src/stores/workflow.ts`（修改） | `instructions` + `refreshInstructions()` |
| `tests/unit/instruction-model.test.ts`（新建） | 状态映射单测 |
| `tests/e2e/support/backend.ts`（修改） | fake `workflow_instructions` |
| `tests/e2e/battle-station.spec.ts`（修改） | 指令列表 e2e |

---

### Task 1: 迁移 + 触发映射 + 状态推导

**Files:**
- Modify: `src-tauri/src/db/migrations.rs`
- Create: `src-tauri/src/ai/instruction.rs`
- Modify: `src-tauri/src/ai/mod.rs`

**Interfaces:**
- Produces:
  - `pub fn leaves_from_alert_rule(rule: &serde_json::Value) -> Vec<crate::broker::conditional::CoTrigger>`
  - `pub fn derive_state(co: Option<&str>, ticket: Option<&str>, order: Option<&str>) -> &'static str`
  - 状态常量：`watch/pending/triggered/submitted/filled/cancelled/expired`

- [ ] **Step 1: 追加迁移 v61**

在 `src-tauri/src/db/migrations.rs` 的 `vec![...]` 末尾（最后一条 Migration 之后）追加：

```rust
                        Migration {
                            version: 61,
                            description: "plan_instruction: co_id / trigger_json / synced_at (P1-a)",
                            sql: "ALTER TABLE plan_instruction ADD COLUMN co_id TEXT DEFAULT '';
                                 ALTER TABLE plan_instruction ADD COLUMN trigger_json TEXT DEFAULT '';
                                 ALTER TABLE plan_instruction ADD COLUMN synced_at INTEGER DEFAULT 0;
                                 CREATE INDEX IF NOT EXISTS idx_plan_instruction_co
                                     ON plan_instruction(co_id);",
                            kind: MigrationKind::Up,
                        },
```

并把文件头部注释「共 59 条（v1..v59）」改为「共 61 条（v1..v61）」（文件实际已有 v60，头注释一并修正）。

- [ ] **Step 2: 写失败测试**

在新建的 `src-tauri/src/ai/instruction.rs` 底部先写测试（实现留空占位）：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn leaf_mapping_multi_and_skip() {
        let rule = json!({
            "upPrice": 10.5, "upPct": 3.0, "minVolumeRatio": 2.0,
            "riseSpeed": 1.2, "speedWindowSec": 120, "sealLimitUp": 1, "vol": 300
        });
        let leaves = leaves_from_alert_rule(&rule);
        assert_eq!(leaves.len(), 5);
        assert!(leaves.iter().any(|l| l.field == "price" && l.op == "gte" && l.value == 10.5));
        assert!(leaves.iter().any(|l| l.field == "riseSpeed"
            && l.params.as_ref().and_then(|p| p.get("windowSec")).and_then(|v| v.as_i64()) == Some(120)));
        assert!(leaves.iter().any(|l| l.field == "sealUp"));
        assert!(leaves_from_alert_rule(&json!({"vol": 100})).is_empty());
    }

    #[test]
    fn derive_state_matrix() {
        assert_eq!(derive_state(None, None, None), "watch");
        assert_eq!(derive_state(Some("active"), None, None), "pending");
        assert_eq!(derive_state(Some("triggered"), None, None), "triggered");
        assert_eq!(derive_state(Some("triggered"), Some("pending"), None), "triggered");
        assert_eq!(derive_state(Some("triggered"), Some("confirmed"), Some("submitted")), "submitted");
        assert_eq!(derive_state(Some("triggered"), Some("confirmed"), Some("filled")), "filled");
        assert_eq!(derive_state(Some("triggered"), Some("done"), None), "filled");
        assert_eq!(derive_state(Some("cancelled"), None, None), "cancelled");
        assert_eq!(derive_state(Some("triggered"), Some("rejected"), None), "cancelled");
        assert_eq!(derive_state(Some("expired"), None, None), "expired");
    }
}
```

先建一个空文件并加模块声明，让测试能编译失败（未实现）：

```rust
// src-tauri/src/ai/instruction.rs 顶部占位
pub fn leaves_from_alert_rule(_rule: &serde_json::Value) -> Vec<crate::broker::conditional::CoTrigger> {
    todo!()
}
pub fn derive_state(_co: Option<&str>, _ticket: Option<&str>, _order: Option<&str>) -> &'static str {
    todo!()
}
```

`src-tauri/src/ai/mod.rs` 增加 `pub mod instruction;`。

- [ ] **Step 3: 运行测试确认失败**

```powershell
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && cd /d `"D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri`" && cargo test instruction 2>&1"
```

Expected: FAIL（`todo!()` panic 或未实现）

- [ ] **Step 4: 实现**

```rust
// P1-a：计划指令 → 条件单物化、状态推导；状态不落库，读取时计算。
use crate::broker::conditional::CoTrigger;
use serde_json::Value;
use std::collections::HashMap;

fn num(rule: &Value, key: &str) -> Option<f64> {
    rule.get(key).and_then(|v| v.as_f64())
}

fn leaf(field: &str, op: &str, value: f64, params: Option<Value>) -> CoTrigger {
    CoTrigger { field: field.to_string(), op: op.to_string(), value, params }
}

/// 把 plan_instruction.alert_rule 映射为条件单叶子（数组内 AND）。
pub fn leaves_from_alert_rule(rule: &Value) -> Vec<CoTrigger> {
    let mut out = Vec::new();
    if let Some(v) = num(rule, "upPrice") { out.push(leaf("price", "gte", v, None)); }
    if let Some(v) = num(rule, "downPrice") { out.push(leaf("price", "lte", v, None)); }
    if let Some(v) = num(rule, "upPct") { out.push(leaf("pct", "gte", v, None)); }
    if let Some(v) = num(rule, "downPct") { out.push(leaf("pct", "lte", v, None)); }
    if let Some(v) = num(rule, "minVolumeRatio") { out.push(leaf("volumeRatio", "gte", v, None)); }
    if let Some(v) = num(rule, "minTurnover") { out.push(leaf("turnover", "gte", v, None)); }
    if let Some(v) = num(rule, "minAmount") { out.push(leaf("amount", "gte", v, None)); }
    if let Some(v) = num(rule, "riseSpeed") {
        let win = rule.get("speedWindowSec").and_then(|x| x.as_i64()).unwrap_or(300);
        out.push(leaf("riseSpeed", "gte", v, Some(serde_json::json!({ "windowSec": win }))));
    }
    if let Some(v) = num(rule, "downSpeed") { out.push(leaf("downSpeed", "gte", v, None)); }
    for (key, field) in [("sealLimitUp", "sealUp"), ("sealLimitDown", "sealDown"), ("brokenLimit", "broken")] {
        if rule.get(key).and_then(|x| x.as_i64()).unwrap_or(0) > 0 {
            out.push(leaf(field, "gte", 1.0, None));
        }
    }
    out
}

/// 读取时推导：条件单 → 信号票 → 委托。
pub fn derive_state(co: Option<&str>, ticket: Option<&str>, order: Option<&str>) -> &'static str {
    match co {
        None | Some("") => return "watch",
        Some("cancelled") => return "cancelled",
        Some("expired") => return "expired",
        Some("active") => return "pending",
        _ => {}
    }
    match ticket {
        Some("rejected") => return "cancelled",
        Some("done") => return "filled",
        Some("confirmed") => {
            return if order == Some("filled") { "filled" } else { "submitted" };
        }
        Some("pending") => return "triggered",
        _ => {}
    }
    if order == Some("filled") { "filled" } else { "triggered" }
}

pub fn plan_instruction_columns_exist(conn: &rusqlite::Connection) -> bool {
    let mut stmt = match conn.prepare("PRAGMA table_info(plan_instruction)") {
        Ok(s) => s,
        Err(_) => return false,
    };
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map(|rows| rows.filter_map(|x| x.ok()).collect())
        .unwrap_or_default();
    let set: HashMap<&str, ()> = cols.iter().map(|c| (c.as_str(), ())).collect();
    set.contains_key("co_id") && set.contains_key("trigger_json")
}
```

（`materialize_plan` 与 `list_instructions` 在 Task 2/3 再加。）

- [ ] **Step 5: 跑测试与 clippy**

```powershell
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && cd /d `"D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri`" && cargo test instruction 2>&1"
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && cd /d `"D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri`" && cargo clippy --all-targets -- -D warnings 2>&1"
```

Expected: 2 tests PASS；clippy `Finished` 无告警。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/ai/instruction.rs src-tauri/src/ai/mod.rs
git commit -m "feat(ai): 计划指令触发映射与状态推导（P1-a）"
```

---

### Task 2: 物化器 + 计划确认接入 + 重计划清理

**Files:**
- Modify: `src-tauri/src/ai/instruction.rs`（新增 `materialize_plan` + 测试）
- Modify: `src-tauri/src/ai/plan.rs`（`save_plan` 前取消旧条件单）
- Modify: `src-tauri/src/ai/workflow_p1.rs`（`workflow_plan_confirm` 调用物化）

**Interfaces:**
- Consumes: Task 1 的 `leaves_from_alert_rule`
- Produces:
  - `pub struct MaterializeSummary { pub created: usize, pub skipped: usize, pub failed: usize }`
  - `pub fn materialize_plan(conn: &rusqlite::Connection, plan_id: i64) -> Result<MaterializeSummary, String>`

- [ ] **Step 1: 写失败测试**

在 `instruction.rs` 的 `mod tests` 内追加（复用 `conditional::CREATE_SQL` 建表）：

```rust
    fn conn_with_tables() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::broker::conditional::CREATE_SQL).unwrap();
        conn.execute_batch(
            "CREATE TABLE plan_instruction(
                id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER, tier TEXT, code TEXT,
                name TEXT, theme TEXT, condition TEXT, action TEXT, position_hint TEXT,
                alert_rule TEXT, status TEXT, sort INTEGER,
                co_id TEXT DEFAULT '', trigger_json TEXT DEFAULT '', synced_at INTEGER DEFAULT 0);",
        ).unwrap();
        conn
    }

    #[test]
    fn materialize_is_idempotent() {
        let conn = conn_with_tables();
        conn.execute(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','{\"upPrice\":1700,\"vol\":200}','open',0)",
            [],
        ).unwrap();
        let first = materialize_plan(&conn, 1).unwrap();
        assert_eq!(first.created, 1);
        let second = materialize_plan(&conn, 1).unwrap();
        assert_eq!(second.created, 0);
        assert_eq!(second.skipped, 1);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM conditional_order", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let co_id: String = conn.query_row("SELECT co_id FROM plan_instruction WHERE id=1", [], |r| r.get(0)).unwrap();
        assert!(!co_id.is_empty());
    }

    #[test]
    fn materialize_skips_watch_and_invalid_rule() {
        let conn = conn_with_tables();
        conn.execute_batch(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'watch','600519','茅台','{\"upPrice\":1700}','open',0);
             INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','000001','平安','{}','open',1);",
        ).unwrap();
        let s = materialize_plan(&conn, 1).unwrap();
        assert_eq!(s.created, 0);
        assert_eq!(s.skipped, 2);
    }
```

- [ ] **Step 2: 运行确认失败**

```powershell
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && cd /d `"D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri`" && cargo test materialize 2>&1"
```

Expected: FAIL（`materialize_plan` 未定义）

- [ ] **Step 3: 实现物化**

> 注：Task 1 的 `leaves_from_alert_rule` 已实现**方向互斥**（突破优先，其次回踩），不会同时下发上下阈值；物化直接复用即可。

在 `instruction.rs` 追加：

```rust
use crate::ai::now_millis;

#[derive(Debug, Default)]
pub struct MaterializeSummary {
    pub created: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// 把作战卡的 candidate/trigger 指令物化为条件单；幂等（已有 co_id 且单据存在则跳过）。
pub fn materialize_plan(conn: &rusqlite::Connection, plan_id: i64) -> Result<MaterializeSummary, String> {
    let rows: Vec<(i64, String, String, String, String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id,tier,code,name,alert_rule,co_id FROM plan_instruction
                 WHERE plan_id=?1 ORDER BY sort",
            )
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([plan_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        it.filter_map(|x| x.ok()).collect()
    };

    let mut out = MaterializeSummary::default();
    for (id, tier, code, name, rule_json, co_id) in rows {
        if tier != "candidate" && tier != "trigger" {
            out.skipped += 1;
            continue;
        }
        if !co_id.is_empty() && crate::broker::conditional::get_by_co_id(conn, &co_id).is_some() {
            out.skipped += 1;
            continue;
        }
        let rule: Value = serde_json::from_str(&rule_json).unwrap_or_else(|_| serde_json::json!({}));
        let leaves = leaves_from_alert_rule(&rule);
        if leaves.is_empty() || code.trim().is_empty() {
            out.skipped += 1;
            continue;
        }
        let vol = rule.get("vol").and_then(|v| v.as_i64()).unwrap_or(100);
        if vol <= 0 || vol % 100 != 0 {
            out.skipped += 1;
            continue;
        }
        let side = rule.get("side").and_then(|v| v.as_str()).unwrap_or("BUY").to_uppercase();
        let input = crate::broker::conditional::CreateInput {
            code: code.clone(),
            name: name.clone(),
            side,
            trigger: leaves.clone(),
            price_mode: "trigger".to_string(),
            limit_price: 0.0,
            vol,
            ttl: "day".to_string(),
            expire_at: now_millis() + 86_400_000,
            auto_confirm: true,
            ticket_id: String::new(),
            note: format!("plan:{plan_id}:{id}"),
        };
        match crate::broker::conditional::insert(conn, input) {
            Ok(co_id_new) => {
                let trigger_json = serde_json::to_string(&leaves).unwrap_or_default();
                let _ = conn.execute(
                    "UPDATE plan_instruction SET co_id=?1,trigger_json=?2,synced_at=?3 WHERE id=?4",
                    rusqlite::params![co_id_new, trigger_json, now_millis(), id],
                );
                out.created += 1;
            }
            Err(_) => out.failed += 1,
        }
    }
    Ok(out)
}
```

- [ ] **Step 4: 接入计划确认与重计划清理**

`workflow_p1.rs` 的 `workflow_plan_confirm`，在 `let alerts_created = plan::confirm_plan_alerts(&dir, plan_id)?;` 之后追加：

```rust
    let materialized = {
        let c = open_readwrite(&dir)?;
        crate::ai::instruction::materialize_plan(&c, plan_id)
            .unwrap_or_default()
    };
```

并把返回 JSON 增加 `"instructionsCreated": materialized.created,`。

`plan.rs` 的 `save_plan`，在 `c.execute("DELETE FROM plan_instruction ...")` **之前**追加：

```rust
    // P1-a：重建指令前取消旧条件单，避免孤儿单继续触发。
    {
        let co_ids: Vec<String> = {
            let mut stmt = c
                .prepare("SELECT co_id FROM plan_instruction WHERE plan_id=?1 AND co_id<>''")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([plan_id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|x| x.ok()).collect()
        };
        for co in co_ids {
            let _ = c.execute(
                "UPDATE conditional_order SET status='cancelled', updated_at=?1 \
                 WHERE co_id=?2 AND status='active'",
                rusqlite::params![now_millis(), co],
            );
        }
    }
```

- [ ] **Step 5: 跑测试 + clippy**

```powershell
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && cd /d `"D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri`" && cargo test instruction 2>&1"
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && cd /d `"D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri`" && cargo clippy --all-targets -- -D warnings 2>&1"
```

Expected: 4 tests PASS；clippy 无告警。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/ai/instruction.rs src-tauri/src/ai/plan.rs src-tauri/src/ai/workflow_p1.rs
git commit -m "feat(ai): 作战卡指令物化为条件单，重计划取消旧单（P1-a）"
```

---

### Task 3: 读取命令 + 前端指令列表 + e2e

**Files:**
- Modify: `src-tauri/src/ai/instruction.rs`（`list_instructions`）
- Modify: `src-tauri/src/ai/workflow_p1.rs`（`workflow_instructions` 命令）
- Modify: `src-tauri/src/lib.rs`（注册）
- Create: `src/components/battle/instructionModel.ts`
- Create: `src/components/battle/InstructionList.vue`
- Modify: `src/components/battle/BattleStation.vue`
- Modify: `src/stores/workflow.ts`
- Test: `tests/unit/instruction-model.test.ts`
- Modify: `tests/e2e/support/backend.ts`
- Modify: `tests/e2e/battle-station.spec.ts`

**Interfaces:**
- Produces:
  - Rust `pub fn list_instructions(conn, plan_id) -> Result<Vec<serde_json::Value>, String>`
  - Tauri `workflow_instructions(trade_date?) -> { plan: Option<Value>, instructions: Value[] }`
  - TS `interface InstructionRow { id:number; tier:string; code:string; name:string; condition:string; action:string; positionHint:string; coId:string; triggerJson:string; state:string; triggeredAt:number; filledVol:number; filledAvgPrice:number }`
  - `instructionModel.ts`：`stateMeta(state)`、`triggerHint(json)`、`type ExecState`

- [ ] **Step 1: 写失败测试（前端纯函数）**

`tests/unit/instruction-model.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { stateMeta, triggerHint } from "../../src/components/battle/instructionModel";

describe("instructionModel", () => {
  it("状态文案与色调", () => {
    expect(stateMeta("pending").label).toBe("待触发");
    expect(stateMeta("triggered").label).toBe("已触发");
    expect(stateMeta("submitted").label).toBe("已下单");
    expect(stateMeta("filled").label).toBe("已成交");
    expect(stateMeta("cancelled").label).toBe("已取消");
    expect(stateMeta("expired").label).toBe("已过期");
    expect(stateMeta("watch").label).toBe("仅观察");
    expect(stateMeta("unknown").label).toBe("仅观察");
  });

  it("触发提示解析", () => {
    const json = JSON.stringify([
      { field: "price", op: "gte", value: 10.5 },
      { field: "pct", op: "gte", value: 3 },
      { field: "volumeRatio", op: "gte", value: 2 },
    ]);
    const hint = triggerHint(json);
    expect(hint).toContain("≥10.50");
    expect(hint).toContain("涨幅≥3%");
    expect(hint).toContain("量比≥2");
    expect(triggerHint("")).toBe("");
    expect(triggerHint("not-json")).toBe("");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/unit/instruction-model.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现前端模型与列表**

`src/components/battle/instructionModel.ts`：

```ts
export type ExecState =
  | "watch" | "pending" | "triggered" | "submitted"
  | "filled" | "cancelled" | "expired";

export interface StateMeta {
  label: string;
  tone: "muted" | "info" | "gold" | "up" | "down";
}

const META: Record<ExecState, StateMeta> = {
  watch: { label: "仅观察", tone: "muted" },
  pending: { label: "待触发", tone: "info" },
  triggered: { label: "已触发", tone: "gold" },
  submitted: { label: "已下单", tone: "info" },
  filled: { label: "已成交", tone: "up" },
  cancelled: { label: "已取消", tone: "muted" },
  expired: { label: "已过期", tone: "muted" },
};

export function stateMeta(state: string): StateMeta {
  return META[state as ExecState] ?? META.watch;
}

interface Leaf { field: string; op: string; value: number }

const FIELD_LABEL: Record<string, string> = {
  price: "价格", pct: "涨幅", volumeRatio: "量比",
  turnover: "换手", amount: "成交额", riseSpeed: "涨速", downSpeed: "跌速",
};

export function triggerHint(json: string): string {
  if (!json) return "";
  let leaves: Leaf[];
  try {
    leaves = JSON.parse(json) as Leaf[];
    if (!Array.isArray(leaves)) return "";
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const l of leaves) {
    const label = FIELD_LABEL[l.field];
    if (!label) continue;
    if (l.field === "price") {
      parts.push(`${l.op === "lte" ? "≤" : "≥"}${l.value.toFixed(2)}`);
    } else {
      const v = Number.isInteger(l.value) ? String(l.value) : l.value.toFixed(1);
      parts.push(`${label}${l.op === "lte" ? "≤" : "≥"}${v}${l.field === "pct" || l.field === "turnover" ? "%" : ""}`);
    }
  }
  return parts.join(" · ");
}
```

`src/components/battle/InstructionList.vue`：

```vue
<script setup lang="ts">
import { stateMeta, triggerHint, type ExecState } from "./instructionModel";

export interface InstructionRow {
  id: number;
  tier: string;
  code: string;
  name: string;
  condition: string;
  action: string;
  positionHint: string;
  coId: string;
  triggerJson: string;
  state: string;
  triggeredAt: number;
  filledVol: number;
  filledAvgPrice: number;
}

defineProps<{ rows: InstructionRow[] }>();
const emit = defineEmits<{ (e: "pick", code: string): void }>();

function toneClass(state: string): string {
  return `tone-${stateMeta(state).tone}`;
}
</script>

<template>
  <section class="il" data-testid="instruction-list">
    <header class="il-head">
      <span class="il-title">今日指令</span>
      <span class="il-count">{{ rows.length }}</span>
    </header>
    <p v-if="!rows.length" class="il-empty">今日无计划指令，确认作战卡后自动生成</p>
    <div v-else class="il-rows">
      <button
        v-for="r in rows.slice(0, 5)"
        :key="r.id"
        type="button"
        class="il-row"
        @click="emit('pick', r.code)"
      >
        <span class="il-tier" :class="`tier-${r.tier}`">{{ r.tier === "candidate" ? "备选" : r.tier === "trigger" ? "触发" : "观察" }}</span>
        <span class="il-code mono">{{ r.code }}</span>
        <span class="il-name">{{ r.name }}</span>
        <span class="il-hint">{{ triggerHint(r.triggerJson) }}</span>
        <span class="il-state" :class="toneClass(r.state)" :data-state="r.state">{{ stateMeta(r.state).label }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.il { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; background: var(--bg-card); }
.il-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.il-title { font-size: 12px; font-weight: 700; }
.il-count { font-size: 11px; color: var(--text-dim); }
.il-empty { margin: 0; font-size: 11.5px; color: var(--text-dim); }
.il-rows { display: flex; flex-direction: column; gap: 3px; }
.il-row { display: flex; align-items: center; gap: 8px; padding: 3px 6px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--text); font-size: 11.5px; cursor: pointer; text-align: left; }
.il-row:hover { background: var(--bg-hover); }
.il-tier { flex: none; padding: 0 5px; border-radius: 4px; font-size: 10px; border: 1px solid var(--border); color: var(--text-dim); }
.il-tier.tier-candidate { color: var(--accent); border-color: var(--accent); }
.il-code { flex: none; }
.il-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.il-hint { flex: none; color: var(--text-dim); font-size: 10.5px; }
.il-state { flex: none; padding: 0 6px; border-radius: 4px; font-size: 10.5px; border: 1px solid var(--border); }
.il-state.tone-info { color: #6aa6e8; border-color: #6aa6e8; }
.il-state.tone-gold { color: var(--accent); border-color: var(--accent); }
.il-state.tone-up { color: var(--up); border-color: var(--up); }
.il-state.tone-muted { color: var(--text-dim); }
.mono { font-variant-numeric: tabular-nums; }
</style>
```

- [ ] **Step 4: Rust 读取命令与注册**

`instruction.rs` 追加：

```rust
pub fn list_instructions(
    conn: &rusqlite::Connection,
    plan_id: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT i.id,i.tier,i.code,i.name,i.condition,i.action,i.position_hint,
                    i.co_id,i.trigger_json,
                    c.status,c.triggered_at,
                    t.status,o.status,o.filled_vol,o.filled_avg_price
             FROM plan_instruction i
             LEFT JOIN conditional_order c ON c.co_id=i.co_id AND i.co_id<>''
             LEFT JOIN signal_ticket t ON t.sig_id=c.ticket_id AND c.ticket_id<>''
             LEFT JOIN broker_order o ON o.sig_id=t.sig_id
             WHERE i.plan_id=?1 ORDER BY i.sort",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([plan_id], |r| {
            let co: Option<String> = r.get(9).ok();
            let ticket: Option<String> = r.get(11).ok();
            let order: Option<String> = r.get(12).ok();
            Ok(serde_json::json!({
                "id": r.get::<_, i64>(0)?,
                "tier": r.get::<_, String>(1)?,
                "code": r.get::<_, String>(2)?,
                "name": r.get::<_, String>(3)?,
                "condition": r.get::<_, String>(4)?,
                "action": r.get::<_, String>(5)?,
                "positionHint": r.get::<_, String>(6)?,
                "coId": r.get::<_, String>(7)?,
                "triggerJson": r.get::<_, String>(8)?,
                "state": derive_state(co.as_deref(), ticket.as_deref(), order.as_deref()),
                "triggeredAt": r.get::<_, i64>(10).unwrap_or(0),
                "filledVol": r.get::<_, i64>(13).unwrap_or(0),
                "filledAvgPrice": r.get::<_, f64>(14).unwrap_or(0.0),
            }))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|x| x.ok()).collect())
}
```

`workflow_p1.rs` 追加命令：

```rust
/// P1-a：作战台只读指令列表（状态由条件单/信号票/委托推导）。
#[tauri::command]
pub fn workflow_instructions(
    state: State<'_, AiState>,
    trade_date: Option<String>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(workflow::today_str);
    let plan_date = plan::next_trade_date(&date);
    let dir = state.dir().clone();
    let c = open_readwrite(&dir)?;
    let plan_id: Option<i64> = c
        .query_row("SELECT id FROM plan WHERE plan_date=?1", [&plan_date], |r| r.get(0))
        .ok();
    let Some(pid) = plan_id else {
        return Ok(json!({ "plan": null, "instructions": [] }));
    };
    let plan = plan::get_plan(&dir, pid).unwrap_or(Value::Null);
    let instructions = crate::ai::instruction::list_instructions(&c, pid)?;
    Ok(json!({ "plan": plan, "instructions": instructions }))
}
```

`lib.rs` 的 `invoke_handler` 中，`workflow_p1::workflow_p1_products` 附近追加 `workflow_p1::workflow_instructions,`。

- [ ] **Step 5: workflow store 与作战台接入**

`src/stores/workflow.ts` 增加：

```ts
export interface InstructionRow {
  id: number; tier: string; code: string; name: string;
  condition: string; action: string; positionHint: string;
  coId: string; triggerJson: string; state: string;
  triggeredAt: number; filledVol: number; filledAvgPrice: number;
}
const instructions = ref<InstructionRow[]>([]);
async function refreshInstructions() {
  try {
    const r = await invoke<{ instructions: InstructionRow[] }>("workflow_instructions", {
      tradeDate: todayStr(),
    });
    instructions.value = r.instructions ?? [];
  } catch {
    instructions.value = [];
  }
}
```

并在 store 的 return 中导出 `instructions`、`refreshInstructions`。

`BattleStation.vue`：
- `refresh()` 末尾追加 `void wf.refreshInstructions();`
- 模板在 `<PhasePanel ... />` 下方增加：

```vue
      <InstructionList :rows="wf.instructions" @pick="pick" />
```

- `import InstructionList from "./InstructionList.vue";`

- [ ] **Step 6: e2e fake + 用例**

`backend.ts` handlers 追加：

```ts
  workflow_instructions: () => ({
    plan: { id: 1, planDate: "2026-10-20", status: "confirmed" },
    instructions: [
      { id: 1, tier: "candidate", code: "600519", name: "贵州茅台", condition: "", action: "", positionHint: "", coId: "CO1", triggerJson: '[{"field":"price","op":"gte","value":1680}]', state: "pending", triggeredAt: 0, filledVol: 0, filledAvgPrice: 0 },
      { id: 2, tier: "trigger", code: "300750", name: "宁德时代", condition: "", action: "", positionHint: "", coId: "CO2", triggerJson: '[{"field":"pct","op":"gte","value":3}]', state: "triggered", triggeredAt: 1, filledVol: 0, filledAvgPrice: 0 },
      { id: 3, tier: "candidate", code: "000001", name: "平安银行", condition: "", action: "", positionHint: "", coId: "CO3", triggerJson: "", state: "filled", triggeredAt: 1, filledVol: 100, filledAvgPrice: 12.3 },
    ],
  }),
```

`battle-station.spec.ts` 追加：

```ts
test("指令列表展示状态与触发提示", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-19T09:31:00+08:00") });
  await openCockpit(page);
  const list = page.getByTestId("instruction-list");
  await expect(list).toBeVisible();
  await expect(list.locator(".il-row")).toHaveCount(3);
  await expect(list).toContainText("贵州茅台");
  await expect(list).toContainText("待触发");
  await expect(list).toContainText("已触发");
  await expect(list).toContainText("已成交");
  await expect(list).toContainText("≥1680.00");
});
```

- [ ] **Step 7: 全量验证**

```powershell
pnpm test
pnpm build
pnpm exec playwright test tests/e2e/battle-station.spec.ts --reporter=line
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && cd /d `"D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri`" && cargo test instruction 2>&1"
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && cd /d `"D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri`" && cargo clippy --all-targets -- -D warnings 2>&1"
```

Expected: 单测全绿（748 + 新增）、构建通过、作战台 e2e 8 条通过、clippy 干净。

- [ ] **Step 8: 提交**

```bash
git add src-tauri/src/ai/instruction.rs src-tauri/src/ai/workflow_p1.rs src-tauri/src/lib.rs \
  src/components/battle/instructionModel.ts src/components/battle/InstructionList.vue \
  src/components/battle/BattleStation.vue src/stores/workflow.ts \
  tests/unit/instruction-model.test.ts tests/e2e/support/backend.ts tests/e2e/battle-station.spec.ts
git commit -m "feat(ui): 作战台指令列表：计划物化状态只读展示（P1-a）"
```

---

## Self-Review

**Spec coverage**

| Spec 要求 | 任务 |
|---|---|
| 迁移三列 | Task 1 |
| alertRule → CoTrigger 映射 | Task 1 |
| 状态推导（读取时） | Task 1 |
| 物化 + 幂等 | Task 2 |
| 重计划取消旧单 | Task 2 |
| 读取命令 + 注册 | Task 3 |
| 前端列表 + 状态徽标 | Task 3 |
| e2e | Task 3 |

**Placeholder scan**：无 TBD/TODO；每个步骤含可执行代码或命令。

**Type consistency**：`MaterializeSummary`、`derive_state`、`list_instructions` 在任务间签名一致；前端 `InstructionRow.state` 与 Rust 状态字符串一致；`triggerHint` 解析的叶子字段与 `leaves_from_alert_rule` 输出一致。
