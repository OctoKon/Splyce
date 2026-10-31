#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let builder = tauri::Builder::default();

    // WebDriver support is test-only and starts only when the test runner asks for it.
    #[cfg(debug_assertions)]
    let builder = if std::env::var_os("TAURI_WEBDRIVER_PORT").is_some() {
        builder
            .plugin(tauri_plugin_wdio::init())
            .plugin(tauri_plugin_wdio_webdriver::init())
    } else {
        builder
    };

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
