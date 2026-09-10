// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("loop") => {
            if let Err(error) = workstreams_lib::run_loop_cli(args.collect()) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        // Always dispatched; the library reports the unsupported platform so a
        // Windows user gets an explanation instead of "unknown command".
        Some("agent") => {
            if let Err(error) = workstreams_lib::run_agent_cli(args.collect()) {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
        _ => workstreams_lib::run(),
    }
}
