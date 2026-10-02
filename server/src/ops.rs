//! Engine operations — a 1:1 web mirror of the Android bridge's `ops` module
//! (bridge/src/lib.rs in the Android client), parameterized by `&mut Engine`.
//!
//! DESIGN CONTRACT (docs/ENGINE_INTEGRATION_AUDIT.md):
//! * This crate is a CLIENT of the engine library — the same session surface
//!   `ove-cli` consumes. It contains ZERO engine behavior.
//! * All times cross the boundary as exact rationals `[num, den]` — floats
//!   are forbidden (the engine rejects float tick axes at load — P-5).
//! * Typed `EngineError` → `{kind, message}` at the boundary (audit §8).
//! * The engine's security budgets (ADR-022, RLW-9) run inside the session;
//!   this server adds no bypass and no pre-validation shortcuts.

use serde_json::{json, Value};

use ove_engine::{Engine, EngineError};
use ove_render::OutputSpec;
use ove_time::Rational;

pub const ENGINE_PIN: &str = "06c92496f7051f15069663296ec51e88e170fe18";
pub const SERVER_VERSION: &str = "0.1.0";

// ---------------------------------------------------------------------------
// Typed error mapping (EngineError -> {kind, message}) — audit §8
// ---------------------------------------------------------------------------
pub fn error_parts(e: &EngineError) -> (&'static str, String) {
    match e {
        EngineError::Project(d) => ("Project", d.to_string()),
        EngineError::Import(d) => ("ImportRejected", d.clone()),
        EngineError::UnknownAsset(d) => ("UnknownAsset", d.clone()),
        EngineError::Timeline(d) => ("TimelineError", format!("{d:?}")),
        EngineError::Render(d) => ("RenderFailed", format!("{d:?}")),
        EngineError::Compile(d) => ("RenderFailed", format!("{d:?}")),
        EngineError::Encode(d) => ("ExportFailed", format!("{d:?}")),
        EngineError::Mux(d) => ("ExportFailed", format!("{d:?}")),
        EngineError::Seam(d) => ("SeamError", format!("{d:?}")),
        EngineError::NoPlacement { at } => ("NothingAtTime", format!("no placement covers t={at}")),
        EngineError::NoAudioStream => (
            "NoAudioStream",
            "no audio stream in the imported sources".into(),
        ),
        EngineError::NonExactSampleCut { at, rate } => (
            "NonSampleExactCut",
            format!("audio cut t={at} is not sample-exact at {rate} Hz"),
        ),
        EngineError::AudioRetimeUnsupported { speed } => (
            "RetimeUnsupported",
            format!("audio retime x{speed} unsupported in v1 (named gap)"),
        ),
        EngineError::KeyframeValueOutOfRange {
            clip_id,
            property,
            value,
        } => (
            "KeyframeRange",
            format!("clip {clip_id} keyframed {property} value {value} leaves i32 pixel range"),
        ),
        EngineError::Internal(d) => ("EngineInternal", d.clone()),
    }
}

// ---------------------------------------------------------------------------
// JSON helpers — exact rationals as [num, den]
// ---------------------------------------------------------------------------
fn rat(r: &Rational) -> Value {
    json!([r.num(), r.den()])
}

fn opt_rat(r: &Option<Rational>) -> Value {
    match r {
        Some(v) => rat(v),
        None => Value::Null,
    }
}

/// Probe JSON from the engine's in-memory probe record (`SourceMedia.probe`)
/// — the same data the engine persists as the documented
/// `assets/<hash>/probe.json` sidecar.
fn probe_json(p: &ove_media::ProbeInfo) -> Value {
    let streams: Vec<Value> = p
        .streams
        .iter()
        .map(|s| {
            json!({
                "kind": format!("{:?}", s.kind),
                "codec": s.codec,
                "time_base": rat(&s.time_base),
                "duration": opt_rat(&s.duration),
                "avg_frame_rate": opt_rat(&s.avg_frame_rate),
                "video": s.video.as_ref().map(|v| json!({
                    "width": v.width,
                    "height": v.height,
                })),
                "audio": s.audio.as_ref().map(|a| json!({
                    "sample_rate": a.sample_rate,
                    "channels": a.channels,
                })),
            })
        })
        .collect();
    json!({
        "duration": opt_rat(&p.duration),
        "streams": streams,
    })
}

fn first_video_geometry(e: &Engine) -> Option<(u32, u32, Option<Rational>, bool)> {
    // first imported source (the render-binding source, ADR-017), its video
    // stream geometry + duration, and whether any audio stream exists.
    let hashes: Vec<String> = e
        .project()
        .assets()
        .iter()
        .map(|a| a.content_hash.clone())
        .collect();
    let render_hash = hashes.iter().min()?.clone();
    let media = e.source(&render_hash)?;
    let mut video = None;
    let mut audio = false;
    for s in &media.probe.streams {
        match s.kind {
            ove_media::StreamKind::Video => {
                if video.is_none() {
                    if let Some(v) = &s.video {
                        video = Some((v.width, v.height, s.duration));
                    }
                }
            }
            ove_media::StreamKind::Audio => audio = true,
            _ => {}
        }
    }
    let (w, h, dur) = video?;
    Some((w, h, dur, audio))
}

