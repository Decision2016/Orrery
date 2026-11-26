#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::{
    env,
    io::{self, Read, Seek, SeekFrom, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const PROBE_INTERVAL: Duration = Duration::from_millis(150);
const START_TIMEOUT: Duration = Duration::from_secs(6);

fn healthy(port: u16, timeout: Duration) -> bool {
    fn probe(port: u16, timeout: Duration) -> io::Result<bool> {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let mut connection = TcpStream::connect_timeout(&address, timeout)?;
        connection.set_write_timeout(Some(timeout))?;
        connection.set_read_timeout(Some(timeout))?;
        // HTTP/1.0 and Connection: close give the JSON response a simple EOF boundary.
        write!(
            connection,
            "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        )?;
        let mut response = String::new();
        connection.take(64 * 1024).read_to_string(&mut response)?;
        let Some((headers, body)) = response.split_once("\r\n\r\n") else {
            return Ok(false);
        };
        let status = headers
            .lines()
            .next()
            .and_then(|line| line.split_ascii_whitespace().nth(1));
        let health = serde_json::from_str::<serde_json::Value>(body).ok();
        Ok(status == Some("200")
            && health.is_some_and(|h| {
                h["ok"] == true && h["version"].is_string() && h["collectors"].is_array()
            }))
    }
    probe(port, timeout).unwrap_or(false)
}

fn server_entry(
    exe_dir: &Path,
    resource_dir: &Path,
    override_entry: Option<&Path>,
) -> io::Result<PathBuf> {
    if let Some(value) = override_entry {
        let path = env::current_dir()?.join(value);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("ORRERY_SERVER_ENTRY does not exist: {}", path.display()),
            ))
        };
    }
    [exe_dir, resource_dir].into_iter()
        .flat_map(|base| [base.join("server/index.js"), base.join("resources/server/dist/index.js")])
        .chain(exe_dir.ancestors().map(|base| base.join("packages/server/dist/index.js")))
        .find(|path| path.is_file())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Orrery server entry is missing. Install the desktop resources or run npm run build in the repository."))
}

#[cfg(windows)]
fn backend_job() -> io::Result<OwnedHandle> {
    use windows_sys::Win32::System::JobObjects::*;
    unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = OwnedHandle::from_raw_handle(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }
}

#[derive(Default)]
pub struct ManagedBackend {
    child: Option<Child>,
    #[cfg(windows)]
    job: Option<OwnedHandle>,
}

