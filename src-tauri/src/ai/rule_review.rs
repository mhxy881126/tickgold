// 规则降级复盘：当云端 / 本地大模型不可用（无 Key、鉴权失败、网络错误、
// Ollama 未启动）时，仅依据 build_pack 的结构化特征，用确定性规则生成复盘，
// 保证「盘后复盘」闭环不中断。所有产物标注 rule-based，可与大模型版本区分。
use serde_json::{json, Value};

pub struct RuleReview {
    pub title: String,
    pub summary: String,
    pub content: String,
    pub evidence: String,
}

fn gi(v: &Value, k: &str) -> i64 {
    v[k].as_i64().unwrap_or(0)
}
fn gf(v: &Value, k: &str) -> f64 {
    v[k].as_f64().unwrap_or(0.0)
}
fn gs<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

/// 情绪定调：涨停数 + 炸板率 + 最高板。
fn mood(lu: i64, broken_rate: f64, max_boards: i64) -> (&'static str, &'static str) {
    if lu >= 60 && broken_rate < 25.0 && max_boards >= 5 {
        ("亢奋", "赚钱效应强，连板梯队完整，可积极参与主线龙头")
    } else if lu >= 35 && broken_rate < 40.0 {
        ("偏暖", "存在结构性机会，围绕主线低吸或打确认板")
    } else if lu >= 15 {
        ("中性", "情绪一般、分化明显，控制仓位、快进快出")
    } else {
        ("冰点", "赚钱效应差、亏钱效应扩散，以防守为主、少开新仓")
    }
}

fn market_review(focus: &Value) -> RuleReview {
    let m = &focus["market"];
    let lu = gi(m, "limitUp");
    let ld = gi(m, "limitDown");
    let broken = gi(m, "broken");
    let broken_rate = gf(m, "brokenRate");
    let max_b = gi(m, "maxBoards");
    let avg_b = gf(m, "avgBoards");
    let first_b = gi(m, "firstBoardCount");
    let multi_b = gi(m, "multiBoardCount");
    let up = gi(m, "upCount");
    let down = gi(m, "downCount");
    let (mood_name, mood_advice) = mood(lu, broken_rate, max_b);

    // 指数表现
    let mut idx_txt = String::new();
    if let Some(arr) = focus["indices"].as_array() {
        for ix in arr {
            let name = gs(ix, "name");
            let pct = gf(ix, "pct");
            if !name.is_empty() {
                idx_txt.push_str(&format!("· {} {:+.2}%\n", name, pct));
            }
        }
    }
    // 领涨板块
    let mut sec_txt = String::new();
    for key in ["topIndustryUp", "topConceptUp"] {
        if let Some(arr) = focus[key].as_array() {
            for s in arr.iter().take(5) {
                let name = gs(s, "name");
                let pct = gf(s, "changePct");
                if !name.is_empty() {
                    sec_txt.push_str(&format!("· {} {:+.2}%　", name, pct));
                }
            }
            if !sec_txt.is_empty() {
                sec_txt.push('\n');
            }
        }
    }

    let title = format!("市场复盘 · 情绪{}（规则生成）", mood_name);
    let summary = format!(
        "涨停{} / 跌停{} / 炸板{}（炸板率{:.0}%），最高{}板、平均{:.1}板；情绪{}。{}",
        lu, ld, broken, broken_rate, max_b, avg_b, mood_name, mood_advice
    );
    let content = format!(
        "【情绪定调】{}\n{}\n\n【涨跌结构】上涨{} / 下跌{}，首板{}，连板{}，炸板{}，炸板率{:.0}%。\n\n【指数表现】\n{}\n【领涨方向】\n{}\n【次日策略】{}\n\n（本复盘由规则引擎在大模型不可用时生成，仅整理当日结构化数据，不构成投资建议）",
        mood_name, mood_advice, up, down, first_b, multi_b, broken, broken_rate,
        if idx_txt.is_empty() { "当日指数数据缺失。\n" } else { &idx_txt },
        if sec_txt.is_empty() { "板块数据缺失。\n" } else { &sec_txt },
        mood_advice
    );
    RuleReview { title, summary, content, evidence: focus.to_string() }
}

