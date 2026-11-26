use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MonitorInfo {
    pub device_name: String,
    pub friendly_label: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub work_x: i32,
    pub work_y: i32,
    pub work_width: i32,
    pub work_height: i32,
    pub is_primary: bool,
    pub is_3840x1100: bool,
}

#[derive(Clone, Copy)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
#[derive(Default)]
pub struct Placement {
    pub bounds: Option<Bounds>,
    pub pinned: bool,
}
pub type MonitorLock = Arc<Mutex<Placement>>;

impl MonitorInfo {
    pub fn bounds(&self, cover_taskbar: bool) -> Bounds {
        if cover_taskbar {
            Bounds {
                x: self.x,
                y: self.y,
                width: self.width,
                height: self.height,
            }
        } else {
            Bounds {
                x: self.work_x,
                y: self.work_y,
                width: self.work_width,
                height: self.work_height,
            }
        }
    }
}

pub fn choose_target_monitor<'a>(
    monitors: &'a [MonitorInfo],
    saved_device: Option<&str>,
) -> Option<&'a MonitorInfo> {
    monitors
        .iter()
        .find(|m| Some(m.device_name.as_str()) == saved_device)
        .or_else(|| {
            monitors
                .iter()
                .find(|m| m.width == 3840 && m.height == 1100)
        })
        .or_else(|| {
            monitors
                .iter()
                .find(|m| m.height > 0 && f64::from(m.width) / f64::from(m.height) >= 2.8)
        })
        .or_else(|| monitors.iter().find(|m| !m.is_primary))
        .or_else(|| monitors.iter().find(|m| m.is_primary))
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{
        ffi::OsStr,
        io,
        mem::{size_of, zeroed},
        os::windows::ffi::OsStrExt,
        path::Path,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{
            GetLastError, SetLastError, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HWND, LPARAM, LRESULT,
            RECT, WPARAM,
        },
        Graphics::Gdi::{
            EnumDisplayDevicesW, EnumDisplayMonitors, GetMonitorInfoW, DISPLAY_DEVICEW, HDC,
            HMONITOR, MONITORINFOEXW,
        },
        System::Registry::*,
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass, ShellExecuteW},
            WindowsAndMessaging::*,
        },
    };

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(Some(0)).collect()
    }
    fn label(units: &[u16]) -> String {
        String::from_utf16_lossy(units.split(|&u| u == 0).next().unwrap_or_default())
    }
    fn win32(ok: i32) -> io::Result<()> {
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub fn enumerate_monitors() -> Vec<MonitorInfo> {
        unsafe extern "system" fn collect(
            handle: HMONITOR,
            _: HDC,
            _: *mut RECT,
            data: LPARAM,
        ) -> i32 {
            let mut info: MONITORINFOEXW = zeroed();
            info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
            if GetMonitorInfoW(handle, &mut info.monitorInfo) != 0 {
                let rc = info.monitorInfo.rcMonitor;
                let work = info.monitorInfo.rcWork;
                let (width, height) = (rc.right - rc.left, rc.bottom - rc.top);
                let device_name = label(&info.szDevice);
                let mut device: DISPLAY_DEVICEW = zeroed();
                device.cb = size_of::<DISPLAY_DEVICEW>() as u32;
                let friendly_label =
                    if EnumDisplayDevicesW(info.szDevice.as_ptr(), 0, &mut device, 0) != 0 {
                        label(&device.DeviceString)
                    } else {
                        device_name.clone()
                    };
                let monitors = &mut *(data as *mut Vec<MonitorInfo>);
                monitors.push(MonitorInfo {
                    device_name,
                    friendly_label,
                    x: rc.left,
                    y: rc.top,
                    width,
                    height,
                    work_x: work.left,
                    work_y: work.top,
                    work_width: work.right - work.left,
                    work_height: work.bottom - work.top,
                    is_primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
                    is_3840x1100: (width, height) == (3840, 1100),
                });
            }
            1
        }
        let mut monitors = Vec::new();
        // EnumDisplayMonitors invokes collect synchronously, while monitors is alive.
        unsafe {
            EnumDisplayMonitors(
                null_mut(),
                null(),
                Some(collect),
                &mut monitors as *mut _ as LPARAM,
            )
        };
        monitors
    }

    pub fn snap_window_to_monitor(
        hwnd: isize,
        monitor: &MonitorInfo,
        cover_taskbar: bool,
        always_on_top: bool,
    ) -> io::Result<()> {
        let b = monitor.bounds(cover_taskbar);
        let order = if always_on_top {
            HWND_TOPMOST
        } else {
            HWND_NOTOPMOST
        };
        win32(unsafe {
            SetWindowPos(
                hwnd as HWND,
                order,
                b.x,
                b.y,
                b.width,
                b.height,
                SWP_NOACTIVATE | SWP_FRAMECHANGED,
            )
        })
    }

    fn pin_style(style: u32, pinned: bool) -> u32 {
        let (enable, disable) = if pinned {
            (WS_EX_TOOLWINDOW, WS_EX_APPWINDOW)
        } else {
            (WS_EX_APPWINDOW, WS_EX_TOOLWINDOW)
        };
        (style | enable) & !disable
    }

    pub fn apply_pin_across_desktops(hwnd: isize, pinned: bool) -> io::Result<()> {
        let hwnd = hwnd as HWND;
        unsafe {
            SetLastError(ERROR_SUCCESS);
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if style == 0 && GetLastError() != ERROR_SUCCESS {
                return Err(io::Error::last_os_error());
            }
            let new_style = pin_style(style as u32, pinned) as isize;
            if new_style != style {
                SetLastError(ERROR_SUCCESS);
                if SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style) == 0
                    && GetLastError() != ERROR_SUCCESS
                {
                    return Err(io::Error::last_os_error());
                }
                win32(SetWindowPos(
                    hwnd,
                    null_mut(),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                ))?;
            }
        }
        Ok(())
    }

    struct DisplayWatch {
        placement: MonitorLock,
        changed: Box<dyn Fn()>,
    }

    pub fn install_monitor_lock(
        hwnd: isize,
        placement: MonitorLock,
        changed: impl Fn() + 'static,
    ) -> io::Result<()> {
        const REFRESH_DISPLAYS: u32 = WM_APP + 0x0718;
        unsafe extern "system" fn observe(
            hwnd: HWND,
            msg: u32,
            wp: WPARAM,
            lp: LPARAM,
            id: usize,
            data: usize,
        ) -> LRESULT {
            let watch = &*(data as *const DisplayWatch);
            match msg {
                WM_STYLECHANGING if wp as i32 == GWL_EXSTYLE => {
                    // Tao writes its cached extended styles again when showing a hidden window.
                    let change = &mut *(lp as *mut STYLESTRUCT);
                    change.styleNew =
                        pin_style(change.styleNew, watch.placement.lock().unwrap().pinned);
                }
                WM_WINDOWPOSCHANGING if IsIconic(hwnd) == 0 => {
                    let pos = &mut *(lp as *mut WINDOWPOS);
                    if let Some(b) = watch.placement.lock().unwrap().bounds {
                        if pos.flags & SWP_NOMOVE == 0 {
                            pos.x = b.x;
                            pos.y = b.y;
                        }
                        if pos.flags & SWP_NOSIZE == 0 {
                            pos.cx = b.width;
                            pos.cy = b.height;
                        }
                    }
                }
                WM_DISPLAYCHANGE | WM_SETTINGCHANGE => {
                    PostMessageW(hwnd, REFRESH_DISPLAYS, 0, 0);
                }
                REFRESH_DISPLAYS => {
                    (watch.changed)();
                    return 0;
                }
                WM_NCDESTROY => {
                    RemoveWindowSubclass(hwnd, Some(observe), id);
                    drop(Box::from_raw(data as *mut DisplayWatch));
                }
                _ => {}
            }
            DefSubclassProc(hwnd, msg, wp, lp)
        }
        let watch = Box::into_raw(Box::new(DisplayWatch {
            placement,
            changed: Box::new(changed),
        }));
        // The UI thread owns the subclass until WM_NCDESTROY. Recover its allocation on installation failure.
        let result =
            win32(unsafe { SetWindowSubclass(hwnd as HWND, Some(observe), 1, watch as usize) });
        if result.is_err() {
            unsafe { drop(Box::from_raw(watch)) };
        }
        result
    }

    pub fn set_windows_autostart(enabled: bool, exe_path: &Path) -> Result<(), String> {
        let path = wide(OsStr::new(r"Software\Microsoft\Windows\CurrentVersion\Run"));
        let name = wide(OsStr::new("Orrery"));
        let mut key = null_mut();
        let status = unsafe {
            if enabled {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    path.as_ptr(),
                    0,
                    null(),
                    0,
                    KEY_SET_VALUE,
                    null(),
                    &mut key,
                    null_mut(),
                )
            } else {
                RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_SET_VALUE, &mut key)
            }
        };
        if !enabled && status == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32).to_string());
        }
        let status = unsafe {
            let result = if enabled {
                let quotation = u16::from(b'"');
                let command: Vec<_> = [quotation]
                    .into_iter()
                    .chain(exe_path.as_os_str().encode_wide())
                    .chain([quotation, 0])
                    .collect();
                RegSetValueExW(
                    key,
                    name.as_ptr(),
                    0,
                    REG_SZ,
                    command.as_ptr().cast(),
                    (command.len() * 2) as u32,
                )
            } else {
                RegDeleteValueW(key, name.as_ptr())
            };
            RegCloseKey(key);
            result
        };
        if status == ERROR_SUCCESS || (!enabled && status == ERROR_FILE_NOT_FOUND) {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(status as i32).to_string())
        }
    }

    pub fn open_browser(port: u16) -> io::Result<()> {
        let url = wide(OsStr::new(&format!("http://127.0.0.1:{port}")));
        let result = unsafe {
            ShellExecuteW(
                null_mut(),
                null(),
                url.as_ptr(),
                null(),
                null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        if result > 32 {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "Opening the browser failed ({result})"
            )))
        }
    }

    pub fn show_error(message: &str) {
        let message = wide(OsStr::new(message));
        let title = wide(OsStr::new("Orrery"));
        unsafe {
            MessageBoxW(
                null_mut(),
                message.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            )
        };
    }
}

