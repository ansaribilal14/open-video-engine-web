//! Session state — single-writer v1, exactly like the Android client.
//!
//! One engine session per server process, owned by a `std::sync::Mutex`
//! (the HTTP layer serializes calls through `spawn_blocking`, which is the
//! web equivalent of the Android single-dispatcher-thread rule).
//!
//! Exports run as background jobs that TAKE the engine out of the slot for
//! their entire duration (the engine session is synchronous and holds the
//! single-writer lock); every other session op returns a typed
//! `EngineBusy` error while a job runs. Progress is honestly indeterminate —
//! the engine exposes no progress callback and no cancellation (audit gap #6).

use std::path::PathBuf;
use std::sync::Mutex;

use ove_engine::Engine;
use serde_json::Value;

#[derive(Debug)]
pub enum JobState {
    Running { kind: &'static str },
    Done(Value),
    Failed { kind: String, message: String },
}

pub struct AppState {
    /// The single engine session (None = no project open / export in flight).
    pub engine: Mutex<Option<Engine>>,
    /// Export job slot (running / done / failed) — polled by the UI.
    pub job: Mutex<Option<JobState>>,
    /// Server data root: `projects/`, `.staging/`, `registry.json`.
    pub data_root: PathBuf,
    /// Directory of the open project (for its documented `renders/` folder).
    pub project_dir: Mutex<Option<PathBuf>>,
    /// Exports this server produced (basename → absolute path). Downloads are
    /// served ONLY from this whitelist — no arbitrary path serving.
    pub renders: Mutex<Vec<String>>,
}

impl AppState {
    pub fn new(data_root: PathBuf) -> Self {
        std::fs::create_dir_all(data_root.join("projects")).expect("create data root");
        std::fs::create_dir_all(data_root.join(".staging")).expect("create staging dir");
        AppState {
            engine: Mutex::new(None),
            job: Mutex::new(None),
            data_root,
            project_dir: Mutex::new(None),
            renders: Mutex::new(Vec::new()),
        }
    }
}

/// Uniform error envelope: `{"ok":false,"kind":..., "message":...}` with an
/// HTTP status. Client-side kinds are prefixed `Client*` or are `EngineBusy`;
/// engine kinds pass through the audit §8 mapping unchanged.
pub struct ApiError {
    pub status: axum::http::StatusCode,
    pub kind: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn new(
        status: axum::http::StatusCode,
        kind: &'static str,
        message: impl Into<String>,
    ) -> Self {
        ApiError {
            status,
            kind,
            message: message.into(),
        }
    }
    pub fn bad_request(kind: &'static str, message: impl Into<String>) -> Self {
        Self::new(axum::http::StatusCode::BAD_REQUEST, kind, message)
    }
    pub fn busy() -> Self {
        Self::new(
            axum::http::StatusCode::CONFLICT,
            "EngineBusy",
            "an export is running on the single-writer engine session",
        )
    }
    pub fn no_session() -> Self {
        Self::new(
            axum::http::StatusCode::CONFLICT,
            "NoSession",
            "no project is open",
        )
    }
}

/// Every error crosses the wire in the SAME envelope as engine errors:
/// `{"ok":false,"kind":...,"message":...}` — the UI has exactly one error
/// shape to handle (audit §8).
impl axum::response::IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            axum::Json(serde_json::json!({
                "ok": false,
                "kind": self.kind,
                "message": self.message,
            })),
        )
            .into_response()
    }
}
