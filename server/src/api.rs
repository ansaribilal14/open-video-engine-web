//! HTTP API — typed-JSON surface over the engine session.
//!
//! Envelopes mirror the Android JNI bridge exactly:
//!   success `{"ok":true, ...shape}` · failure `{"ok":false,"kind":...,"message":...}`
//! Rationals are `[num, den]` i64 pairs end-to-end (never floats).
//!
//! Concurrency: the engine session lives in a `std::sync::Mutex` (single-writer
//! v1). Every engine call runs on the blocking thread pool with the guard
//! MOVED into the closure — nothing holds the lock across an await, and the
//! async runtime never blocks on engine work.

use axum::extract::{DefaultBodyLimit, Multipart, Path as AxPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::ops;
use crate::state::{ApiError, AppState, JobState};
use ove_engine::{Engine, EngineError};
use ove_time::Rational;

type St = State<Arc<AppState>>;

// ---------------------------------------------------------------------------
// Rational parsing / validation (before any engine call — never panic;
// `Rational::new` asserts den > 0, so the boundary validates first)
// ---------------------------------------------------------------------------
fn parse_rat(v: &Value, what: &str) -> Result<Rational, ApiError> {
    let arr = v
        .as_array()
        .ok_or_else(|| ApiError::bad_request("BadRequest", format!("{what} must be [num, den]")))?;
    if arr.len() != 2 {
        return Err(ApiError::bad_request(
            "BadRequest",
            format!("{what} must be [num, den]"),
        ));
    }
    let num = arr[0]
        .as_i64()
        .ok_or_else(|| ApiError::bad_request("BadRequest", format!("{what}.num must be an i64")))?;
    let den = arr[1]
        .as_i64()
        .ok_or_else(|| ApiError::bad_request("BadRequest", format!("{what}.den must be an i64")))?;
    if den <= 0 {
        return Err(ApiError::bad_request(
            "BadRequest",
            format!("{what}.den must be > 0"),
        ));
    }
    Ok(Rational::new(num, den))
}

fn parse_i64(v: &Value, what: &str) -> Result<i64, ApiError> {
    v.as_i64()
        .ok_or_else(|| ApiError::bad_request("BadRequest", format!("{what} must be an integer")))
}

// ---------------------------------------------------------------------------
// Session lock helpers
// ---------------------------------------------------------------------------
fn job_running(st: &AppState) -> bool {
    matches!(
        st.job.lock().unwrap_or_else(|p| p.into_inner()).as_ref(),
        Some(JobState::Running { .. })
    )
}

/// Run `f` with the engine session on the blocking pool. Errors:
/// `EngineBusy` (export in flight), `NoSession`, then the typed engine
/// mapping (audit §8).
async fn with_engine<T, F>(st: &Arc<AppState>, f: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(&mut Engine) -> Result<T, EngineError> + Send + 'static,
{
    if job_running(st) {
        return Err(ApiError::busy());
    }
    {
        let guard = st.engine.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_none() {
            return Err(ApiError::no_session());
        }
    }
    let owned = st.clone();
    let res = tokio::task::spawn_blocking(move || {
        let mut guard = owned.engine.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_mut() {
            Some(engine) => f(engine),
            None => Err(EngineError::Internal("no project is open".into())),
        }
    })
    .await
    .map_err(|e| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EngineInternal",
            e.to_string(),
        )
    })?;
    res.map_err(|e| {
        let (kind, message) = ops::error_parts(&e);
        ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, kind, message)
    })
}

fn engine_err_to_api(e: EngineError) -> ApiError {
    let (kind, message) = ops::error_parts(&e);
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, kind, message)
}

// ---------------------------------------------------------------------------
// Version / settings / projects
// ---------------------------------------------------------------------------
pub async fn version(State(st): St) -> Result<Json<Value>, ApiError> {
    let ui_available = embedded_ui().iter().any(|f| f == "index.html");
    Ok(Json(json!({
        "ok": true,
        "server": ops::SERVER_VERSION,
        "engine_pin": ops::ENGINE_PIN,
        "engine_version": "0.1.0",
        "ui_available": ui_available,
        "data_root": st.data_root.to_string_lossy(),
        "engine_busy": job_running(&st),
    })))
}

