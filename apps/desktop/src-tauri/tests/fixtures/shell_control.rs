#![allow(dead_code, unused_imports)]
#[cfg(windows)]
#[path = "../../src/credentials.rs"]
mod credentials;
#[cfg(windows)]
#[path = "../../src/inventory.rs"]
mod inventory;
#[cfg(windows)]
#[path = "../../src/process.rs"]
mod process;
#[cfg(windows)]
#[path = "../../src/workspace.rs"]
mod workspace;
fn main() {
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--serve") {
        use std::io::{BufRead, Write};
        let mut registry =
            process::windows::shell::Registry::new(process::windows::create_job().unwrap());
        let cleanup_failed = registry.cleanup_failed.clone();
        for line in std::io::stdin().lock().lines() {
            let frame = serde_json::from_str(&line.unwrap()).unwrap();
            let encoded = registry.reply(frame).unwrap();
            let mut stdout = std::io::stdout().lock();
            stdout.write_all(&encoded[4..]).unwrap();
            writeln!(&mut stdout).unwrap();
            stdout.flush().unwrap();
        }
        drop(registry);
        assert!(!cleanup_failed.load(std::sync::atomic::Ordering::Acquire));
    }
}