fn theme_review(focus: &Value) -> RuleReview {
    let t = &focus["theme"];
    let name = gs(t, "name");
    let level = gs(t, "level");
    let stage = gs(t, "stage");
    let members = gi(t, "members");
    let leaders = t["leaders"].as_array().cloned().unwrap_or_default();
    let recent = gs(t, "recentCatalyst");

    let mut lead_txt = String::new();
    for l in leaders.iter().take(5) {
        let ln = gs(l, "name");
        let pct = gf(l, "leadPct");
        if !ln.is_empty() {
            lead_txt.push_str(&format!("· {} {:+.2}%\n", ln, pct));
        }
    }
    // 催化事件
    let mut cat_txt = String::new();
    if let Some(arr) = focus["recentCatalysts"].as_array() {
        for c in arr.iter().take(5) {
            let title = gs(c, "title");
            if !title.is_empty() {
                cat_txt.push_str(&format!("· {}\n", title));
            }
        }
    }

    let sustain = if !recent.is_empty() || !cat_txt.is_empty() {
        "有新增催化，题材仍在发酵，关注龙头能否继续带队"
    } else if members >= 3 {
        "板块有一定梯队但无新增催化，进入分歧 / 兑现期，谨慎接力"
    } else {
        "成员少且无催化，题材偏弱，不建议追高"
    };

    let title = format!("题材复盘 · {}（规则生成）", name);
    let summary = format!("「{}」阶段：{} / {}，成员{}只；{}", name, stage, level, members, sustain);
    let content = format!(
        "【题材】{}　阶段：{}　强度：{}　成员：{}只\n\n【龙头梯队】\n{}\n【催化事件】{}\n{}\n【持续性判断】{}\n\n（规则引擎生成，不构成投资建议）",
        name, stage, level, members,
        if lead_txt.is_empty() { "未识别到明确龙头。\n" } else { &lead_txt },
        if recent.is_empty() { "" } else { recent },
        if cat_txt.is_empty() { "近期无新增催化记录。\n" } else { &cat_txt },
        sustain
    );
    RuleReview { title, summary, content, evidence: focus.to_string() }
}

fn trade_review(focus: &Value) -> RuleReview {
    let logs = focus["todayDecisionLogs"].as_array().cloned().unwrap_or_default();
    let positions = focus["positions"].as_array().cloned().unwrap_or_default();
    let plan_exists = focus["todayPlan"]["exists"].as_bool().unwrap_or(false);

    let buys = logs.iter().filter(|l| gs(l, "label") == "BUY" || gs(l, "action") == "buy").count();
    let sells = logs.iter().filter(|l| gs(l, "label") == "SELL" || gs(l, "action") == "sell").count();

    let mut pos_txt = String::new();
    for p in positions.iter().take(8) {
        pos_txt.push_str(&format!(
            "· {}({}) 持仓{}股\n",
            gs(p, "name"), gs(p, "code"), gi(p, "vol")
        ));
    }

    let deviation = if !plan_exists {
        "当日无作战计划，交易属于临场发挥，建议盘前先生成计划以约束操作"
    } else if buys > 3 {
        "当日买入次数偏多，存在频繁出手，应严格按计划信号、减少冲动交易"
    } else if sells == 0 && !positions.is_empty() {
        "只买未卖，需检查止损止盈是否执行，避免弱势仓位拖延"
    } else {
        "交易节奏基本可控，继续对照计划核对每笔进出理由"
    };

    let title = "交易复盘 · 计划与执行偏差（规则生成）".to_string();
    let summary = format!("当日决策{}条：买入{}次 / 卖出{}次，持仓{}只；{}", logs.len(), buys, sells, positions.len(), deviation);
    let content = format!(
        "【计划】{}\n【决策统计】共{}条，买入{}次，卖出{}次。\n\n【当前持仓】\n{}\n【偏差与改进】{}\n\n（规则引擎生成，不构成投资建议）",
        if plan_exists { "当日有作战计划" } else { "当日无作战计划" },
        logs.len(), buys, sells,
        if pos_txt.is_empty() { "空仓。\n" } else { &pos_txt },
        deviation
    );
    RuleReview { title, summary, content, evidence: focus.to_string() }
}

fn stock_review(focus: &Value) -> RuleReview {
    let code = gs(focus, "code");
    let lu = &focus["limitUp"];
    let pos = &focus["position"];
    let has_lu = !lu.is_null();
    let has_pos = !pos.is_null();

    let boards = gi(lu, "boards");
    let seal_fund = gf(lu, "sealFund");
    let broken = gi(lu, "broken");
    let industry = gs(lu, "industry");
    let vol = gi(pos, "vol");

    let mut head = String::new();
    if has_lu {
        head.push_str(&format!(
            "涨停结构：{}板，封单资金{:.0}万，炸板{}次，所属「{}」。\n",
            boards, seal_fund, broken, if industry.is_empty() { "未知" } else { industry }
        ));
    }
    if has_pos {
        head.push_str(&format!("当前持仓{}股，需结合现价对照成本评估盈亏。\n", vol));
    }

    let advice = if has_lu && broken >= 2 {
        "反复炸板、封板不牢，次日冲高以兑现 / 减仓为主"
    } else if has_lu && boards >= 3 {
        "高标龙头，关注次日竞价强弱与板块梯队，断板走弱即离场"
    } else if has_lu {
        "低位板，观察能否晋级，跌破封板价 / 止损线离场"
    } else if has_pos {
        "无涨停结构的持仓，按既定止损止盈纪律处理，不与弱势股纠缠"
    } else {
        "信息不足，暂不判断"
    };

    let title = format!("个股复盘 · {}（规则生成）", code);
    let summary = format!("{}：{}", code, advice);
    let content = format!(
        "【个股】{}\n{}\n【操作建议】{}\n\n（规则引擎生成，不构成投资建议）",
        code,
        if head.is_empty() { "个股行情 / 持仓数据缺失。\n" } else { &head },
        advice
    );
    RuleReview { title, summary, content, evidence: focus.to_string() }
}

