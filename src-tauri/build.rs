use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=resources/shim");
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let shim = manifest.join("resources").join("shim").join(
        if cfg!(windows) { "git.exe" } else { "git" },
    );
    if !shim.exists() {
        println!(
            "cargo:warning=git-no-verify shim not found at {}. Run \
             `npm run build:shim` (auto-chained from npm predev/prebuild) \
             before `cargo tauri dev` / `tauri build`.",
            shim.display()
        );
    }
    tauri_build::build()
}
