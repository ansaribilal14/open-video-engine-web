# ENGINE INTEGRATION AUDIT — Web client of Open Video Engine

**Date:** 2026-10-02 · **Auditor:** Web client takeover (Phase 0)
**Method:** read-only inspection of the live engine repository, its normative specs,
and its crate sources. **The engine repository was NOT modified and will not be
modified.** No feature below is inferred from a name: every claim cites the exact
interface inspected. This audit inherits the Android client's audit
(`open-video-engine-android/docs/ENGINE_INTEGRATION_AUDIT.md`, same engine commit)
and states the web-specific deltas.

---

## 1. Engine identity inspected

| Item | Value |
|---|---|
| Repository | `https://github.com/ansaribilal14/open-video-engine` (public) |
| Commit inspected | **`06c9249`** (branch `main`, worktree clean) — code-identical to `v0.2.0` |
| Release pointers | `v0.1.0` → `bee72c5` · `v0.2.0` → `4173211` |
| CI at HEAD | 5/5 jobs green (verified via authenticated API in the takeover round) |
| Engine dependency pin for this client | **exact commit `06c9249`**, enforced by `server/fetch-engine.sh` (hash-checked detached checkout) |
| License | engine own code `MIT OR Apache-2.0`; libav linked under the LGPL-compatible configuration, confined by CI to `{ove-decode, ove-encode}` (ADR-015) |
| Sibling client | `open-video-engine-android` v0.1.0 (same pin, same library surface) — its audit findings F-1..F-7 carry over verbatim |

## 2. Consumed surface (verified, library session)

The web client consumes the **same `ove-engine` library session** as every
engine-shipped client (`create / open / import_media / add_track / add_clip /
split / resize / move_clip / remove / undo / redo / state_hash / project /
render_frame / export_reencode / export_copy / export_wav`), exactly as
`ove-cli` consumes it. Decisive carried-over findings: F-1 (composite export is
library-only), F-2 (typed errors library-only), F-3/F-6 (clip layout from
`project()` accessors; `add_clip` end-placement), F-4 (documented project
format), F-7 (kill-safe durability).

**Web transport decision:** a local HTTP JSON API hosted by a Rust server
binary (`ove-web`) that OWNS the engine session. Alternatives rejected:

- **Pure WASM in the browser** — the engine's wasm32-wasip1 CI leg proves the
  *pure-Rust core* compiles, but libav does not: decode/encode
  (`ove-decode`/`ove-encode`, ADR-015 allowlist) cannot run in a WASM sandbox.
  A browser-only build would be an editor that cannot import or export real
  media — i.e., a fake. Rejected.
- **Speaking MCP to `ove-mcp`** — loses typed errors (F-2), clip layout (F-3),
  and the certified composite export (F-1). Rejected as the primary path.
- **Bundling `ove-cli` + scraping output** — same three losses. Rejected.

The server is a **client of the library**, pins the engine by commit, and ships
zero engine code modifications. The engine repo is never copied into this
repository's history.

## 3. Verified engine behaviors this client builds on (probed, not assumed)

| Behavior | Evidence |
|---|---|
| `render_frame` at an out-of-coverage time returns a valid (empty) composite — it does **not** raise `NoPlacement` | probed on host (HTTP probe, t=999999 → 200, valid PNG). The CLIENT constrains scrubbing to the timeline span. `NoPlacement` remains mapped in the error table (defensive, taxonomy-1:1). |
| `Rational::new` panics on `den <= 0` | `ove-time/src/lib.rs:66` (`assert!(den > 0)`). The HTTP boundary validates and returns typed `BadRequest` BEFORE any engine call — a panic can never be triggered by a request. |
| `Project::undo_depth()` is public; no `redo_depth()` accessor exists | `ove-project/src/lib.rs:363`. The shape projection exposes `undo_depth` only. |
| Engine `Clip` has no asset reference (ADR-017 v1 render-binding: first imported source) | `ove-timeline/src/lib.rs:43-48` (`Clip { id, duration, source_in, properties }`). Segment exports target the project's first source; the UI states this limitation. |
| `export_copy` H.264 stream-copy typed rejection | carried from the Android audit F-4/F-5 (codec capability matrix); asserted in the sibling client's e2e and in this repo's `journey_h264_real_media` (env-gated on real media). |

## 4. Supported operations (HTTP surface, engine-authoritative)