/// UI projection of the live document. The engine remains authoritative —
/// `state_hash` is verified by the client after every mutation batch.
pub fn shape(e: &Engine) -> Value {
    let assets: Vec<Value> = e
        .project()
        .assets()
        .iter()
        .map(|a| {
            let probe = e.source(&a.content_hash).map(|m| probe_json(&m.probe));
            json!({"id": a.id, "hash": a.content_hash, "probe": probe})
        })
        .collect();
    let mut tracks = Vec::new();
    let mut span = Rational::new(0, 1);
    for tid in e.project().timeline().track_ids() {
        let tref = match e.project().timeline().track_ref(tid) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let mut clips = Vec::new();
        tref.walk(&mut |_pos, start, clip| {
            let end = start.add(clip.duration);
            // exact cross-denominator max via i128 cross-multiply
            let a = i128::from(end.num()) * i128::from(span.den());
            let b = i128::from(span.num()) * i128::from(end.den());
            if a > b {
                span = end;
            }
            clips.push(json!({
                "id": clip.id,
                "start": rat(&start),
                "duration": rat(&clip.duration),
                "source_in": rat(&clip.source_in),
            }));
        });
        tracks.push(json!({"id": tid, "clips": clips}));
    }
    let hashes: Vec<String> = e
        .project()
        .assets()
        .iter()
        .map(|a| a.content_hash.clone())
        .collect();
    let render_source = hashes.iter().min().cloned();
    let multi_source = hashes.len() > 1;
    json!({
        "state_hash": e.state_hash(),
        "undo_depth": e.project().undo_depth(),
        "assets": assets,
        "tracks": tracks,
        "timeline_span": rat(&span),
        "render_source": render_source,
        // ADR-017 v1 note: multi-source timelines render the FIRST imported
        // source. Surfaced so the UI can state the limitation truthfully.
        "multi_source_limit": multi_source,
    })
}