fn registry_path(st: &AppState) -> PathBuf {
    st.data_root.join("registry.json")
}

fn read_registry(st: &AppState) -> Vec<Value> {
    std::fs::read_to_string(registry_path(st))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
        .unwrap_or_default()
}

fn write_registry(st: &AppState, entries: &[Value]) {
    let body = serde_json::to_string_pretty(entries).unwrap_or_else(|_| "[]".into());
    let _ = std::fs::write(registry_path(st), body);
}

fn chrono_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn registry_touch(st: &AppState, name: &str) {
    let mut entries = read_registry(st);
    let now = chrono_secs();
    if let Some(e) = entries.iter_mut().find(|e| e["name"] == json!(name)) {
        e["last_opened"] = json!(now);
    } else {
        entries.push(json!({"name": name, "created": now, "last_opened": now}));
    }
    entries.sort_by_key(|e| -e["last_opened"].as_i64().unwrap_or(0));
    write_registry(st, &entries);
}

fn registry_remove(st: &AppState, name: &str) {
    let mut entries = read_registry(st);
    entries.retain(|e| e["name"] != json!(name));
    write_registry(st, &entries);
}

/// Sanitized project folder name (client-side registry responsibility,
/// audit gap #9): [A-Za-z0-9_-], 1..64 chars.
fn sanitize_name(raw: &str) -> Result<String, ApiError> {
    let ok = !raw.is_empty()
        && raw.len() <= 64
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(raw.to_string())
    } else {
        Err(ApiError::bad_request(
            "BadRequest",
            "project name must be 1..64 chars of [A-Za-z0-9_-]",
        ))
    }
}

fn ensure_session_free(st: &AppState) -> Result<(), ApiError> {
    if job_running(st) {
        return Err(ApiError::busy());
    }
    let guard = st.engine.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_some() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "ProjectOpen",
            "another project is already open in this single-writer session",
        ));
    }
    Ok(())
}

pub async fn projects_list(State(st): St) -> Json<Value> {
    let entries = read_registry(&st);
    let mut projects = Vec::new();
    for e in entries {
        let name = e["name"].as_str().unwrap_or_default().to_string();
        let dir = st.data_root.join("projects").join(format!("{name}.ove"));
        projects.push(json!({
            "name": name,
            "exists_on_disk": dir.exists(),
            "created": e.get("created").cloned().unwrap_or(Value::Null),
            "last_opened": e.get("last_opened").cloned().unwrap_or(Value::Null),
        }));
    }
    Json(json!({"ok": true, "projects": projects}))
}

pub async fn projects_create(
    State(st): St,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = sanitize_name(
        body["name"]
            .as_str()
            .ok_or_else(|| ApiError::bad_request("BadRequest", "name is required"))?,
    )?;
    let tick = parse_rat(
        &body.get("tick").cloned().unwrap_or(json!([48000, 1])),
        "tick",
    )?;
    ensure_session_free(&st)?;
    let dir = st.data_root.join("projects").join(format!("{name}.ove"));
    if dir.exists() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "ProjectExists",
            format!("project '{name}' already exists"),
        ));
    }
    let engine = Engine::create(&dir, (tick.num(), tick.den())).map_err(engine_err_to_api)?;
    *st.project_dir.lock().unwrap_or_else(|p| p.into_inner()) = Some(dir.clone());
    registry_touch(&st, &name);
    *st.engine.lock().unwrap_or_else(|p| p.into_inner()) = Some(engine);
    let shape = with_engine(&st, |e| Ok(ops::ok_shape(e))).await?;
    Ok(Json(json_shape_with_project(
        shape,
        &name,
        &dir.to_string_lossy(),
    )))
}