| Route | Engine interface | Notes |
|---|---|---|
| `POST /api/projects/create` | `Engine::create(dir, tick_axis)` | tick axis `48000/1` (shared client decision) |
| `POST /api/projects/open` | `Engine::open(dir)` | **idempotent re-open of the same dir** (browser reload; state is durable per P-2) |
| `POST /api/projects/close` / `DELETE` via `/delete` | session drop / folder removal | registry is a documented CLIENT-side structure (gap #9) |
| `POST /api/media/import` (multipart) | `import_media(path)` | staged upload → engine content-addressed copy → staging deleted (Android §11 discipline) |
| `GET /api/shape` | `project()` accessors | UI projection `{tracks, clips, assets+probe, timeline_span, state_hash, undo_depth, multi_source_limit}` |
| `POST /api/track/add`, `/api/clip/add|split|resize|move|remove` | library verbs | exact rationals `[num, den]` |
| `POST /api/undo`, `/api/redo` | `undo() / redo()` | `did: bool` |
| `GET /api/frame?num&den&w&h` | `render_frame(OutputSpec, t)` | deterministic software composite → PNG (RGBA8); `w/h` bounded 1..=16384 (RLW-9 mirror) |
| `POST /api/export/reencode` | `export_reencode` | composite MP4 (MPEG4 CRF6 bitexact + AAC) — the certified flagship path; runs as a polled background job |
| `POST /api/export/copy` | `export_copy` | keyframe-aligned segment stream-copy; H.264 typed-rejected |
| `POST /api/export/wav` | `export_wav` | timeline audio mixdown |
| `GET /api/export/status`, `GET /api/renders/{file}` | — | one-shot job verdict; downloads whitelisted per-export (no path serving) |

## 5. Unsupported operations (engine reality — never faked in UI)

Carried over from the Android audit §5, unchanged: audio retiming/speed
(typed `AudioRetimeUnsupported`), H.264 stream-copy (typed capability limits),
transitions/titles/filters/grading (no engine feature), hardware codecs
(software renderer by design), multi-writer projects, GPL codec packs.
Keyframe editing (engine `Command::SetKeyframes`) is not shipped as UI in
v0.1.0 — no control is shown.

## 6. Concurrency model (web-specific)

- One engine session per server process in a `std::sync::Mutex` (single-writer
  v1). All engine calls run on the blocking pool with the guard moved in —
  the async runtime never holds the lock across an await.
- Composite/WAV/segment exports run as background jobs that TAKE the engine
  out of the slot for their whole duration; every other session route returns
  typed `EngineBusy` (HTTP 409) while a job runs. The UI presents honest
  indeterminate progress and no cancel control (gap #6).
- Multiple browser tabs share the one session — surfaced verbatim in
  Settings ("one writer per project").

## 7. Serialization / protocol

- Exact rationals as `[num, den]` i64 pairs end-to-end; `den <= 0` rejected at
  the boundary; the engine rejects float tick axes (P-5). The frontend keeps
  ALL engine-bound values in exact integer math (`rational.ts`, BigInt
  cross-multiplication); floats are used only for pixel layout and are never
  sent back. A canonical-reduction rule (`ratReduce`) keeps repeated play-step
  arithmetic from denormalizing denominators (found and fixed during device
  QA: unreduced 24^66 denominators after 66 play steps).
- Errors: one envelope `{"ok":false,"kind":...,"message":...}` for BOTH client
  guards (`BadRequest`, `EngineBusy`, `NoSession`, `ProjectOpen`,
  `ProjectExists`, `StorageError`) and the typed engine mapping (§8 of the
  Android audit, carried over 1:1).
- Frames cross the boundary as PNG bytes (never JSON — E-006a).

## 8. Security posture

- The engine's untrusted-input budgets (ADR-022) and decoder input budgets
  (RLW-9: `DECODE_MAX_DIM=16384`, `DECODE_MAX_PIXELS=2^25`) run inside the
  session; the server adds no bypass. The HTTP boundary additionally bounds
  frame requests to 1..=16384 (RLW-9 mirror, typed `BadRequest`).
- Server binds `127.0.0.1` by default (local single-user tool). Downloads are
  served only from a whitelist of files this server produced; project names
  and upload filenames are sanitized; `projects/delete` requires a closed
  session.
- No secrets, tokens, or keystores in the repository.

## 9. Known integration limitations (explicit)

1. Preview is stepped engine-rendered PNGs (honest cadence, machine-relative)
   with NO audio (gap #4: no streaming audio API). Never presented as
   real-time video playback.
2. Export progress is honestly indeterminate; no cancel (gap #6).
3. Timeline tiles show real clip metadata, not thumbnails/waveforms (gap #7).
4. Multi-source timelines render the FIRST imported source (ADR-017 v1) —
   surfaced in the editor and Settings.
5. The project registry (`registry.json`) is client-side structure (gap #9),
   never presented as an engine feature.
6. The server is the single writer; concurrent browser tabs share the session.
7. Browser-side device verification (this sandbox): performed in headless
   Chromium (real browser, real UI, real HTTP) — recorded in
   `docs/REAL_MEDIA_VERIFICATION.md`. Human-eyes QA on arbitrary hardware
   remains the user's step; nothing here claims more than was run.

## 10. Evidence index

- `server/fetch-engine.sh` (pin enforcement) · `server/src/ops.rs` (engine
  surface mirror + error mapping) · `server/src/api.rs` (HTTP boundary,
  guards, jobs) · `server/src/state.rs` (session/job slots)
- `server/tests/e2e.rs` (full-stack journeys over real HTTP + multipart)
- `web/src/rational.ts` (exact client-side time) · `web/src/api.ts` (typed
  client) · `web/src/components/Timeline.tsx` (canvas timeline) ·
  `web/src/components/ExportSheet.tsx` (honest export UX + sha256 verify)
- Engine: `engine/ove-engine/src/lib.rs`, `engine/ove-time/src/lib.rs`,
  `engine/ove-project/src/lib.rs`, `engine/ove-timeline/src/lib.rs`,
  `engine/ove-media/src/frame.rs`
