# OVE Studio Web — browser editor for the Open Video Engine

**An independent client of [Open Video Engine](https://github.com/ansaribilal14/open-video-engine)**:
a single-binary local server that hosts the real engine session and serves a
production-grade editing UI in your browser. The engine is a **read-only
dependency pinned by commit** — this repository contains zero engine code and
zero engine behavior.

```
Browser (React SPA — this repo, web/)
  → HTTP JSON API (exact rationals [num,den], typed error envelopes)
    → ove-web server (Rust, axum — this repo, server/)
      → ove-engine session (engine repo, pinned 06c9249)
        → ove-decode / ove-encode (libav, LGPL config, ADR-015)
```

## What it does (all real, nothing simulated)

- **Projects** — create/open/delete engine-authoritative project folders
  (documented `PROJECT_FORMAT_SPEC` format; durability: every mutation is
  durable the moment the engine call returns).
- **Media import** — upload from the browser (real transfer progress), the
  engine copies into its content-addressed store and probes it (streams,
  codecs, dimensions, exact duration).
- **Editor** — preview of **real engine-rendered composites** (stepped, honest
  cadence, silent — stated on-screen), exact-rational timecode, canvas
  timeline with ruler/tracks/clips/selection/trim-handles/playhead/zoom.
- **Clip controls** — split at playhead, trim (exact rational), move across
  tracks (post-state index), delete — all engine verbs, all typed errors.
- **Exports** — composite MP4 (the engine's certified flagship route: every
  frame rendered → MPEG4 CRF6 + AAC), WAV mixdown, keyframe-aligned segment
  stream-copy. Honest indeterminate progress (the engine exposes no percent
  and no cancel). Results verified **in-browser via SHA-256** before download.
- **Settings/diagnostics** — engine pin, data root, single-writer notice, and
  the honest limitations list.

Run:

```sh
./ove-web-linux-x86_64          # → http://127.0.0.1:8787/
# env: OVE_WEB_DATA=<data-root>  OVE_WEB_PORT=<port>
```

## Hosted UI (Netlify) — connect the hosted editor to YOUR local engine

The editor UI is also served from <https://ove-studio.netlify.app>. The engine
itself cannot run in a browser (libav is native code) — the hosted page is a
remote control for an `ove-web` server that YOU run on your own machine.
Cross-origin access is a deliberate, explicit opt-in:

```sh
# 1. start your local server, allowing the hosted page's origin:
OVE_WEB_ALLOW_ORIGIN=https://ove-studio.netlify.app ./ove-web-linux-x86_64

# 2. open the hosted editor pointed at your server:
#    https://ove-studio.netlify.app/?server=http://localhost:8787
#    (the override persists in localStorage; the "Use same-origin" button in
#    the page's server panel resets it)
```

Security/behavior notes:
- `OVE_WEB_ALLOW_ORIGIN` is OFF by default: unset ⇒ the server sends NO CORS
  headers and behaves exactly like v0.1.0 (same-origin only).
- The value is an exact-origin allowlist (comma-separated), or `*` for any
  origin. The preflight also answers Chromium's Private Network Access
  request (`Access-Control-Allow-Private-Network`) — required for a public
  page to reach a loopback server — but only for already-allowed origins.
- The server still binds 127.0.0.1 only. A hosted page can never reach
  someone else's engine; it reaches the operator's own local one.
- Exports are verified in-browser via SHA-256 before download; in hosted
  mode downloads are fetched through the verified path so the browser
  preserves the artifact's name.

## Build from source

```sh
# 0. requirements: node 20+, rust stable, clang + libclang + nasm + ffmpeg CLI
# 1. fetch the engine at the pinned commit (read-only checkout)
sh server/fetch-engine.sh
# 2. build the editor UI (outputs to server/web-dist, embedded at compile time)
cd web && npm ci && npm run build
# 3. build the server (FFmpeg 7.1 dev required; or use the bundled feature)
cd ../server && cargo build --release --features ove-decode/bundled,ove-encode/bundled
./target/release/ove-web
```

FFmpeg dev version note: the engine pins `ffmpeg-sys-next 7.1` — either
provide system FFmpeg 7.1.x dev packages or use the `bundled` feature (the
engine's own CI mechanism, also used by this repo's CI).

## Tests

```sh
cd server
cargo test --features ove-decode/bundled,ove-encode/bundled
# 3 full-stack journeys over real HTTP: fixture pipeline, env-gated NASA
# media leg (OVE_E2E_MEDIA), boundary guards.
```

## Documentation

| Doc | Content |
|---|---|
| [docs/ENGINE_INTEGRATION_AUDIT.md](docs/ENGINE_INTEGRATION_AUDIT.md) | Phase 0 audit: consumed surface, verified behaviors, transport decision, security posture |
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) | truth-annotated capability inventory |
| [docs/UX_ARCHITECTURE.md](docs/UX_ARCHITECTURE.md) | IA, editor layout, interaction model, state design |
| [docs/UI_SYSTEM.md](docs/UI_SYSTEM.md) | design tokens (shared with the Android client) |
| [docs/SCREEN_STATE_MAP.md](docs/SCREEN_STATE_MAP.md) | every screen × state × control |
| [docs/INTEGRATION_GAPS.md](docs/INTEGRATION_GAPS.md) | engine limitations and their honest treatment |
| [docs/REAL_MEDIA_VERIFICATION.md](docs/REAL_MEDIA_VERIFICATION.md) | what was actually tested, where, and what remains blocked |

## Versioning

This client versions independently (`0.1.0`) and records the exact engine
commit it consumes (`06c9249…`, enforced at build time by
`server/fetch-engine.sh`). Releases are single binaries with the UI embedded;
assets carry SHA256SUMS and build metadata.

## Sibling clients

- [open-video-engine-android](https://github.com/ansaribilal14/open-video-engine-android) —
  OVE Studio for Android (Compose M3, JNI bridge, same engine pin).

## License

`MIT OR Apache-2.0` for this repository's own code, matching the engine.
FFmpeg/libav is linked under the LGPL-compatible configuration via the
engine's decode/encode crates (ADR-015/ADR-024); no GPL codec packs, no
vendored FFmpeg binaries in this repository.