#[cfg(not(windows))]
mod native {
    use super::*;
    use std::{io, path::Path};
    pub fn enumerate_monitors() -> Vec<MonitorInfo> {
        vec![]
    }
    pub fn snap_window_to_monitor(_: isize, _: &MonitorInfo, _: bool, _: bool) -> io::Result<()> {
        Ok(())
    }
    pub fn apply_pin_across_desktops(_: isize, _: bool) -> io::Result<()> {
        Ok(())
    }
    pub fn install_monitor_lock(
        _: isize,
        _: MonitorLock,
        _: impl Fn() + 'static,
    ) -> io::Result<()> {
        Ok(())
    }
    pub fn set_windows_autostart(_: bool, _: &Path) -> Result<(), String> {
        Err("Windows autostart is unavailable on this platform".into())
    }
    pub fn open_browser(port: u16) -> io::Result<()> {
        std::process::Command::new(if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        })
        .arg(format!("http://127.0.0.1:{port}"))
        .spawn()
        .map(|_| ())
    }
    pub fn show_error(message: &str) {
        eprintln!("Orrery: {message}");
    }
}
pub use native::*;

#[cfg(test)]
mod tests {
    use super::*;
    fn display(name: &str, width: i32, height: i32, is_primary: bool) -> MonitorInfo {
        MonitorInfo {
            device_name: name.into(),
            friendly_label: name.into(),
            x: -width,
            y: 10,
            width,
            height,
            work_x: -width + 48,
            work_y: 10,
            work_width: width - 48,
            work_height: height,
            is_primary,
            is_3840x1100: (width, height) == (3840, 1100),
        }
    }