pub async fn projects_open(
    State(st): St,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = sanitize_name(
        body["name"]
            .as_str()
            .ok_or_else(|| ApiError::bad_request("BadRequest", "name is required"))?,
    )?;
    let dir = st.data_root.join("projects").join(format!("{name}.ove"));
    // Idempotent re-open: if THIS project is already the open session (e.g.
    // the browser reloaded), return the current shape. Every mutation is
    // already durable in the engine's append-only log (P-2), so the open
    // session IS the on-disk state; no reopen work is needed.
    let (same_open, session_busy) = {
        let already = st.project_dir.lock().unwrap_or_else(|p| p.into_inner());
        let busy = st
            .engine
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some();
        (already.as_deref() == Some(dir.as_path()), busy)
    };
    if session_busy {
        if same_open {
            let shape = with_engine(&st, |e| Ok(ops::ok_shape(e))).await?;
            return Ok(Json(json_shape_with_project(
                shape,
                &name,
                &dir.to_string_lossy(),
            )));
        }
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "ProjectOpen",
            "another project is already open in this single-writer session",
        ));
    }
    if job_running(&st) {
        return Err(ApiError::busy());
    }
    let engine = Engine::open(&dir).map_err(engine_err_to_api)?;
    *st.project_dir.lock().unwrap_or_else(|p| p.into_inner()) = Some(dir.clone());
    registry_touch(&st, &name);
    *st.engine.lock().unwrap_or_else(|p| p.into_inner()) = Some(engine);
    let shape = with_engine(&st, |e| Ok(ops::ok_shape(e))).await?;
    Ok(Json(json_shape_with_project(
        shape,
        &name,
        &dir.to_string_lossy(),
    )))
}

fn json_shape_with_project(shape: Value, name: &str, dir: &str) -> Value {
    let mut out = shape;
    if let Some(o) = out.as_object_mut() {
        o.insert("project".into(), json!({"name": name, "dir": dir}));
    }
    out
}

pub async fn projects_close(State(st): St) -> Result<Json<Value>, ApiError> {
    if job_running(&st) {
        return Err(ApiError::busy());
    }
    *st.engine.lock().unwrap_or_else(|p| p.into_inner()) = None;
    *st.project_dir.lock().unwrap_or_else(|p| p.into_inner()) = None;
    Ok(Json(json!({"ok": true, "closed": true})))
}

pub async fn projects_delete(
    State(st): St,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = sanitize_name(
        body["name"]
            .as_str()
            .ok_or_else(|| ApiError::bad_request("BadRequest", "name is required"))?,
    )?;
    if job_running(&st) {
        return Err(ApiError::busy());
    }
    {
        let guard = st.engine.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_some() {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "ProjectOpen",
                "close the project before deleting it",
            ));
        }
    }
    let dir = st.data_root.join("projects").join(format!("{name}.ove"));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "StorageError",
                e.to_string(),
            )
        })?;
    }
    registry_remove(&st, &name);
    Ok(Json(json!({"ok": true, "deleted": name})))
}

// ---------------------------------------------------------------------------
// Media import (multipart staging → engine import → staging cleanup)
// ---------------------------------------------------------------------------
pub async fn media_import(
    State(st): St,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let mut staged: Option<PathBuf> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request("BadRequest", format!("multipart read failed: {e}")))?
    {
        if field.name() == Some("file") {
            let original = field.file_name().unwrap_or("media.bin").to_string();
            let safe = original
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect::<String>();
            let path =
                st.data_root
                    .join(".staging")
                    .join(format!("{}-{}", uuid::Uuid::new_v4(), safe));
            let mut file = tokio::fs::File::create(&path).await.map_err(|e| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "StorageError",
                    e.to_string(),
                )
            })?;
            use tokio::io::AsyncWriteExt;
            let mut f = field;
            loop {
                match f.chunk().await {
                    Ok(Some(bytes)) => {
                        file.write_all(&bytes).await.map_err(|e| {
                            ApiError::new(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                "StorageError",
                                e.to_string(),
                            )
                        })?;
                    }
                    Ok(None) => break,
                    Err(e) => {
                        let _ = tokio::fs::remove_file(&path).await;
                        return Err(ApiError::bad_request(
                            "BadRequest",
                            format!("upload failed: {e}"),
                        ));
                    }
                }
            }
            file.flush().await.ok();
            drop(file);
            staged = Some(path);
        }
    }
    let staged = staged
        .ok_or_else(|| ApiError::bad_request("BadRequest", "multipart field 'file' is required"))?;

    // Engine consumes the staged real path (its content-addressed copy is the
    // authoritative one); the staging copy is deleted after success — the
    // exact SAF-staging discipline from the Android client (audit §11).
    let path = staged.clone();
    let res = with_engine(&st, move |e| ops::import_media(e, &path)).await;
    let _ = tokio::fs::remove_file(&staged).await;
    Ok(Json(res?))
}

