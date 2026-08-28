fn execute(args: Vec<String>) -> i32 {
    match workstreams_lib::run_loop_cli(args) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

fn main() {
    let exit_code = execute(std::env::args().skip(1).collect());
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_command_returns_failure_exit_code() {
        assert_eq!(execute(vec!["unknown".to_string()]), 1);
    }
}