impl ManagedBackend {
    pub fn start(port: u16, resource_dir: &Path) -> io::Result<Self> {
        let mut backend = Self::default();
        if healthy(port, PROBE_INTERVAL) {
            return Ok(backend);
        }
        let exe = env::current_exe()?;
        let exe_dir = exe
            .parent()
            .ok_or_else(|| io::Error::other("missing executable directory"))?;
        let override_entry = env::var_os("ORRERY_SERVER_ENTRY").map(PathBuf::from);
        let entry = server_entry(exe_dir, resource_dir, override_entry.as_deref())?;
        let bundled_node = resource_dir.join("resources/runtime/node.exe");
        let node = if cfg!(windows) && bundled_node.is_file() {
            bundled_node
        } else {
            PathBuf::from("node")
        };
        let mut stderr = tempfile::tempfile()?;
        let mut command = Command::new(node);
        command
            .env("ORRERY_HOST", "127.0.0.1")
            .env("ORRERY_PORT", port.to_string())
            .stdout(Stdio::null())
            .stderr(stderr.try_clone()?);
        let web = resource_dir.join("resources/web/dist");
        if env::var_os("ORRERY_WEB_DIST").is_none() && web.is_dir() {
            command.env("ORRERY_WEB_DIST", web);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::{
                JobObjects::AssignProcessToJobObject, Threading::CREATE_NO_WINDOW,
            };
            let job = backend_job()?;
            // Gate the entry point on one byte. If the parent dies between spawn and job assignment,
            // stdin closes and Node exits before it can start a listener or a collector process.
            command.creation_flags(CREATE_NO_WINDOW).stdin(Stdio::piped())
                .arg("--import").arg("data:text/javascript,import{readSync}from'node:fs';if(readSync(0,Buffer.alloc(1),0,1,null)!==1)process.exit(1)");
            let child = backend.child.insert(command.arg(&entry).spawn()?);
            if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0
            {
                return Err(io::Error::last_os_error());
            }
            backend.job = Some(job);
            child.stdin.take().unwrap().write_all(&[1])?;
        }
        #[cfg(not(windows))]
        {
            backend.child = Some(command.stdin(Stdio::null()).arg(&entry).spawn()?);
        }

        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            let next_probe = Instant::now() + PROBE_INTERVAL;
            if healthy(
                port,
                PROBE_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
            ) {
                return Ok(backend);
            }
            if let Some(status) = backend.child.as_mut().unwrap().try_wait()? {
                stderr.seek(SeekFrom::Start(0))?;
                let mut detail = String::new();
                stderr.take(4096).read_to_string(&mut detail)?;
                return Err(io::Error::other(format!(
                    "{} exited with {status} on port {port}.\n{}",
                    entry.display(),
                    detail.trim()
                )));
            }
            thread::sleep(
                next_probe
                    .min(deadline)
                    .saturating_duration_since(Instant::now()),
            );
        }
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("Orrery server on 127.0.0.1:{port} did not become healthy within six seconds"),
        ))
    }

    pub fn shutdown(&mut self) {
        #[cfg(windows)]
        drop(self.job.take());
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for ManagedBackend {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn one_response(status: &str, body: &str) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = format!("HTTP/1.0 {status}\r\nConnection: close\r\n\r\n{body}");
        let server = thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let (mut socket, _) = listener.accept().unwrap();
            let mut input = BufReader::new(&socket);
            let mut line = String::new();
            input.read_line(&mut line).unwrap();
            assert_eq!(line, "GET /api/health HTTP/1.0\r\n");
            while line != "\r\n" {
                line.clear();
                assert_ne!(input.read_line(&mut line).unwrap(), 0);
            }
            socket.write_all(response.as_bytes()).unwrap();
        });
        (port, server)
    }

    #[test]
    fn reuses_healthy_external_backend_without_owning_a_child() {
        let (port, server) =
            one_response("200 OK", r#"{"ok":true,"version":"1.0.0","collectors":[]}"#);
        let mut backend = ManagedBackend::start(port, Path::new("absent")).unwrap();
        assert!(backend.child.is_none());
        backend.shutdown();
        server.join().unwrap();
    }

    #[test]
    fn unrelated_listeners_and_error_responses_are_not_healthy() {
        for (status, body) in [
            ("200 OK", "<html>different service</html>"),
            ("200 OK", r#"{"ok":true}"#),
            (
                "503 Unavailable",
                r#"{"ok":true,"version":"1","collectors":[]}"#,
            ),
        ] {
            let (port, server) = one_response(status, body);
            assert!(!healthy(port, PROBE_INTERVAL));
            server.join().unwrap();
        }
    }

    #[test]
    fn finds_packaged_server_and_walks_up_to_repository_entry() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("src-tauri/target/release");
        let repo = root.path().join("packages/server/dist");
        let packaged = exe.join("resources/server/dist");
        for directory in [&repo, &packaged] {
            std::fs::create_dir_all(directory).unwrap();
        }
        std::fs::write(repo.join("index.js"), "").unwrap();
        assert_eq!(
            server_entry(&exe, &exe, None).unwrap(),
            repo.join("index.js")
        );
        std::fs::write(packaged.join("index.js"), "").unwrap();
        assert_eq!(
            server_entry(&exe, &exe, None).unwrap(),
            packaged.join("index.js")
        );
        let custom = repo.join("override.js");
        std::fs::write(&custom, "").unwrap();
        assert_eq!(server_entry(&exe, &exe, Some(&custom)).unwrap(), custom);
    }
}
