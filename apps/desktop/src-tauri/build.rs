use sha2::{Digest, Sha256};

fn main() {
    let manifest = std::fs::read("resources/engine/manifest.json")
        .expect("Build the verified engine resources before the native shell");
    let digest: String = Sha256::digest(manifest)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    println!("cargo:rustc-env=SPLYCE_ENGINE_MANIFEST_SHA256={digest}");
    println!("cargo:rerun-if-changed=resources/engine/manifest.json");
    println!("cargo:rerun-if-changed=../../../packages/splyce-pi/dist/bridge-protocol.json");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "handshake",
            "send",
            "cancel",
            "subscribe",
            "dialog_select_workspace",
        ]),
    ))
    .expect("Native command permission generation failed");
}
