fn main() {
    // Tauri CLI runs beforeBuildCommand. Direct Cargo builds and first-time dev runs need the same assets.
    let assets = [
        "../packages/server/dist/index.js",
        "../packages/shared/dist/index.js",
        "../packages/web/dist/index.html",
    ];
    if assets
        .iter()
        .any(|path| !std::path::Path::new(path).is_file())
    {
        let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
        let status = std::process::Command::new(npm)
            .current_dir("..")
            .args(["run", "build"])
            .status()
            .expect("run the workspace build");
        assert!(
            status.success(),
            "npm run build failed; install the workspace dependencies with npm ci"
        );
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=prepare-node.ps1");
        let status = std::process::Command::new("powershell.exe")
            .env_remove("PSModulePath")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-File",
                "prepare-node.ps1",
            ])
            .arg(std::env::var("CARGO_CFG_TARGET_ARCH").unwrap())
            .status()
            .expect("run the Windows Node runtime preparation script");
        assert!(
            status.success(),
            "could not prepare the bundled Node runtime"
        );
    }
    tauri_build::build();
}
