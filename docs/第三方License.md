# 第三方开源 License

本页列出 TickGold 直接依赖的第三方开源组件及其协议，用于开源合规说明。TickGold 自身代码以 [MIT 协议](../LICENSE)发布，在此感谢所有开源项目。

> 标注 **MIT / Apache-2.0** 的组件采用双协议，使用者可任选其一。

## 一、前端运行时依赖（npm）

| 组件 | 协议 | 用途 |
| --- | --- | --- |
| [@tauri-apps/api](https://github.com/tauri-apps/tauri) | MIT / Apache-2.0 | Tauri 运行时 API |
| @tauri-apps/plugin-autostart | MIT / Apache-2.0 | 开机自动启动 |
| @tauri-apps/plugin-global-shortcut | MIT / Apache-2.0 | 全局快捷键（老板键） |
| @tauri-apps/plugin-notification | MIT / Apache-2.0 | 系统通知 |
| @tauri-apps/plugin-opener | MIT / Apache-2.0 | 打开链接 / 路径 |
| @tauri-apps/plugin-process | MIT / Apache-2.0 | 进程控制与重启 |
| @tauri-apps/plugin-shell | MIT / Apache-2.0 | 外部命令 / shell |
| @tauri-apps/plugin-sql | MIT / Apache-2.0 | SQLite 数据库访问 |
| @tauri-apps/plugin-store | MIT / Apache-2.0 | 键值存储 |
| @tauri-apps/plugin-updater | MIT / Apache-2.0 | 内置自动更新 |
| [babel-runtime](https://github.com/babel/babel) | MIT | JS 运行时 polyfill |
| [ECharts](https://github.com/apache/echarts) | Apache-2.0 | 通用图表 |
| [HQChart](https://github.com/jones2000/HQChart) | Apache-2.0 | 行情图表（历史依赖） |
| [jQuery](https://github.com/jquery/jquery) | MIT | DOM 工具（HQChart 依赖） |
| [KLineChart](https://github.com/klinecharts/KLineChart) | Apache-2.0 | K 线 / 分时主图表 |
| [Pinia](https://github.com/vuejs/pinia) | MIT | 状态管理 |
| [Vue](https://github.com/vuejs/core) | MIT | 前端框架 |

## 二、前端构建依赖（devDependencies）

| 组件 | 协议 | 用途 |
| --- | --- | --- |
| @tauri-apps/cli | MIT / Apache-2.0 | Tauri 命令行工具 |
| [@vitejs/plugin-vue](https://github.com/vitejs/vite-plugin-vue) | MIT | Vite 的 Vue 插件 |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | 类型系统 / 编译器 |
| [Vite](https://github.com/vitejs/vite) | MIT | 前端构建工具 |
| [vue-tsc](https://github.com/vuejs/language-tools) | MIT | Vue 类型检查 |

## 三、Rust 后端依赖（crates.io）

| Crate | 协议 | 用途 |
| --- | --- | --- |
| [tauri](https://github.com/tauri-apps/tauri) / tauri-build | MIT / Apache-2.0 | 桌面应用框架 / 构建脚本 |
| tauri-plugin-notification | MIT / Apache-2.0 | 系统通知 |
| tauri-plugin-updater | MIT / Apache-2.0 | 自动更新 |
| tauri-plugin-process | MIT / Apache-2.0 | 进程管理 |
| tauri-plugin-global-shortcut | MIT / Apache-2.0 | 全局快捷键 |
| tauri-plugin-sql | MIT / Apache-2.0 | SQLite 插件 |
| tauri-plugin-shell | MIT / Apache-2.0 | Shell 插件 |
| tauri-plugin-opener | MIT / Apache-2.0 | 打开外部资源 |
| tauri-plugin-autostart | MIT / Apache-2.0 | 开机自启 |
| [serde](https://github.com/serde-rs/serde) / serde_json | MIT / Apache-2.0 | 序列化 |
| [reqwest](https://github.com/seanmonstar/reqwest) | MIT / Apache-2.0 | HTTP 客户端 |
| [tokio](https://github.com/tokio-rs/tokio) | MIT | 异步运行时 |
| [encoding_rs](https://github.com/hsivonen/encoding_rs) | MIT / Apache-2.0 | 字符编码（GBK 解码） |
| [scraper](https://github.com/causal-agent/scraper) | MIT / Apache-2.0 | HTML 解析 |
| [aes](https://github.com/RustCrypto/block-ciphers) / cbc | MIT / Apache-2.0 | AES-CBC（巨潮 mcode 签名） |
| [base64](https://github.com/marshallpierce/rust-base64) | MIT / Apache-2.0 | Base64 编解码 |
| [rfd](https://github.com/PolyMeilex/rfd) | MIT | 原生文件保存对话框 |
| [log](https://github.com/rust-lang/log) | MIT / Apache-2.0 | 日志门面 |

## 四、字体与其他素材

- 界面使用系统自带字体（PingFang SC / Microsoft YaHei / Segoe UI），字体随操作系统授权，**不随安装包分发**；
- 应用图标与界面素材为本项目原创；
- 行情数据的版权归数据厂商所有，详见[数据源说明](数据源说明.md)。

## 五、生成完整依赖清单

上表为**直接依赖**。完整的传递依赖（数量较多）可用以下工具在本地生成、随版本核对：

- **Rust 依赖**
  ```bash
  cargo install cargo-about
  cargo about generate about.hbs > docs/about.html
  # 或快速查看协议汇总
  cargo install cargo-license
  cargo license
  ```
- **前端依赖**
  ```bash
  pnpm licenses list
  # 或
  pnpm dlx license-checker --summary
  ```

各依赖的完整许可证文本位于其源码仓库或发布包中。如发现本页信息与实际不符，请以各依赖官方仓库的 LICENSE 为准并提交 issue 纠正。
