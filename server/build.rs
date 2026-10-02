//! build.rs — guarantee the UI embed folder exists so `rust-embed` compiles
//! even before `web/dist` has been built. When the folder is empty the server
//! still runs (API-only) and honestly reports `ui_available: false` — the
//! release build embeds the real UI produced by `npm run build`.

use std::fs;
use std::path::PathBuf;

fn main() {
    let out = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("web-dist");
    fs::create_dir_all(&out).expect("create web-dist dir");
    let marker = out.join(".placeholder");
    if !marker.exists() {
        fs::write(
            &marker,
            "placeholder — run `npm ci && npm run build` in ../web to build the editor UI\n",
        )
        .expect("write placeholder");
    }
    println!("cargo:rerun-if-changed=web-dist");
    println!("cargo:rerun-if-changed=../web/dist");
}
