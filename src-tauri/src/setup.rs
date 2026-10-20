// 应用启动装配（v2.27 巨石拆分：从 lib.rs 抽出）。
// init 即原 Builder::setup 闭包体：快捷键、边车库、券商/插件初始化、代理、主窗口、托盘。
use crate::ai;
use crate::broker;
use crate::plugin;
use crate::proxy;
use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder,
};

/// 老板键隐藏状态。
pub(crate) struct BossHidden(pub(crate) Mutex<bool>);

pub(crate) const APP_BROWSER_LABEL: &str = "app-browser";

/// 在内置浏览器窗口打开外部 URL；窗口已存在则复用并导航到新地址，绝不拉起外部浏览器。
/// webview 顶层直接加载外链，而非 iframe：新浪财经等站点通过 X-Frame-Options /
/// CSP frame-ancestors 禁止被 iframe 嵌入（表现为白屏），顶层导航不受此限制。
pub(crate) fn open_app_browser(app: &tauri::AppHandle, url: &url::Url) {
    if url.scheme() != "http" && url.scheme() != "https" {
        return;
    }
    let title = url.host_str().unwrap_or("网页浏览").to_string();
    let url_str = url.to_string();
    if let Some(win) = app.get_webview_window(APP_BROWSER_LABEL) {
        // 单例复用：让 webview 自身导航（eval 执行脚本不受跨源限制）
        let escaped = url_str.replace('\\', "\\\\").replace('\'', "\\'");
        let _ = win.eval(format!("window.location.replace('{escaped}')"));
        if !title.is_empty() {
            let _ = win.set_title(&title);
        }
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    // 新建窗口：webview 直接加载外链
    let browser_handle = app.clone();
    let mut builder =
        WebviewWindowBuilder::new(app, APP_BROWSER_LABEL, WebviewUrl::External(url.clone()))
            .title(title)
            .inner_size(1100.0, 780.0)
            .min_inner_size(720.0, 520.0)
            .resizable(true)
            .on_new_window(move |u, _features| {
                // 页面内 target=_blank / window.open：复用同一内置浏览器窗口导航
                open_app_browser(&browser_handle, &u);
                tauri::webview::NewWindowResponse::Deny
            })
            .on_document_title_changed(|w, t| {
                if !t.is_empty() {
                    let _ = w.set_title(&t);
                }
            });
    // WebView2 自身网络在本机被安全软件拦截（白屏），强制其走 Rust 端本地代理出站；
    // 代理 CONNECT 隧道从 tickgold 进程直接发起 TCP，与 reqwest 同一通道（已验证可用）。
    if let Some(proxy_port) = app
        .try_state::<std::sync::Mutex<Option<u16>>>()
        .and_then(|s| s.lock().ok().and_then(|g| *g))
    {
        let args = format!("--proxy-server=127.0.0.1:{proxy_port} --disable-quic");
        builder = builder.additional_browser_args(&args);
    }
    if let Err(e) = builder.build() {
        log::warn!("内置浏览器窗口创建失败: {e}");
    }
}

/// 手动创建主窗口（替代 tauri.conf.json 的静态窗口声明），
/// 以便挂载 on_new_window：页面 target=_blank / window.open 的外链
/// 一律改在内置浏览器窗口打开，拒绝系统默认外部浏览器弹窗。
pub(crate) fn build_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let handler = app.clone();
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("TickGold")
        .inner_size(1280.0, 800.0)
        .min_inner_size(960.0, 600.0)
        .resizable(true)
        .fullscreen(false)
        .on_new_window(move |url, _features| {
            // http(s) 外链 → 内置浏览器窗口；其余弹窗（about:blank 等）一并拒绝
            open_app_browser(&handler, &url);
            tauri::webview::NewWindowResponse::Deny
        });
    // macOS：隐藏原生标题栏背景、红绿灯内嵌（与原 tauri.conf.json 配置保持一致）
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(false)
        .transparent(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    builder.build()
}

/// 前端统一入口：在内置浏览器窗口打开外链（卡片、AI 回复、更新等全部走这里）。
#[tauri::command]
pub(crate) fn open_in_app_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let u = url::Url::parse(url.trim()).map_err(|e| format!("非法 URL: {e}"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("仅支持 http/https 外链".to_string());
    }
    open_app_browser(&app, &u);
    Ok(())
}

/// 老板键：切换所有窗口显隐
pub(crate) fn boss_toggle(app: &tauri::AppHandle) {
    let state = app.state::<BossHidden>();
    let mut hidden = state.0.lock().unwrap();
    *hidden = !*hidden;
    let now_hidden = *hidden;
    drop(hidden);

    for (_, w) in app.webview_windows() {
        if now_hidden {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

/// 信号确认快捷键（Alt+S）：显示并聚焦主窗口，通知前端打开「信号确认桥」。
pub(crate) fn bridge_focus(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    let _ = app.emit("bridge:focus", ());
}

/// 切换指定窗口显隐，并把对应托盘勾选项与窗口实际可见性对齐
pub(crate) fn toggle_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    check: &CheckMenuItem<R>,
) {
    let Some(w) = app.get_webview_window(label) else {
        return;
    };
    let vis = w.is_visible().unwrap_or(false);
    if vis {
        let _ = w.hide();
    } else {
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = check.set_checked(!vis);
}

/// Builder::setup 回调（原内联闭包体，行为不变）。
pub(crate) fn init(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // ===== 全局快捷键（v2.12.1 容错化）：老板键 Alt+` / 唤起桥 Alt+S
    // 注册失败（如被其他程序占用）仅告警不阻断启动，避免插件初始化 panic 拖垮整个应用 =====
    {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutEvent, ShortcutState};
        let gsc = app.global_shortcut();
        if let Err(e) = gsc.on_shortcut("Alt+`", |app, _sc, event: ShortcutEvent| {
            if event.state() == ShortcutState::Pressed {
                boss_toggle(app);
            }
        }) {
            log::warn!("全局快捷键 Alt+` 注册失败（可能被其他程序占用，老板键不可用）: {e}");
        }
        if let Err(e) = gsc.on_shortcut("Alt+S", |app, _sc, event: ShortcutEvent| {
            if event.state() == ShortcutState::Pressed {
                bridge_focus(app);
            }
        }) {
            log::warn!("全局快捷键 Alt+S 注册失败（信号确认桥唤起键不可用）: {e}");
        }
        // v3.0.0-rc 一键急停：Ctrl+Alt+K，零确认立即全撤；被占用仅 warn。
        if let Err(e) = gsc.on_shortcut("Ctrl+Alt+K", |app, _sc, event: ShortcutEvent| {
            if event.state() == ShortcutState::Pressed {
                let h = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = broker::emergency_halt(&h).await {
                        log::error!("快捷键急停执行失败: {e}");
                    }
                });
            }
        }) {
            log::warn!("全局快捷键 Ctrl+Alt+K 注册失败（一键急停快捷键不可用）: {e}");
        }
    }
    // ===== v1.9 AI 边车库初始化 + data_dir 状态就位 =====
    {
        let dir = app.path().app_data_dir()?;
        let ai_path = dir.join("ai.db");
        match ai::vectordb::open(&ai_path) {
            Ok(_db) => log::info!("AI 边车库就绪: {}", ai_path.display()),
            Err(e) => log::error!("AI 边车库初始化失败（AI 功能不可用）: {e}"),
        }
        // brief 原写法 `*.inner().0.lock()...` 跨模块访问私有字段触发 E0616，改用 set_dir。
        app.state::<ai::AiState>().inner().set_dir(dir.clone());

        // ===== v2.6 券商 / 插件：按数据目录加载配置、建插件目录 =====
        app.state::<broker::BrokerManager>()
            .inner()
            .init_with_dir(&dir);
        app.state::<plugin::PluginManager>()
            .inner()
            .init_with_dir(&dir);

        // v2.23 高阶盯盘：注册条件单触发监听（落信号票；模拟盘可自动确认提交）
        broker::register_co_listener(app.handle());

        // P1-a：条件单引擎与计划定时物化随应用启动，不依赖驾驶舱 mount。
        // 复盘发现执行是「挂载驱动」的：应用跨午夜一直开着、用户不重开驾驶舱时，
        // 计划日当天既不会物化条件单，也没有引擎在跑。这里在启动装配处各拉起一次；
        // 两者内部都有 AtomicBool 幂等守卫，重复 setup 不会双跑。
        crate::market::alert::ensure_co_engine(app.handle());
        crate::ai::instruction::ensure_materialize_loop(app.handle());
        // P1-c：盘后自动流水线（15:05 后）+ 8:45 盘前确认提醒，同一 30s 循环。
        crate::ai::daily_schedule::ensure_daily_schedule(app.handle());

        // v2.31 选股订阅：30s 常驻调度，到点执行已保存战法扫描并应用内推送
        {
            let handle = app.handle().clone();
            let data_dir = dir.clone();
            tauri::async_runtime::spawn(async move {
                crate::market::screen_sub::scheduler_loop(handle, data_dir).await;
            });
        }
    }
    // ===== 内置浏览器本地 HTTP 代理：绕过 WebView2 在部分环境下外网被拦截的问题 =====
    {
        match proxy::start_proxy() {
            Ok(port) => {
                app.manage(std::sync::Mutex::new(Some(port)));
                log::info!("内置浏览器代理端口: {port}");
            }
            Err(e) => {
                app.manage(std::sync::Mutex::new(None::<u16>));
                log::warn!("内置浏览器代理启动失败（外链可能无法加载）: {e}");
            }
        }
    }
    // ===== 主窗口：手动构建（挂载外链拦截 → 内置浏览器），标题栏融入工作台 =====
    if app.get_webview_window("main").is_none() {
        if let Err(e) = build_main_window(app.handle()) {
            log::error!("主窗口创建失败: {e}");
        }
    }
    if let Some(main) = app.get_webview_window("main") {
        // 启动时强制显示并聚焦（防止上次关闭时被 hide）
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        // 显式设置图标，确保 Windows 任务栏正确显示
        if let Some(icon) = app.default_window_icon().cloned() {
            let _ = main.set_icon(icon);
        }

        // Windows/Linux —— 去掉原生标题栏（前端自绘最小化 / 最大化 / 关闭）
        #[cfg(not(target_os = "macos"))]
        let _ = main.set_decorations(false);

        // macOS —— 保留原生红绿灯，仅隐藏标题栏背景、内嵌入自绘顶栏
        #[cfg(target_os = "macos")]
        {
            use tauri::TitleBarStyle;
            // 红绿灯保持默认位置，由前端 .topbar.mac 左间距避让（不依赖运行时定位 API）
            let _ = main.set_title_bar_style(TitleBarStyle::Overlay);
        }
    }

    // ===== 灵动岛悬浮窗 =====
    let island = WebviewWindowBuilder::new(app, "island", WebviewUrl::App("index.html".into()))
        .title("TickGold Island")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .transparent(true)
        .inner_size(300.0, 52.0)
        .on_page_load(|_w, payload| {
            crate::commands::diag_log(&format!(
                "[island] page-load event={:?} url={}",
                payload.event(),
                payload.url()
            ));
        })
        .build()?;

    // 定位到右上角
    if let Some(monitor) = island.primary_monitor()? {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let x = (size.width as f64 / scale - 300.0) / 2.0;
        let _ = island.set_position(LogicalPosition::new(x, 12.0));
    }

    // ===== 系统托盘 =====
    // 菜单结构：
    //   ☑ 主窗口
    //   ☑ 灵动岛
    //   ─────────
    //   打开设置
    //   暂停预警
    //   ─────────
    //   关于 TickGold
    //   退出 TickGold
    let main_item = CheckMenuItem::with_id(app, "toggle_main", "主窗口", true, true, None::<&str>)?;
    let island_item =
        CheckMenuItem::with_id(app, "toggle_island", "灵动岛", true, true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let settings_item = MenuItem::with_id(app, "open_settings", "设置…", true, None::<&str>)?;
    let pause_item =
        CheckMenuItem::with_id(app, "pause_alert", "暂停预警", true, false, None::<&str>)?;
    let update_item = MenuItem::with_id(app, "check_update", "检查更新…", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let about_item = MenuItem::with_id(app, "about", "关于 TickGold", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 TickGold", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &main_item,
            &island_item,
            &sep1,
            &settings_item,
            &pause_item,
            &update_item,
            &sep2,
            &about_item,
            &quit,
        ],
    )?;

    let _main_c = main_item.clone();
    let _island_c = island_item.clone();
    let _main_c2 = main_item.clone();

    let main_c = main_item.clone();
    let island_c = island_item.clone();
    let main_c2 = main_item.clone();

    let tray_icon = app
        .default_window_icon()
        .cloned()
        .expect("no default window icon");
    TrayIconBuilder::with_id("main-tray")
        .icon(tray_icon)
        .tooltip("TickGold · 金睛盯盘\n左键：显示/隐藏主窗口")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "toggle_main" => toggle_window(app, "main", &main_c),
            "toggle_island" => toggle_window(app, "island", &island_c),
            "open_settings" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("open-settings", ());
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "pause_alert" => {
                // TODO: 切换预警暂停状态
            }
            "check_update" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("check-update", ());
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "about" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("show-about", ());
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                toggle_window(app, "main", &main_c2);
            }
        })
        .build(app)?;

    Ok(())
}