// ---------------------------------------------------------------------------
// Timeline ops
// ---------------------------------------------------------------------------
pub async fn track_add(State(st): St, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let id = parse_i64(&body["id"], "id")?;
    Ok(Json(
        with_engine(&st, move |e| ops::add_track(e, id)).await?,
    ))
}

pub async fn clip_add(State(st): St, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let track = parse_i64(&body["track"], "track")?;
    let hash = body["hash"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("BadRequest", "hash is required"))?
        .to_string();
    let duration = parse_rat(&body["duration"], "duration")?;
    let source_in = parse_rat(&body["source_in"], "source_in")?;
    Ok(Json(
        with_engine(&st, move |e| {
            ops::add_clip(e, track, &hash, duration, source_in)
        })
        .await?,
    ))
}

pub async fn clip_split(State(st): St, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let track = parse_i64(&body["track"], "track")?;
    let clip = parse_i64(&body["clip"], "clip")?;
    let at = parse_rat(&body["at"], "at")?;
    Ok(Json(
        with_engine(&st, move |e| ops::split(e, track, clip, at)).await?,
    ))
}

pub async fn clip_resize(State(st): St, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let track = parse_i64(&body["track"], "track")?;
    let clip = parse_i64(&body["clip"], "clip")?;
    let duration = parse_rat(&body["duration"], "duration")?;
    Ok(Json(
        with_engine(&st, move |e| ops::resize(e, track, clip, duration)).await?,
    ))
}

pub async fn clip_move(State(st): St, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let clip = parse_i64(&body["clip"], "clip")?;
    let from = parse_i64(&body["from"], "from")?;
    let to = parse_i64(&body["to"], "to")?;
    let index = parse_i64(&body["index"], "index")?;
    Ok(Json(
        with_engine(&st, move |e| ops::move_clip(e, clip, from, to, index)).await?,
    ))
}

pub async fn clip_remove(State(st): St, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let track = parse_i64(&body["track"], "track")?;
    let clip = parse_i64(&body["clip"], "clip")?;
    Ok(Json(
        with_engine(&st, move |e| ops::remove(e, track, clip)).await?,
    ))
}

pub async fn shape(State(st): St) -> Result<Json<Value>, ApiError> {
    Ok(Json(with_engine(&st, |e| Ok(ops::ok_shape(e))).await?))
}

pub async fn undo(State(st): St) -> Result<Json<Value>, ApiError> {
    Ok(Json(with_engine(&st, ops::undo).await?))
}

pub async fn redo(State(st): St) -> Result<Json<Value>, ApiError> {
    Ok(Json(with_engine(&st, ops::redo).await?))
}

// ---------------------------------------------------------------------------
// Frame render (PNG — real engine composite)
// ---------------------------------------------------------------------------
pub async fn frame(
    State(st): St,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let parse = |key: &str| -> Result<i64, ApiError> {
        q.get(key)
            .and_then(|v| v.parse::<i64>().ok())
            .ok_or_else(|| ApiError::bad_request("BadRequest", format!("{key} is required")))
    };
    let (num, den, w, h) = (parse("num")?, parse("den")?, parse("w")?, parse("h")?);
    if den <= 0 {
        return Err(ApiError::bad_request("BadRequest", "den must be > 0"));
    }
    if w <= 0 || h <= 0 || w > 16384 || h > 16384 {
        return Err(ApiError::bad_request(
            "BadRequest",
            "w/h must be within 1..=16384 (decoder input budget, RLW-9)",
        ));
    }
    let png = with_engine(&st, move |e| {
        ops::render_frame_png(e, Rational::new(num, den), w as u32, h as u32)
    })
    .await?;
    Ok((StatusCode::OK, [(header::CONTENT_TYPE, "image/png")], png).into_response())
}

// ---------------------------------------------------------------------------
// Exports (background jobs — honest indeterminate progress, audit gap #6)
// ---------------------------------------------------------------------------
fn renders_dir(st: &AppState) -> PathBuf {
    st.project_dir
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|d| d.join("renders"))
        .unwrap_or_else(|| st.data_root.join(".orphan-renders"))
}

