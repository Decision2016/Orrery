mod backend;
mod prefs;
mod win32_window;

use backend::ManagedBackend;
use prefs::{WindowPrefs, DEFAULT_PORT};
use std::{error::Error, io, path::PathBuf, sync::Mutex};
use tauri::{
    ipc::CapabilityBuilder,
    menu::{CheckMenuItem, Menu, MenuBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use win32_window::{choose_target_monitor, enumerate_monitors, MonitorInfo, MonitorLock};

type DesktopResult<T> = Result<T, Box<dyn Error>>;
const TRAY_ID: &str = "orrery";

struct AppState {
    prefs: Mutex<WindowPrefs>,
    prefs_path: PathBuf,
    placement: MonitorLock,
    backend: Mutex<ManagedBackend>,
}

fn main_window(app: &AppHandle) -> DesktopResult<WebviewWindow> {
    Ok(app
        .get_webview_window("main")
        .ok_or_else(|| io::Error::other("Orrery window is unavailable"))?)
}

fn hwnd(_window: &WebviewWindow) -> tauri::Result<isize> {
    #[cfg(windows)]
    {
        Ok(_window.hwnd()?.0 as isize)
    }
    #[cfg(not(windows))]
    {
        Ok(0)
    }
}

fn tray_menu(
    app: &AppHandle,
    prefs: &WindowPrefs,
    monitors: &[MonitorInfo],
) -> tauri::Result<Menu<Wry>> {
    let active = choose_target_monitor(monitors, prefs.target_monitor_device.as_deref());
    let mut displays = SubmenuBuilder::new(app, "目标显示器");
    for m in monitors {
        let selected = if active == Some(m) { "✓ " } else { "" };
        let star = if m.is_3840x1100 { " ★" } else { "" };
        let id = m.device_name.trim_start_matches(r"\\.\");
        displays = displays.text(
            format!("monitor/{}", m.device_name),
            format!(
                "{selected}{} ({id})  {}×{}{star}",
                m.friendly_label, m.width, m.height
            ),
        );
    }
    let mut menu = MenuBuilder::new(app)
        .text("show", "显示 / 隐藏监视台")
        .text("snap", "立即贴合目标副屏")
        .item(&displays.build()?)
        .separator();
    for (id, text, checked) in [
        (
            "pin",
            "跨虚拟桌面固定 (全桌面常驻)",
            prefs.pin_across_desktops,
        ),
        ("cover", "覆盖副屏任务栏 (真全屏)", prefs.cover_taskbar),
        ("top", "始终置顶", prefs.always_on_top),
        ("autostart", "开机自启", prefs.autostart),
    ] {
        menu = menu.item(&CheckMenuItem::with_id(
            app,
            id,
            text,
            true,
            checked,
            None::<&str>,
        )?);
    }
    menu.separator()
        .text("browser", "在浏览器打开")
        .text("quit", "退出 Orrery")
        .build()
}

fn apply_window(
    app: &AppHandle,
    prefs: &WindowPrefs,
    monitors: &[MonitorInfo],
) -> DesktopResult<()> {
    let window = main_window(app)?;
    let hwnd = hwnd(&window)?;
    let target = choose_target_monitor(monitors, prefs.target_monitor_device.as_deref());
    *app.state::<AppState>().placement.lock().unwrap() = win32_window::Placement {
        bounds: target.map(|m| m.bounds(prefs.cover_taskbar)),
        pinned: prefs.pin_across_desktops,
    };
    if window.is_always_on_top()? != prefs.always_on_top {
        window.set_always_on_top(prefs.always_on_top)?;
    }
    win32_window::apply_pin_across_desktops(hwnd, prefs.pin_across_desktops)?;
    if let Some(monitor) = target {
        win32_window::snap_window_to_monitor(
            hwnd,
            monitor,
            prefs.cover_taskbar,
            prefs.always_on_top,
        )?;
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(tray_menu(app, prefs, monitors)?))?;
    }
    Ok(())
}

fn change_prefs(app: &AppHandle, edit: impl FnOnce(&mut WindowPrefs)) -> DesktopResult<()> {
    let state = app.state::<AppState>();
    let mut saved = state.prefs.lock().unwrap();
    let mut next = saved.clone();
    edit(&mut next);
    let monitors = enumerate_monitors();
    if next.target_monitor_device != saved.target_monitor_device
        && !monitors
            .iter()
            .any(|m| Some(&m.device_name) == next.target_monitor_device.as_ref())
    {
        return Err("The selected display is disconnected".into());
    }
    if next != *saved {
        let changed_autostart = next.autostart != saved.autostart;
        if changed_autostart {
            win32_window::set_windows_autostart(next.autostart, &std::env::current_exe()?)?;
        }
        if let Err(error) = next.save(&state.prefs_path) {
            if changed_autostart {
                win32_window::set_windows_autostart(saved.autostart, &std::env::current_exe()?)?;
            }
            return Err(error.into());
        }
        *saved = next.clone();
    }
    drop(saved);
    apply_window(app, &next, &monitors)
}

#[tauri::command]
fn get_window_prefs(state: State<'_, AppState>) -> WindowPrefs {
    state.prefs.lock().unwrap().clone()
}

#[tauri::command]
fn list_monitors() -> Vec<MonitorInfo> {
    enumerate_monitors()
}

#[tauri::command]
fn snap_to_monitor(app: AppHandle, device_name: Option<String>) -> Result<(), String> {
    change_prefs(&app, |p| {
        if let Some(device) = device_name {
            p.target_monitor_device = Some(device);
        }
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_pin_across_desktops(app: AppHandle, enabled: bool) -> Result<(), String> {
    change_prefs(&app, |p| p.pin_across_desktops = enabled).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, enabled: bool) -> Result<(), String> {
    change_prefs(&app, |p| p.always_on_top = enabled).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_cover_taskbar(app: AppHandle, enabled: bool) -> Result<(), String> {
    change_prefs(&app, |p| p.cover_taskbar = enabled).map_err(|e| e.to_string())
}

fn tray_action(app: &AppHandle, id: &str) -> DesktopResult<()> {
    match id {
        "show" => {
            let window = main_window(app)?;
            if window.is_visible()? {
                window.hide()?;
            } else {
                change_prefs(app, |_| {})?;
                window.show()?;
            }
        }
        "snap" => change_prefs(app, |_| {})?,
        "pin" => change_prefs(app, |p| p.pin_across_desktops = !p.pin_across_desktops)?,
        "cover" => change_prefs(app, |p| p.cover_taskbar = !p.cover_taskbar)?,
        "top" => change_prefs(app, |p| p.always_on_top = !p.always_on_top)?,
        "autostart" => change_prefs(app, |p| p.autostart = !p.autostart)?,
        "browser" => win32_window::open_browser(get_window_prefs(app.state()).server_port)?,
        "quit" => app.exit(0),
        id => {
            if let Some(device) = id.strip_prefix("monitor/") {
                change_prefs(app, |p| p.target_monitor_device = Some(device.into()))?;
            }
        }
    }
    Ok(())
}

fn setup(app: &mut tauri::App) -> DesktopResult<()> {
    let prefs_path = WindowPrefs::path()?;
    let prefs = WindowPrefs::load(&prefs_path)
        .map_err(|e| io::Error::other(format!("{}: {e}", prefs_path.display())))?;
    if !prefs_path.exists() {
        prefs.save(&prefs_path)?;
    }
    let backend = ManagedBackend::start(prefs.server_port, &app.path().resource_dir()?)?;
    let placement = MonitorLock::default();
    app.manage(AppState {
        prefs: Mutex::new(prefs.clone()),
        prefs_path,
        placement: placement.clone(),
        backend: Mutex::new(backend),
    });

    let mut config = app.config().app.windows[0].clone();
    if prefs.server_port != DEFAULT_PORT {
        // The existing web client uses same-origin API URLs when served by the local backend.
        let origin = format!("http://127.0.0.1:{}", prefs.server_port);
        config.url = WebviewUrl::External(origin.parse()?);
        app.add_capability(
            CapabilityBuilder::new("configured-backend-dashboard")
                .window("main")
                .local(false)
                .remote(origin)
                .permission("window-controls")
                .permission("notification:allow-request-permission")
                .permission("notification:allow-is-permission-granted")
                .permission("notification:allow-notify"),
        )?;
    }
    let window = WebviewWindowBuilder::from_config(app, &config)?.build()?;
    let handle = app.handle().clone();
    win32_window::install_monitor_lock(hwnd(&window)?, placement, move || {
        let prefs = get_window_prefs(handle.state());
        if let Err(error) = apply_window(&handle, &prefs, &enumerate_monitors()) {
            eprintln!("Display change: {error}");
        }
    })?;
    let monitors = enumerate_monitors();
    apply_window(app.handle(), &prefs, &monitors)?;

    let menu = tray_menu(app.handle(), &prefs, &monitors)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/32x32.png"
        ))?)
        .tooltip("Orrery")
        .menu(&menu)
        .on_menu_event(|app, event| {
            if let Err(error) = tray_action(app, event.id().as_ref()) {
                // Native check items toggle before their event reaches us.
                let _ = change_prefs(app, |_| {});
                win32_window::show_error(&error.to_string());
            }
        })
        .build(app)?;
    window.show()?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.show() {
                    win32_window::show_error(&error.to_string());
                }
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_window_prefs,
            list_monitors,
            snap_to_monitor,
            set_pin_across_desktops,
            set_always_on_top,
            set_cover_taskbar
        ])
        .setup(|app| {
            if let Err(error) = setup(app) {
                win32_window::show_error(&error.to_string());
                app.handle().exit(1);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    win32_window::show_error(&error.to_string());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("build the Orrery desktop application")
        .run(|handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = handle.try_state::<AppState>() {
                    state.backend.lock().unwrap().shutdown();
                }
            }
        });
}