    #[test]
    fn selection_honors_each_priority_and_disconnected_devices() {
        let displays = [
            display("primary", 1920, 1080, true),
            display("secondary", 2560, 1440, false),
            display("wide", 4200, 1500, false),
            display("orrery", 3840, 1100, false),
        ];
        for (count, saved, wanted) in [
            (4, Some("primary"), Some("primary")),
            (4, Some("missing"), Some("orrery")),
            (3, None, Some("wide")),
            (2, None, Some("secondary")),
            (1, None, Some("primary")),
            (0, None, None),
        ] {
            assert_eq!(
                choose_target_monitor(&displays[..count], saved).map(|m| m.device_name.as_str()),
                wanted
            );
        }
    }

    #[test]
    fn taskbar_and_monitor_rectangles_keep_physical_offsets() {
        let monitor = display("left", 3840, 1100, false);
        let full = monitor.bounds(true);
        let work = monitor.bounds(false);
        assert_eq!(
            (full.x, full.y, full.width, full.height),
            (-3840, 10, 3840, 1100)
        );
        assert_eq!(
            (work.x, work.y, work.width, work.height),
            (-3792, 10, 3792, 1100)
        );
    }

    #[cfg(windows)]
    #[test]
    fn native_style_rewrites_preserve_current_pin_setting() {
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        let class: Vec<_> = "STATIC\0".encode_utf16().collect();
        let placement = MonitorLock::default();
        unsafe {
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                null(),
                WS_POPUP,
                0,
                0,
                32,
                32,
                null_mut(),
                null_mut(),
                null_mut(),
                null(),
            );
            assert!(!hwnd.is_null());
            install_monitor_lock(hwnd as isize, placement.clone(), || {}).unwrap();
            for (pinned, other, expected) in [
                (true, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW),
                (false, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW),
            ] {
                placement.lock().unwrap().pinned = pinned;
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (WS_EX_NOACTIVATE | other) as isize);
                let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
                assert_eq!(
                    style & (WS_EX_NOACTIVATE | WS_EX_APPWINDOW | WS_EX_TOOLWINDOW),
                    WS_EX_NOACTIVATE | expected
                );
            }
            DestroyWindow(hwnd);
        }
    }
}
