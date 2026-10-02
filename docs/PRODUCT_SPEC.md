# PRODUCT SPEC — OVE Studio Web (v0.1.0)

**Product:** browser editor for the Open Video Engine, hosted by a local
single-binary server. One sentence: *open `ove-web`, get a real editing
surface over the real engine — nothing simulated.*

## 1. Truth-annotated inventory

Every capability below is bound to a named engine interface (see
`ENGINE_INTEGRATION_AUDIT.md` §4). If the engine cannot do it, the UI either
omits the control or states the limitation where the user would expect the
feature.

| Area | Capabilities | Engine basis |
|---|---|---|
| PROJECT HOME | list/create/open/delete projects; engine pin + version surfaced | folders + client registry (gap #9) |
| MEDIA IMPORT | file upload (real transfer progress) → engine import → probe metadata surfaced (streams, codecs, dimensions, audio, exact duration) | `import_media`, documented `probe.json` (F-4) |
| EDITOR | stepped engine-rendered preview (silent), transport with frame-step, exact `mm:ss.mmm` timecode, canvas timeline (ruler/tracks/clips/selection/trim-handles/playhead/zoom), media strip with real probe badges | `render_frame` + shape projection |
| CLIP CONTROLS | context bar on selection: split at playhead (enabled only inside the clip), delete, deselect; drag trim (exact rational duration); drag move (track change + reorder, post-state index) | `split`, `remove`, `resize`, `move_clip` |
| UNDO/REDO | app bar with live `undo_depth`; every mutation durable on return | `undo/redo`, P-2 |
| EXPORT | composite MP4 (flagship), WAV mixdown, segment stream-copy of the selected clip's source range; honest indeterminate progress; result = file/size/sha256 with in-browser SHA-256 verification before download | `export_reencode`, `export_wav`, `export_copy` |
| SETTINGS | server/engine versions, pin, data root, single-writer notice, limitations verbatim | `/api/settings` |

## 2. Out of scope (v0.1.0, honestly)

Keyframe editing UI (engine supports; client does not ship controls),
thumbnails/waveforms (gap #7), audio in preview (gap #4), export percent/cancel
(gap #6), transitions/titles/filters (engine: none), speed changes (engine:
typed rejection), multi-user editing (single-writer v1), authentication/TLS
(local host tool binding 127.0.0.1).

## 3. Non-negotiable quality gates (charter)

- No placeholder buttons; no dead controls; no fake progress; no fake
  previews; no simulated exports.
- Status vocabulary: IMPLEMENTED / INTEGRATED / TESTED / DEVICE-VERIFIED /
  BLOCKED / UNSUPPORTED BY ENGINE — nothing else.
- Every mutation's result is re-fetched from the engine (state_hash shown in
  the app bar); rejected gestures surface the typed engine error and revert.
