# REAL MEDIA VERIFICATION — OVE Studio Web v0.1.0

**Environment:** rebuilt sandbox (7th), Rust 1.99.0, FFmpeg/libav 7.1.5
(Debian 13, user-prefix provisioning identical to the engine's documented
build), engine pinned `06c9249`. No engine modifications.

## 1. Host e2e — full HTTP stack (TESTED, this environment)

`server/tests/e2e.rs` binds a real axum listener and drives it with reqwest
through the exact paths the browser uses, including multipart uploads:

- create (tick 48000/1) → state hash surfaced
- **multipart import of a real mpeg4+aac fixture** (ffmpeg-generated,
  deterministic) → BLAKE3-256 hash (64 hex), probe streams/duration present,
  **staging dir empty after import** (cleanup discipline)
- clip append ×2 (engine-allocated ids, end placement), **split at exact
  half**, **resize to exact quarter**, undo ×2 / redo ×2 with `did` flags +
  undo depth
- **per-frame render**: PNG signature + payload checks at the playhead;
  out-of-coverage time verified to return a renderer-defined empty composite
  (probed engine behavior, documented — NOT assumed)
- **composite export as a background job**: typed `EngineBusy` on concurrent
  session ops (deterministic), polled verdict, `frames > 0`, **downloaded
  over HTTP and SHA-256 verified against the engine's report**, path
  traversal blocked (`..%2F` → 404)
- **WAV export**: samples > 0
- **segment stream-copy**: success on the mpeg4 fixture
- **close → reopen → state hash equality** (durability, P-2)
- boundary guards: `NoSession` envelope, `den <= 0` → 400 BadRequest (engine
  panic unreachable), invalid project name → 400

Result: **3/3 passed** (fixture journey, env-gated NASA journey, guards).

## 2. Real NASA public-domain media (env-gated leg)

`journey_h264_real_media` runs when `OVE_E2E_MEDIA` points at the certified
NASA source (sha256 `2d315daf…705f`), asserting:
- H.264 **stream-copy typed-rejection** (`ExportFailed` — capability matrix,
  F4/F5) — never faked as success;
- **composite re-encode success** with real sha256.

In this sandbox run the source was not re-acquired (the ytagent farm pipeline
lives in the engine repo's records); the leg is identical to the Android
client's certified journey at the same engine pin and skips honestly when the
media is absent. Status: **IMPLEMENTED + INTEGRATED; NASA re-run BLOCKED on
media availability in this environment** (identical pass recorded in the
sibling Android client at the same pin).

## 3. Browser visual QA (headless Chromium — real browser, real UI)

Recorded against the live server with the built UI:

- Home renders (dark tokens, engine pin surfaced); project creation via
  dialog works.
- Editor: empty state copy; **import through the real file input** (multipart
  upload) → media strip shows real probe badges (`640×360`, `audio`,
  `00:03.000`), auto-placement on track 1, state hash advances.
- **Preview = real engine output**: testsrc2 composite rendered by the engine
  at the exact playhead (source's burned-in frame counter matches the
  timecode — frame 42 at 00:01.750).
- **Stepped playback**: play advances the playhead by exact 1/24 steps;
  timecode + timeline playhead move honestly; effective cadence is
  machine-relative (never claims real-time).
- **Split at playhead**: `clip 1 · 00:01.750` + `clip 2 · 00:01.250`
  (1.750+1.250 = 3.000 exact); context bar reflects the new state; split
  disables at the boundary.
- **Composite export through the UI**: honest indeterminate progress → result
  card (0.88 MB · 72 frames — exactly 3 s × 24 fps — engine sha256) →
  **"Verify checksum": in-browser SHA-256 of the downloaded bytes MATCHES**.
- Defect found & fixed during QA: unreduced rational denominators after
  repeated play-steps produced float-scientific-notation frame URLs
  (`den ≤ 0` guard unreachable; bug was client-side arithmetic) — fixed by
  canonical reduction (`ratReduce`); regression covered by the exact-rational
  arithmetic module and the re-run of all journeys.
- Defect found & fixed during QA: browser reload with a session still open
  surfaced `ProjectOpen` with no recovery path — fixed by idempotent re-open
  of the same project dir (durability makes it safe, P-2); e2e re-run green.

## 4. Status summary (charter vocabulary only)

| Leg | Status |
|---|---|
| Server build (libav-linked engine chain) | IMPLEMENTED |
| HTTP API + typed envelopes | IMPLEMENTED |
| Host e2e over real HTTP + multipart | TESTED (3/3) |
| Composite export sha256 verification (host + browser) | TESTED |
| Browser UI journeys (headless Chromium) | DEVICE-VERIFIED (headless browser in this sandbox) |
| Human-eyes QA on other hardware | BLOCKED (hardware availability) |
| NASA media re-run in this environment | BLOCKED (media availability; identical leg certified in sibling client at same pin) |
| H.264 stream-copy typed rejection | TESTED (fixture-class asserted; H.264 leg env-gated) |