fn start_job(
    st: &Arc<AppState>,
    kind: &'static str,
    f: impl FnOnce(&mut Engine) -> Result<Value, EngineError> + Send + 'static,
) -> Result<Json<Value>, ApiError> {
    // atomic take: job slot first, then engine slot
    {
        let mut job = st.job.lock().unwrap_or_else(|p| p.into_inner());
        if matches!(job.as_ref(), Some(JobState::Running { .. })) {
            return Err(ApiError::busy());
        }
        *job = Some(JobState::Running { kind });
    }
    let taken = st.engine.lock().unwrap_or_else(|p| p.into_inner()).take();
    let Some(mut engine) = taken else {
        *st.job.lock().unwrap_or_else(|p| p.into_inner()) = None;
        return Err(ApiError::no_session());
    };
    let arc = st.clone();
    tokio::task::spawn_blocking(move || {
        let result = f(&mut engine);
        // session back first, then job verdict (status readers expect this)
        *arc.engine.lock().unwrap_or_else(|p| p.into_inner()) = Some(engine);
        let mut job = arc.job.lock().unwrap_or_else(|p| p.into_inner());
        match result {
            Ok(mut v) => {
                if let Some(o) = v.as_object_mut() {
                    o.insert("ok".into(), json!(true));
                }
                *job = Some(JobState::Done(v));
            }
            Err(e) => {
                let (kind, message) = ops::error_parts(&e);
                *job = Some(JobState::Failed {
                    kind: kind.into(),
                    message,
                });
            }
        }
    });
    Ok(Json(json!({"ok": true, "started": true, "job": kind})))
}

