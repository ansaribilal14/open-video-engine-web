//! ove-web — OVE Studio web server.
//!
//! A CLIENT of the Open Video Engine: hosts one headless engine session
//! (library surface, engine pinned by `fetch-engine.sh`), exposes it over a
//! typed-JSON HTTP API, and serves the web editor UI. Zero engine behavior
//! lives here — the engine repo is a read-only dependency (audit §3).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use ove_web::state::AppState;
use ove_web::{api, ops};

#[tokio::main]
async fn main() {
    let data_root = std::env::var("OVE_WEB_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs_home().join(".ove-web"));
    let port: u16 = std::env::var("OVE_WEB_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);

    let st = Arc::new(AppState::new(data_root.clone()));
    // Hosted-UI CORS opt-in (server/src/cors.rs): unset ⇒ byte-identical
    // same-origin behavior; set ⇒ only the listed page origins may call.
    let allowed = ove_web::cors::parse_allow_origins(
        std::env::var("OVE_WEB_ALLOW_ORIGIN").ok().as_deref(),
    );
    if !allowed.is_empty() {
        println!("  cors:      allowing origins: {}", allowed.join(", "));
    }
    let app = ove_web::cors::protect(api::router(st.clone()).merge(api::ui_router()), allowed);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind 127.0.0.1");
    println!(
        "OVE Studio web server v{} — engine pinned {}",
        ops::SERVER_VERSION,
        &ops::ENGINE_PIN[..12]
    );
    println!("  data root: {}", data_root.display());
    println!("  editor:    http://{}:{}/", addr.ip(), addr.port());
    axum::serve(listener, app).await.expect("server run");
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}
