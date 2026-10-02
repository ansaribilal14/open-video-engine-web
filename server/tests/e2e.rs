//! Server e2e — the client's REAL integration proof on the host toolchain:
//! a live axum listener on 127.0.0.1:0, driven over actual HTTP with
//! multipart uploads, exactly like the browser does.
//!
//! Journeys (mirroring the Android client's e2e):
//! 1. `journey_mpeg4_fixture` — a deterministic mpeg4+aac fixture generated
//!    with ffmpeg; asserts the FULL pipeline through the HTTP API:
//!    create → import (multipart) → track/clip ops → undo/redo →
//!    frame PNG → composite export (job poll) → WAV export → segment
//!    stream-copy → reopen (hash equality).
//! 2. `journey_h264_real_media` — the certified NASA public-domain source
//!    (sha256 2d315daf…705f) when provided via OVE_E2E_MEDIA; asserts the
//!    recorded H.264 stream-copy typed capability limit (F4/F5).
//!
//! Media never enters git.

use std::path::PathBuf;

use ove_web::ops::ENGINE_PIN;
use ove_web::state::AppState;
use reqwest::multipart::Part;
use serde_json::{json, Value};

fn api(_base: &str) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .expect("client")
}

fn data_root(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ove-web-e2e-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("data root");
    d
}

async fn spawn_server(tag: &str) -> (String, PathBuf) {
    let root = data_root(tag);
    let st = std::sync::Arc::new(AppState::new(root.clone()));
    let app = ove_web::api::router(st).merge(ove_web::api::ui_router());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    (format!("http://{addr}"), root)
}

async fn get_json(base: &str, path: &str) -> Value {
    let r = reqwest::get(format!("{base}{path}")).await.expect("GET");
    assert_eq!(r.status(), 200, "GET {path}");
    r.json().await.expect("json")
}

async fn post_json(base: &str, path: &str, body: Value) -> (u16, Value) {
    let c = api(base);
    let r = c
        .post(format!("{base}{path}"))
        .json(&body)
        .send()
        .await
        .expect("POST");
    let status = r.status().as_u16();
    (status, r.json().await.expect("json"))
}

async fn assert_ok(base: &str, path: &str, body: Value, what: &str) -> Value {
    let (status, v) = post_json(base, path, body).await;
    assert_eq!(v["ok"], json!(true), "{what} failed (HTTP {status}): {v}");
    v
}

fn generate_mpeg4_fixture(out: &std::path::Path) -> bool {
    std::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x240:rate=24:duration=4",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=4",
            "-c:v",
            "mpeg4",
            "-q:v",
            "6",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-shortest",
        ])
        .arg(out)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn upload(base: &str, path: &std::path::Path, what: &str) -> Value {
    let bytes = std::fs::read(path).expect("read media");
    let part = Part::bytes(bytes)
        .file_name(path.file_name().unwrap().to_string_lossy().into_owned())
        .mime_str("video/mp4")
        .expect("mime");
    let form = reqwest::multipart::Form::new().part("file", part);
    let c = api(base);
    let r = c
        .post(format!("{base}/api/media/import"))
        .multipart(form)
        .send()
        .await
        .expect("upload");
    let v: Value = r.json().await.expect("json");
    assert_eq!(v["ok"], json!(true), "{what} failed: {v}");
    v
}

async fn poll_job(base: &str, what: &str) -> Value {
    for _ in 0..600 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let v = get_json(base, "/api/export/status").await;
        if v.get("running") == Some(&json!(true)) {
            continue;
        }
        if v.get("idle") == Some(&json!(true)) {
            panic!("{what}: job slot idle without result");
        }
        assert_eq!(v["ok"], json!(true), "{what} failed: {v}");
        return v;
    }
    panic!("{what}: timed out");
}