/// 按 scope 生成规则复盘。
pub fn rule_review(scope: &str, subject: &str, focus: &Value) -> RuleReview {
    match scope {
        "theme" => theme_review(focus),
        "trade" => trade_review(focus),
        "stock" => stock_review(focus),
        _ => market_review(focus),
    }
}

/// 规则降级作战计划：输出与大模型计划同构的 JSON（title/marketView/instructions）。
pub fn rule_plan(pack: &Value, plan_date: &str) -> Value {
    let m = &pack["market"];
    let lu = gi(m, "limitUp");
    let broken_rate = gf(m, "brokenRate");
    let max_b = gi(m, "maxBoards");
    let (mood_name, advice) = mood(lu, broken_rate, max_b);
    let total_cap = match mood_name {
        "亢奋" => "≤80%",
        "偏暖" => "≤60%",
        "中性" => "≤40%",
        _ => "≤20%",
    };
    let market_view = format!(
        "情绪{}（涨停{}、炸板率{:.0}%、最高{}板）。{} 次日总仓位{}。\n（本计划由规则引擎在大模型不可用时生成，仅基于当日结构化数据，不构成投资建议）",
        mood_name, lu, broken_rate, max_b, advice, total_cap
    );

    let mut ins: Vec<Value> = vec![];

    // ① 存量持仓：止损止盈 trigger（最高优先级）
    if let Some(arr) = pack["positions"].as_array() {
        for p in arr {
            let code = gs(p, "code");
            let name = gs(p, "name");
            if code.is_empty() {
                continue;
            }
            ins.push(json!({
                "tier": "trigger", "code": code, "name": name, "theme": "",
                "condition": "跌破止损线（-7%）或断板走弱即离场；冲高 +8~10% 分批止盈",
                "action": "按止损止盈纪律执行，不与弱势仓位拖延",
                "positionHint": "存量持仓",
                "alertRule": {"upPrice": null, "downPrice": null, "upPct": 8, "downPct": -7, "riseSpeed": null}
            }));
        }
    }

    // ② 连板股：高板候选、低板观察
    if let Some(arr) = pack["multiBoardStocks"].as_array() {
        for s in arr.iter().take(6) {
            let code = gs(s, "code");
            if code.is_empty() {
                continue;
            }
            let boards = gi(s, "boards");
            let industry = gs(s, "industry");
            let high = boards >= 3;
            ins.push(json!({
                "tier": if high { "candidate" } else { "watch" },
                "code": code, "name": gs(s, "name"), "theme": industry,
                "condition": if high {
                    "次日竞价强势 / 放量换手回封确认后再参与，断板或低开走弱放弃"
                } else {
                    "观察能否晋级，不追高、不接无量一字"
                },
                "action": if high { "满足确认条件小仓试错 / 打板" } else { "仅观察" },
                "positionHint": if high { "10-15%" } else { "0（观察）" },
                "alertRule": {"upPrice": null, "downPrice": null, "upPct": 5, "downPct": -5, "riseSpeed": null}
            }));
        }
    }

    // ③ 主线题材：观察
    if let Some(arr) = pack["activeThemes"].as_array() {
        for t in arr.iter().take(3) {
            let name = gs(t, "name");
            if name.is_empty() {
                continue;
            }
            ins.push(json!({
                "tier": "watch", "code": "", "name": name, "theme": name,
                "condition": "关注题材龙头竞价强弱与新增催化，发酵则跟踪，分歧则回避",
                "action": "仅观察，不直接出手",
                "positionHint": "0（观察）",
                "alertRule": {"upPrice": null, "downPrice": null, "upPct": null, "downPct": null, "riseSpeed": null}
            }));
        }
    }

    json!({
        "title": format!("{} 作战计划（规则生成）", plan_date),
        "marketView": market_view,
        "instructions": ins
    })
}