pub fn ok_shape(e: &Engine) -> Value {
    let s = shape(e);
    let mut out = json!({"ok": true});
    if let (Some(o), Some(s)) = (out.as_object_mut(), s.as_object()) {
        for (k, v) in s {
            o.insert(k.clone(), v.clone());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Operations (each takes the engine session; HTTP layer provides the lock)
// ---------------------------------------------------------------------------
pub fn import_media(e: &mut Engine, path: &std::path::Path) -> Result<Value, EngineError> {
    let hex = e.import_media(path)?;
    let mut out = ok_shape(e);
    out["hash"] = Value::String(hex);
    Ok(out)
}

pub fn add_track(e: &mut Engine, id: i64) -> Result<Value, EngineError> {
    use ove_timeline::{GapTrack, TrackKind};
    e.add_track(id as u64, TrackKind::Gap(GapTrack::new()))?;
    Ok(ok_shape(e))
}

pub fn add_clip(
    e: &mut Engine,
    track: i64,
    hash: &str,
    dur: Rational,
    src_in: Rational,
) -> Result<Value, EngineError> {
    let clip_id = e.add_clip(track as u64, hash, dur, src_in)?;
    let mut out = ok_shape(e);
    out["clip_id"] = json!(clip_id);
    Ok(out)
}

pub fn split(e: &mut Engine, track: i64, clip: i64, at: Rational) -> Result<Value, EngineError> {
    let new_id = e.split(track as u64, clip as u64, at)?;
    let mut out = ok_shape(e);
    out["new_clip_id"] = json!(new_id);
    Ok(out)
}

pub fn resize(
    e: &mut Engine,
    track: i64,
    clip: i64,
    duration: Rational,
) -> Result<Value, EngineError> {
    e.resize(track as u64, clip as u64, duration)?;
    Ok(ok_shape(e))
}

pub fn move_clip(
    e: &mut Engine,
    clip: i64,
    from: i64,
    to: i64,
    index: i64,
) -> Result<Value, EngineError> {
    e.move_clip(clip as u64, from as u64, to as u64, index as usize)?;
    Ok(ok_shape(e))
}

pub fn remove(e: &mut Engine, track: i64, clip: i64) -> Result<Value, EngineError> {
    e.remove(track as u64, clip as u64)?;
    Ok(ok_shape(e))
}

pub fn undo(e: &mut Engine) -> Result<Value, EngineError> {
    let did = e.undo()?;
    let mut out = ok_shape(e);
    out["did"] = json!(did);
    Ok(out)
}

pub fn redo(e: &mut Engine) -> Result<Value, EngineError> {
    let did = e.redo()?;
    let mut out = ok_shape(e);
    out["did"] = json!(did);
    Ok(out)
}

/// Render one frame at exact time `t` and encode it as PNG (RGBA8).
/// Real engine composite — the web preview's ground truth, same as the
/// Android client's Bitmap path (audit §4 "Per-frame render").
pub fn render_frame_png(
    e: &mut Engine,
    t: Rational,
    w: u32,
    h: u32,
) -> Result<Vec<u8>, EngineError> {
    let output = OutputSpec {
        width: w,
        height: h,
        rate_num: 24,
        rate_den: 1,
        working_space: bt709_limited(),
    };
    let frame = e.render_frame(&output, t)?;
    let (fw, fh) = (frame.width, frame.height);
    if fw != w || fh != h {
        return Err(EngineError::Internal(format!(
            "rendered frame {fw}x{fh} does not match requested {w}x{h}"
        )));
    }
    let bytes = frame
        .cpu_bytes()
        .ok_or_else(|| EngineError::Internal("render produced no CPU frame".into()))?
        .data
        .clone();
    // row copy honoring the source stride, output tightly packed RGBA
    let stride = bytes.len() / fh as usize;
    let mut packed = vec![0u8; (fw as usize) * (fh as usize) * 4];
    for row in 0..fh as usize {
        let src = row * stride;
        let dst = row * (fw as usize) * 4;
        packed[dst..dst + (fw as usize) * 4].copy_from_slice(&bytes[src..src + (fw as usize) * 4]);
    }
    let mut png_buf = std::io::Cursor::new(Vec::new());
    {
        let mut enc = png::Encoder::new(&mut png_buf, fw, fh);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc
            .write_header()
            .map_err(|err| EngineError::Internal(format!("png header failed: {err}")))?;
        writer
            .write_image_data(&packed)
            .map_err(|err| EngineError::Internal(format!("png encode failed: {err}")))?;
    }
    Ok(png_buf.into_inner())
}

/// Composite timeline export (the engine's certified flagship path):
/// render every output frame → MPEG4 CRF6 bitexact + AAC → MP4.
pub fn export_reencode(
    e: &mut Engine,
    out: &std::path::Path,
    rate_num: i64,
    rate_den: i64,
) -> Result<Value, EngineError> {
    let (w, h, _dur, _audio) = first_video_geometry(e)
        .ok_or_else(|| EngineError::Import("no video stream in the first source".into()))?;
    let output = OutputSpec {
        width: w,
        height: h,
        rate_num,
        rate_den,
        working_space: bt709_limited(),
    };
    // n_frames from the exact timeline span: ceil(span * rate) — i128 cross-multiply
    let s = shape(e);
    let span = s["timeline_span"].as_array().unwrap();
    let sn = span[0].as_i64().unwrap();
    let sd = span[1].as_i64().unwrap();
    let num = i128::from(sn) * i128::from(rate_num);
    let den = i128::from(sd) * i128::from(rate_den);
    let n_frames = num.div_euclid(den) + if num.rem_euclid(den) > 0 { 1 } else { 0 };
    if n_frames <= 0 || n_frames > i64::MAX as i128 {
        return Err(EngineError::Internal(
            "computed frame count out of range".into(),
        ));
    }
    let info = e.export_reencode(out, &output, n_frames as i64)?;
    Ok(json!({
        "kind": "composite",
        "path": info.path.to_string_lossy(),
        "sha256": info.file_sha256,
        "size": info.file_size,
        "frames": n_frames,
        "state_hash": e.state_hash(),
    }))
}

/// Segment stream-copy export (keyframe-aligned; snap records reported).
pub fn export_copy(
    e: &mut Engine,
    out: &std::path::Path,
    hash: &str,
    start: Rational,
    end: Rational,
) -> Result<Value, EngineError> {
    let (info, snaps) = e.export_copy(hash, start, end, out)?;
    Ok(json!({
        "kind": "segment",
        "path": info.path.to_string_lossy(),
        "sha256": info.file_sha256,
        "size": info.file_size,
        "snaps": snaps.len(),
    }))
}

/// Timeline audio mixdown → WAV (planar f32 → samples).
pub fn export_wav(e: &mut Engine, out: &std::path::Path) -> Result<Value, EngineError> {
    let samples = e.export_wav(out)?;
    Ok(json!({
        "kind": "wav",
        "path": out.to_string_lossy(),
        "samples": samples,
    }))
}

pub fn bt709_limited() -> ove_media::ColorTags {
    ove_media::ColorTags {
        primaries: ove_media::Primaries::Bt709,
        transfer: ove_media::Transfer::Bt709,
        matrix: ove_media::MatrixCoeffs::Bt709,
        range: ove_media::Range::Limited,
        chroma_loc: Some(ove_media::ChromaLoc::Left),
    }
}