#[tokio::test]
async fn journey_mpeg4_fixture() {
    let (base, root) = spawn_server("journey").await;

    // 0. version surface
    let v = get_json(&base, "/api/version").await;
    assert_eq!(v["engine_pin"], json!(ENGINE_PIN));
    assert_eq!(v["server"], json!("0.1.0"));

    // 1. create project (tick axis 48000/1 — audio-rate ticks)
    let v = assert_ok(
        &base,
        "/api/projects/create",
        json!({"name": "e2e_proj"}),
        "create",
    )
    .await;
    let h0 = v["state_hash"].as_str().expect("state hash").to_string();
    assert!(!h0.is_empty());

    // 2. track + import REAL media (multipart staging → engine copy)
    assert_ok(&base, "/api/track/add", json!({"id": 1}), "add track").await;
    let fixture = std::env::temp_dir().join(format!("ove-web-fixture-{}.mp4", std::process::id()));
    assert!(
        generate_mpeg4_fixture(&fixture),
        "fixture generation (ffmpeg required)"
    );
    let v = upload(&base, &fixture, "import media").await;
    let hash = v["hash"].as_str().expect("asset hash").to_string();
    assert_eq!(hash.len(), 64, "BLAKE3-256 hex identity");
    let probe = &v["assets"][0]["probe"];
    let dur = probe["duration"].as_array().expect("duration").to_vec();
    assert_eq!(dur.len(), 2, "exact rational duration [num, den]");
    assert!(
        !probe["streams"].as_array().unwrap().is_empty(),
        "probe streams present"
    );
    // staging cleanup: no files left behind
    let staging = root.join(".staging");
    let leftover: Vec<_> = std::fs::read_dir(&staging).unwrap().collect();
    assert!(
        leftover.is_empty(),
        "staging dir must be empty after import"
    );

    // 3. two clips appended at track end (engine allocates ids)
    let dur_num = dur[0].as_i64().unwrap();
    let dur_den = dur[1].as_i64().unwrap();
    let v = assert_ok(
        &base,
        "/api/clip/add",
        json!({
            "track": 1, "hash": hash, "duration": [dur_num, dur_den], "source_in": [0, 1]
        }),
        "add clip 1",
    )
    .await;
    let clip1 = v["clip_id"].as_i64().unwrap();
    let v = assert_ok(
        &base,
        "/api/clip/add",
        json!({
            "track": 1, "hash": hash, "duration": [dur_num, dur_den], "source_in": [0, 1]
        }),
        "add clip 2",
    )
    .await;
    let _clip2 = v["clip_id"].as_i64().unwrap();

    // 4. exact-rational split at half of clip 1
    let half = (dur_num / 2, dur_den);
    let v = assert_ok(
        &base,
        "/api/clip/split",
        json!({
            "track": 1, "clip": clip1, "at": [half.0, half.1]
        }),
        "split",
    )
    .await;
    assert!(v["new_clip_id"].is_i64(), "split returns new clip id");

    // 5. resize (trim) — exact rational
    assert_ok(
        &base,
        "/api/clip/resize",
        json!({
            "track": 1, "clip": clip1, "duration": [dur_num / 4, dur_den]
        }),
        "resize",
    )
    .await;

    // 6. undo / redo (bool did + depth surfaced)
    let v = assert_ok(&base, "/api/undo", json!({}), "undo").await;
    assert_eq!(v["did"], json!(true));
    let v = assert_ok(&base, "/api/redo", json!({}), "redo").await;
    assert_eq!(v["did"], json!(true));
    let v = assert_ok(&base, "/api/undo", json!({}), "undo again").await;
    assert_eq!(v["did"], json!(true));
    assert!(v["undo_depth"].is_u64(), "undo depth present");
    let h_final = v["state_hash"].as_str().expect("state hash").to_string();

    // 7. per-frame render — real PNG bytes of the real composite
    let c = api(&base);
    let r = c
        .get(format!("{base}/api/frame?num=0&den=1&w=320&h=240"))
        .send()
        .await
        .expect("frame");
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["content-type"], "image/png");
    let png_bytes = r.bytes().await.expect("png");
    assert!(png_bytes.len() > 100, "non-trivial PNG payload");
    assert_eq!(&png_bytes[..8], b"\x89PNG\r\n\x1a\n", "PNG signature");
    // VERIFIED engine behavior (probed): render_frame at an out-of-coverage
    // time is renderer-defined — it returns a valid empty composite, NOT an
    // error (NoPlacement exists in the taxonomy but is not raised here). The
    // CLIENT constrains scrubbing to the timeline span.
    let r = c
        .get(format!("{base}/api/frame?num=999999&den=1&w=320&h=240"))
        .send()
        .await
        .expect("frame far");
    assert_eq!(r.status(), 200, "renderer-defined empty composite");
    let far: Value = r.json().await.unwrap_or(Value::Null);
    let _ = far; // PNG body; shape asserted above for in-coverage frames

    // 8. composite export (flagship path) as a background job, polled honestly
    assert_ok(
        &base,
        "/api/export/reencode",
        json!({"rate": [24, 1]}),
        "export start",
    )
    .await;
    // while running, session ops are honestly BUSY (job slot set before the
    // start response returns — deterministic)
    let (status, v) = post_json(&base, "/api/track/add", json!({"id": 9})).await;
    assert_eq!(status, 409, "session busy while export runs");
    assert_eq!(v["kind"], json!("EngineBusy"), "busy envelope");
    let v = poll_job(&base, "composite export").await;
    assert_eq!(v["kind"], json!("composite"));
    assert!(
        v["sha256"].as_str().expect("sha").len() == 64,
        "export sha256"
    );
    assert!(v["frames"].as_i64().expect("frames") > 0);
    let file = v["file"].as_str().expect("download name").to_string();
    // download the produced file over HTTP and verify its sha256 INDEPENDENTLY
    let c = api(&base);
    let r = c
        .get(format!("{base}/api/renders/{file}"))
        .send()
        .await
        .expect("download");
    assert_eq!(r.status(), 200);
    let bytes = r.bytes().await.expect("mp4 bytes");
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let got = format!("{:x}", hasher.finalize());
    assert_eq!(
        got,
        v["sha256"].as_str().unwrap(),
        "client-side sha256 verification"
    );
    // traversal protection
    let r = c
        .get(format!("{base}/api/renders/..%2Fregistry.json"))
        .send()
        .await
        .expect("traversal");
    assert_ne!(r.status(), 200, "path traversal blocked");

    // 9. WAV export (timeline audio mixdown)
    assert_ok(&base, "/api/export/wav", json!({}), "wav start").await;
    let v = poll_job(&base, "wav export").await;
    assert_eq!(v["kind"], json!("wav"));
    assert!(v["samples"].as_u64().expect("samples") > 0);

    // 10. segment stream-copy (mpeg4 fixture → copy route SUCCEEDS)
    assert_ok(
        &base,
        "/api/export/copy",
        json!({
            "hash": hash, "start": [0, 1], "end": [2, 1]
        }),
        "segment start",
    )
    .await;
    let v = poll_job(&base, "segment export").await;
    assert_eq!(v["kind"], json!("segment"));

    // 11. close + reopen → state hash identity (durability, P-2)
    assert_ok(&base, "/api/projects/close", json!({}), "close").await;
    let v = assert_ok(
        &base,
        "/api/projects/open",
        json!({"name": "e2e_proj"}),
        "reopen",
    )
    .await;
    assert_eq!(
        v["state_hash"].as_str().unwrap(),
        h_final,
        "reopen hash equality"
    );

    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_file(&fixture);
}

