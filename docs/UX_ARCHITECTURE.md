# UX ARCHITECTURE — OVE Studio Web

## 1. Information architecture

```
Projects Home (/)
├── Project list (recent-first, disk-presence honest)
├── New project (dialog: name, [A-Za-z0-9_-])
├── Overflow → Settings / Diagnostics
└── → EDITOR (full-viewport workspace)
      ├── App bar: back · project name · state-hash + undo depth · Undo · Redo · Import · Export
      ├── Media strip (real probe badges; "+ Add to timeline")
      ├── Preview pane (engine-rendered PNG composite, letterboxed)
      ├── Transport: ⏮ · play/pause · ⏭ · exact timecode · "stepped preview · silent (gap #4)"
      ├── Timeline: ruler · tracks · clips · selection ring · trim handles · playhead · zoom
      ├── Clip context bar (selection-scoped): Split at playhead · Delete · Deselect
      └── Export sheet (modal): three real routes · honest progress · verify + download
```

Two screens, one modal sheet, one dialog — same discipline as the Android
client (density and predictability over navigation depth).

## 2. Layout (desktop-first, 1280×800 reference)

| Zone | Size | Content |
|---|---|---|
| App bar | 56px | identity + engine authority + global actions |
| Media strip | 52px, conditional | imported assets (probe truth), hidden when empty |
| Preview | flexible (≈55%) | ground truth of the edit; letterboxed, aspect-locked |
| Transport | 48px | stepped playback controls |
| Timeline | 200px | toolbar (span, zoom) + canvas |
| Context bar | 56px, conditional | selection-scoped engine actions |

## 3. Timeline interaction model (web)

- **Zoom**: wheel (anchor = cursor, desktop NLE convention) or slider
  (50–5000 px/s ≡ 2.00–0.02 s/100px, matching the Android range).
- **Pan**: drag empty space; horizontal wheel.
- **Scrub**: drag/click ruler — snaps to the project tick axis (48000/1, exact
  integer rounding, never float accumulation).
- **Select**: click clip → selection ring + trim handles + context bar;
  click empty → deselect.
- **Trim**: drag edge handles → engine `resize` with exact rational duration;
  typed rejections revert the state and explain themselves.
- **Move**: drag clip body → drop computes (track, post-state insertion index)
  → engine `move_clip`; typed rejections revert.
- Every gesture result is engine-verified (shape re-fetched; state hash
  re-rendered in the app bar).

## 4. Preview model (honesty rules)

- The preview shows ONLY real `render_frame` composites (PNG). It is stepped
  (one engine render per step, paced, machine-relative) and silent (gap #4) —
  both stated on-screen. It never claims to be real-time video playback.
- Frame requests carry the exact rational playhead (`num/den`); the client's
  play arithmetic is BigInt-exact with canonical reduction (a denormalization
  bug found in visual QA is documented in the audit §7).
- Out-of-coverage times: the engine renders a defined empty composite (probed
  behavior); the client additionally clamps scrubbing to the timeline span.

## 5. State design (every state designed)

Home: empty · loading · populated · disk-missing entries · error (server
unreachable). Import: idle · uploading (real XHR progress) · engine-importing
· success (hash + placement) · typed failure. Editor: no-media · populated ·
clip-selected · gesture-rejected (typed explanation) · engine-busy (export) ·
recovery (reload → idempotent re-open returns the durable state). Export:
sheet · running (indeterminate, no cancel — gap #6 stated) · success
(file/size/sha256 + in-browser verify) · typed failure.

## 6. Accessibility & keyboard

- All icon buttons carry `aria-label`; dialogs use real buttons (no
  hover-only affordances); focus outline preserved on inputs.
- Play/pause toggles via the transport button; Esc closes the export sheet by
  clicking Close (destructive-free dismissal).
- Minimum target 40px for icon buttons; timeline handles are 7px wide but
  magnified by the 48px track lane (documented; pointer events only).

## 7. Theming

Editor surfaces always dark (preview-fidelity decision, inherited from the
Android UI_SYSTEM §10). Home/Settings use the same dark palette in v0.1.0;
the token table is shared 1:1 with the Android client so the two clients of
the same engine read as one product family.
