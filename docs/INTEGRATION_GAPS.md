# INTEGRATION GAPS — engine interface limitations affecting the web client

Carried over from the Android client's report (same engine pin) with
web-specific notes. Per the takeover charter: when an engine API limitation
blocks a requirement, the client documents it, names the exact interface
involved, and **does not alter the engine**.

| # | Requirement | Exact interface involved | Gap | Client treatment | Status |
|---|---|---|---|---|---|
| 1 | Full composite export reachable from a client | `ove-engine::Engine::export_reencode` — library-only | CLI/MCP cannot reach the flagship export | Server hosts the library session (`ove-web`); UI exposes it | RESOLVED via server |
| 2 | Clip layout for timeline UI | CLI/MCP status returns only hashes/ids | No client surface returns clips/durations/positions | Server reads library `project()` accessors; verified by `state_hash` | RESOLVED via server |
| 3 | Typed error handling | `EngineError` taxonomy is library-only | String scraping is fragile | Server maps typed variants → structured errors; one JSON envelope | RESOLVED via server |
| 4 | Audio during preview | `assemble_timeline_audio` returns a complete mix; no streaming/segment API | Cannot stream audio synced to scrubbed preview | Silent stepped preview, stated on-screen ("silent (gap #4)") | OPEN — surfaced truthfully |
| 5 | Undo depth indicator | `Project::undo_depth()` library-public, absent from CLI/MCP | CLI/MCP-only clients can't show depth | Server reads it; app bar shows live depth. No `redo_depth()` accessor exists (verified) — redo availability is not numerically displayed | RESOLVED (within accessor reality) |
| 6 | Export progress/cancel | `export_reencode` synchronous, no callback, no cancellation | No percent, no cancel | Honest indeterminate bar + explicit "no cancel" copy | OPEN — surfaced truthfully |
| 7 | Clip thumbnails / waveforms | Probe sidecar has no frame-extract verb | Timeline thumbnails would need per-clip `render_frame` calls or non-engine extraction | Labeled tiles with real metadata only | OPEN — documented limit |
| 8 | libav availability on the host | `ove-decode`/`ove-encode` link libav (ADR-015) | Server requires FFmpeg 7.1.x dev at build time | Build docs + CI provision it; `bundled` feature available in CI | OWNED BY CLIENT |
| 9 | New-project naming/registry | Engine has no project-listing API (projects are folders) | Client maintains its own registry | `registry.json` in the server data root; labeled client-side | CLIENT-SIDE BY DESIGN |
| 10 | Browser-only delivery | libav does not compile to WASM; engine wasm leg is pure-core only | A browser-only build could not decode/encode real media | Local server architecture chosen; honest rationale in the audit §2 | RESOLVED by architecture (documented) |

**Rule reaffirmed:** none of these justify engine modification. Items 1–3 are
the reason the server consumes the library session; items 4–7 are surfaced as
honest product limitations; items 8–9 are this repository's responsibility.
