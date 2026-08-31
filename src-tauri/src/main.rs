// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("loop") {
        if let Err(error) = workstreams_lib::run_loop_cli(args.collect()) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    workstreams_lib::run()
}
