# TickGold

<img src="branding/tickgold-logo-2048.png" alt="TickGold logo" width="96" />

> 为「交易者盯盘」而生的跨平台 A 股桌面终端。比传统交易软件更轻、更快、更专注盘中。
> **Tauri 2.0（Rust）+ Vue 3 + TypeScript + Pinia + ECharts**，一套代码同时发布 Windows 与 macOS（Apple Silicon / Intel）。

[![release](https://img.shields.io/github/v/release/mhxy881126/tickgold)](https://github.com/mhxy881126/tickgold/releases)
[![license](https://img.shields.io/github/license/mhxy881126/tickgold)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)]()

---

## 特性一览

**卡片化动画工作台**
- 所有功能模块都是可自由开关的「卡片」：左导航一键打开 / 关闭
- 打开缩放模糊→清晰、关闭缩小淡出、卡片间 FLIP 平滑让位
- 多套模式预设（盯盘 / 选股 / 全功能 / 纯图表）一键切换

**全市场榜单（覆盖沪深京 5000+ 只）**
- 涨幅 / 跌幅 / 成交额榜单，**滚动到底自动加载下一页**，可一直加载到全部股票
- 每行最新价、涨跌幅、成交额，hover 可一键加入自选，点击联动 K 线 / 盘口

**市场宽度（涨跌分布）**
- 涨跌家数分时：上涨 / 下跌家数随交易分钟实时曲线，盘中赚钱效应一目了然
- 涨跌分布直方图：涨跌幅 10 档（≥7% 至 ≤-7%）家数，红涨绿跌、深色为高弹性
- 顶部实时统计上涨 / 下跌 / 平盘、涨停 / 跌停 / 炸板家数与炸板率

**K 线 / 分时（ECharts）**
- 日 / 周 / 月 K：红涨绿跌蜡烛 + MA5/10/20 + 成交量副图 + dataZoom
- 当日分时图、周期切换、十字光标、自适应缩放

**五档盘口 · 资金流向 · 板块行情**
- 五档买卖盘 + 今日概览（开 / 高 / 低 / 量 / 额）
- 个股资金流向：主力 / 散户净流入、特大 / 大 / 中 / 小单四档，实时轮询
- 板块行情：申万行业 / 概念板块，按涨幅 / 净流入排序，领涨股点击联动

**条件选股 / 智能选股器**
- 技术形态：均线多头、MACD 金叉、放量上涨、突破新高、站上 20 日线
- 行情 / 基本面区间：价格、涨跌幅、换手率、量比、振幅、PE、PB、流通市值
- 6 套一键预设（均线多头 / MACD 金叉 / 放量突破 / 当日强势 / 低估值 / 大盘蓝筹），结果点选联动

**涨停雷达（连板 / 炸板 / 市场情绪）**
- 全市场扫描（沪深京 5000+），实时统计涨停 / 跌停 / 炸板家数、炸板率与上涨 / 下跌家数
- 连板梯队：按板高自动分组，日 K 判定连板高度，一眼锁定最高标
- 市场情绪温度（冰点 / 低迷 / 中性 / 活跃 / 亢奋）仪表盘，量化盘面赚钱效应

**板块资金热力图 · 板块异动看板**
- 板块热力图（treemap 矩形树图）：矩形面积 = 板块成交规模（可切换 |净流入|），颜色 = 涨跌幅，红涨绿跌、深浅按幅度
- 行业 / 概念切换、定时刷新，点击板块联动领涨股
- 板块异动看板：定时快照 diff，捕捉板块拉升 / 跳水（≥ 0.5 个百分点）、资金抢筹 / 出逃（≥ 0.5 亿），支持类型筛选 / 暂停 / 清空

**短线精灵 / 异动实时流**
- 实时监控活跃股池（自选 + 涨幅 / 成交额榜单，约 200 只，股池自动滚动更新）
- 异动类型：快速拉升 / 快速下跌、封涨停板 / 涨停打开、封跌停板 / 跌停打开、大单买入 / 大单卖出、量比放大
- 事件流实时推送，支持类型筛选、暂停 / 清空，点击联动 K 线 / 盘口；非交易时段自动待机

**灵动岛悬浮窗（金色奢华）**
- 右上角无边框置顶圆角胶囊，自动轮播自选股行情，脉冲提醒
- 点击展开「智能异动提醒」列表，再次点击标题栏收起；点股联动主窗口

**其他**
- 老板键 `Alt + ` ` 一键隐藏 / 恢复全部窗口
- 系统托盘常驻；SQLite 本地持久化（自选分组、行情、预警）
- 多数据源容灾（腾讯 / 新浪 / 东财），单源超时 / 异常自动切换 + 熔断
- 内置自动更新：更新对话框显示版本对比 / 更新说明 / 下载进度（百分比、MB、速度）；检查通道镜像优先、多源并行竞速（秒级返回），下载包经签名校验，失败可重试或一键手动下载

---

## 下载安装

到 [**Releases**](https://github.com/mhxy881126/tickgold/releases/latest) 下载对应平台安装包：

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | `TickGold_<版本>_x64-setup.exe`（图形化向导，支持自定义安装路径） |
| macOS Apple Silicon (M 系列) | `TickGold_<版本>_aarch64.dmg` |
| macOS Intel | `TickGold_<版本>_x64.dmg` |

> **Windows SmartScreen**：安装包暂未做代码签名，首次双击可能提示风险，选择「更多信息 → 仍要运行」即可。
> **macOS Gatekeeper**：未公证，首次打开请右键 app →「打开」一次。

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 应用壳 / 后端 | Tauri 2.0、Rust（行情聚合、指标计算、命令、窗口、托盘、自动更新） |
| 前端 | Vue 3 + TypeScript + Vite + Pinia |
| 图表 | Apache ECharts（K 线 / 分时 / 资金 / 板块） |
| 持久化 | SQLite（tauri-plugin-sql，内置迁移） |
| 数据源 | 腾讯 `qt.gtimg.cn` / `web.ifzq.gtimg.cn`、新浪 `hq.sinajs.cn` / `vip.stock.finance.sina.com.cn`、东方财富（容灾） |

---

## 从源码开发

环境要求：Node.js 22+、pnpm 10、Rust（stable）、VS Build Tools（Windows，含 C++ 桌面开发）。

```bash
pnpm install
pnpm tauri dev        # 启动开发模式（Vite 热更新 + Rust 后端）
```

仅验证前端：

```bash
pnpm build            # vue-tsc 类型检查 + vite 构建
```

验证 Rust release（`cargo check` 会被 Tauri build script 拦截，请用）：

```bash
pnpm tauri build --no-bundle
```

---

## 发版与持续集成（全自动）

仓库内置 `.github/workflows/release.yml`，**推送版本标签即自动发版**：

```bash
# 1. 同步版本号：src-tauri/tauri.conf.json 与 package.json
# 2. 提交并打标签
git add -A && git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

CI 会：

1. 在 `windows-latest`（NSIS）与 `macos-latest`（aarch64 原生 + x86_64 交叉编译）并行打包、minisign 签名；
2. `publish` 汇总 job 自动生成 Tauri updater 需要的 `latest.json`（扁平 `platforms.<目标>.{url,signature}`）；
3. 产物汇总到同一个草稿 Release，确认后发布即生效，客户端可在线升级。

> 发版前需在仓库 Settings → Secrets and variables → Actions 配置：
> `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

---

## Roadmap

- [x] 短线精灵 / 异动实时流（快速拉升 / 涨跌停 / 大单 / 量比）
- [x] 涨停雷达（连板 / 炸板 / 情绪统计）
- [x] 板块资金热力图、板块异动看板
- [x] 市场宽度（涨跌家数分时、涨跌分布）
- [ ] 预警管理卡片
- [ ] F10 公司资料、财务分析、筹码分布
- [ ] 预警管理卡片、模拟交易、盯盘日记、财经日历
- [ ] 卡片拖拽换位 + 自定义布局保存、画线工具、投资计算器、数据导出
- [ ] Windows Authenticode / macOS 公证（消除安全提示）

详见 [`功能扩展规划·卡片化版.md`](功能扩展规划·卡片化版.md)。

---

## 免责声明

行情数据来自公开免费接口，仅供学习与个人盯盘参考，不保证实时性与准确性，**不构成任何投资建议**。本项目不提供、也无法提供真实委托下单（需券商资质），仅可用于模拟交易。

## License

[MIT](LICENSE)