#[tokio::test]
async fn journey_h264_real_media() {
    let Ok(media) = std::env::var("OVE_E2E_MEDIA") else {
        eprintln!("OVE_E2E_MEDIA not set — NASA journey skipped (CI runs the fixture journey)");
        return;
    };
    if !std::path::Path::new(&media).exists() {
        eprintln!("OVE_E2E_MEDIA path missing — journey skipped");
        return;
    }
    let (base, root) = spawn_server("h264").await;
    assert_ok(
        &base,
        "/api/projects/create",
        json!({"name": "h264_proj"}),
        "create",
    )
    .await;
    assert_ok(&base, "/api/track/add", json!({"id": 1}), "add track").await;
    let v = upload(&base, std::path::Path::new(&media), "import NASA").await;
    let hash = v["hash"].as_str().unwrap().to_string();

    // H.264 stream-copy → TYPED capability rejection (codec capability matrix,
    // audit F4/F5) — surfaced as a typed error, never faked as success.
    let (status, _v) = post_json(
        &base,
        "/api/export/copy",
        json!({
            "hash": hash, "start": [0, 1], "end": [1, 1]
        }),
    )
    .await;
    assert_eq!(status, 200, "job accepted");
    let v = poll_job(&base, "h264 segment").await;
    assert_eq!(
        v["ok"],
        json!(false),
        "h264 stream-copy must be typed-rejected: {v}"
    );
    assert_eq!(v["kind"], json!("ExportFailed"), "typed capability limit");

    // …while the composite re-encode route is the supported path.
    assert_ok(
        &base,
        "/api/export/reencode",
        json!({"rate": [24, 1]}),
        "composite start",
    )
    .await;
    let v = poll_job(&base, "h264 composite").await;
    assert_eq!(
        v["ok"],
        json!(true),
        "composite export must succeed on real media: {v}"
    );
    assert!(v["sha256"].as_str().unwrap().len() == 64);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn boundary_guards() {
    let (base, root) = spawn_server("guards").await;
    // no session → typed NoSession
    let (status, v) = post_json(&base, "/api/undo", json!({})).await;
    assert_eq!(status, 409);
    assert_eq!(v["kind"], json!("NoSession"));
    // invalid rational (den <= 0) → 400 BadRequest, never an engine panic
    assert_ok(
        &base,
        "/api/projects/create",
        json!({"name": "guards"}),
        "create",
    )
    .await;
    assert_ok(&base, "/api/track/add", json!({"id": 1}), "track").await;
    let (status, v) = post_json(
        &base,
        "/api/clip/add",
        json!({
            "track": 1, "hash": "00", "duration": [1, 0], "source_in": [0, 1]
        }),
    )
    .await;
    assert_eq!(status, 400, "den<=0 rejected at the boundary");
    assert_eq!(v["kind"], json!("BadRequest"));
    // bad project name → 400
    let (status, _) = post_json(&base, "/api/projects/create", json!({"name": "../evil"})).await;
    assert_eq!(status, 400);
    let _ = std::fs::remove_dir_all(&root);
}