pub async fn export_reencode(
    State(st): St,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let rate = parse_rat(&body.get("rate").cloned().unwrap_or(json!([24, 1])), "rate")?;
    let dir = renders_dir(&st);
    std::fs::create_dir_all(&dir).ok();
    let out = dir.join(format!(
        "composite-{}-{}.mp4",
        chrono_secs(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    start_job(&st, "composite", move |e| {
        ops::export_reencode(e, &out, rate.num(), rate.den())
    })
}

pub async fn export_copy(State(st): St, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let hash = body["hash"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("BadRequest", "hash is required"))?
        .to_string();
    let start = parse_rat(&body["start"], "start")?;
    let end = parse_rat(&body["end"], "end")?;
    let dir = renders_dir(&st);
    std::fs::create_dir_all(&dir).ok();
    let out = dir.join(format!(
        "segment-{}-{}.mp4",
        chrono_secs(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    start_job(&st, "segment", move |e| {
        ops::export_copy(e, &out, &hash, start, end)
    })
}

pub async fn export_wav(State(st): St) -> Result<Json<Value>, ApiError> {
    let dir = renders_dir(&st);
    std::fs::create_dir_all(&dir).ok();
    let out = dir.join(format!(
        "audio-{}-{}.wav",
        chrono_secs(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    start_job(&st, "wav", move |e| ops::export_wav(e, &out))
}

/// One-shot status read: `idle` → `running` → `done`/`failed` (consumed on
/// read). Done results carry path/size/sha256 + the whitelisted `file` name.
pub async fn export_status(State(st): St) -> Json<Value> {
    let mut job = st.job.lock().unwrap_or_else(|p| p.into_inner());
    match job.as_ref() {
        Some(JobState::Running { kind }) => {
            Json(json!({"ok": true, "running": true, "kind": kind}))
        }
        Some(JobState::Done(v)) => {
            let mut out = v.clone();
            if let Some(p) = v.get("path").and_then(|p| p.as_str()) {
                let base = std::path::Path::new(p)
                    .file_name()
                    .map(|b| b.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if !base.is_empty() {
                    st.renders
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .push(base.clone());
                    if let Some(o) = out.as_object_mut() {
                        o.insert("file".into(), json!(base));
                    }
                }
            }
            *job = None;
            Json(out)
        }
        Some(JobState::Failed { kind, message }) => {
            let out = json!({"ok": false, "running": false, "kind": kind, "message": message});
            *job = None;
            Json(out)
        }
        None => Json(json!({"ok": true, "idle": true})),
    }
}

/// Download an export this server produced (whitelist only — no path serving).
pub async fn render_download(
    State(st): St,
    AxPath(file): AxPath<String>,
) -> Result<Response, ApiError> {
    let whitelisted = st
        .renders
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(&file);
    if !whitelisted || file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "NotFound",
            "no such export",
        ));
    }
    let path = renders_dir(&st).join(&file);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "NotFound", "export file missing"))?;
    let mime = if file.ends_with(".wav") {
        "audio/wav"
    } else {
        "video/mp4"
    };
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            (header::CONTENT_DISPOSITION, "attachment"),
        ],
        bytes,
    )
        .into_response())
}

/// Server settings + honest product limitations (surfaced verbatim in the UI).
pub async fn settings(State(st): St) -> Json<Value> {
    Json(json!({
        "ok": true,
        "server": ops::SERVER_VERSION,
        "engine_pin": ops::ENGINE_PIN,
        "data_root": st.data_root.to_string_lossy(),
        "single_writer": true,
        "engine_busy": job_running(&st),
        "limitations": [
            "preview is silent stepped engine-rendered frames (no audio streaming API, gap #4)",
            "composite export shows indeterminate progress; engine exposes no percent and no cancel (gap #6)",
            "timeline shows labeled tiles, not thumbnails or waveforms (gap #7)",
            "multi-source timelines render the FIRST imported source (ADR-017 v1)",
            "audio retiming / speed changes are unsupported by the engine (typed AudioRetimeUnsupported)",
            "transitions, titles, filters and color grading do not exist in the engine v1",
            "one writer per project: a second browser tab shares the same engine session",
        ],
    }))
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
pub fn router(st: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/version", get(version))
        .route("/api/settings", get(settings))
        .route("/api/projects", get(projects_list))
        .route("/api/projects/create", post(projects_create))
        .route("/api/projects/open", post(projects_open))
        .route("/api/projects/close", post(projects_close))
        .route("/api/projects/delete", post(projects_delete))
        .route("/api/media/import", post(media_import))
        .route("/api/shape", get(shape))
        .route("/api/track/add", post(track_add))
        .route("/api/clip/add", post(clip_add))
        .route("/api/clip/split", post(clip_split))
        .route("/api/clip/resize", post(clip_resize))
        .route("/api/clip/move", post(clip_move))
        .route("/api/clip/remove", post(clip_remove))
        .route("/api/undo", post(undo))
        .route("/api/redo", post(redo))
        .route("/api/frame", get(frame))
        .route("/api/export/reencode", post(export_reencode))
        .route("/api/export/copy", post(export_copy))
        .route("/api/export/wav", post(export_wav))
        .route("/api/export/status", get(export_status))
        .route("/api/renders/{file}", get(render_download))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024 * 1024))
        .with_state(st)
}

// ---------------------------------------------------------------------------
// Embedded UI (rust-embed; empty folder → honest 404 + server runs API-only)
// ---------------------------------------------------------------------------
#[derive(rust_embed::RustEmbed)]
#[folder = "web-dist"]
struct Ui;

fn embedded_ui() -> Vec<String> {
    Ui::iter().map(|s| s.to_string()).collect()
}

async fn ui_file(path: &str) -> Response {
    match Ui::get(path) {
        Some(f) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, mime.as_ref())],
                f.data,
            )
                .into_response()
        }
        None => {
            if embedded_ui().iter().any(|f| f == "index.html") {
                if let Some(index) = Ui::get("index.html") {
                    return (
                        StatusCode::OK,
                        [(header::CONTENT_TYPE, "text/html")],
                        index.data,
                    )
                        .into_response();
                }
            }
            (
                StatusCode::NOT_FOUND,
                [(header::CONTENT_TYPE, "text/plain")],
                "UI not built. Run `npm ci && npm run build` in web/ and rebuild the server. The JSON API is live: see /api/version.",
            )
                .into_response()
        }
    }
}

async fn ui_handler_root() -> Response {
    ui_file("index.html").await
}

async fn ui_handler(AxPath(path): AxPath<String>) -> Response {
    let path = if path.is_empty() {
        "index.html".to_string()
    } else {
        path
    };
    ui_file(&path).await
}

pub fn ui_router() -> Router {
    Router::new()
        .route("/", get(ui_handler_root))
        .route("/{*path}", get(ui_handler))
}
