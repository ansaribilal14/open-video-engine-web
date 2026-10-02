# UI SYSTEM — design tokens (web)

Inherited 1:1 from the Android client's `docs/UI_SYSTEM.md` so both clients of
the same engine read as one product family. Implemented in
`web/src/styles.css` as CSS custom properties.

## 1. Color tokens (dark = only theme in v0.1.0, editor-fidelity decision)

| Token | Value | Use |
|---|---|---|
| `--background` | `#0F1014` | screen background |
| `--surface` | `#16171C` | cards/sheets/dialogs |
| `--surface-container` | `#1C1E24` | app bar, timeline well, transport |
| `--surface-container-high` | `#24262E` | clips pane, context bar |
| `--surface-variant` | `#2A2C36` | ruler, secondary fills |
| `--primary` | `#7FB2FF` | selection, primary actions, progress |
| `--on-primary` | `#0A1E3C` | on primary fills |
| `--secondary` | `#9BB4D8` | secondary text/actions |
| `--tertiary` | `#8FD0C0` | audio-badge accent ONLY |
| `--error` | `#FFB4AB` | destructive + playhead line (editor convention) |
| `--on-surface` | `#E4E2E6` | primary text |
| `--on-surface-variant` | `#A9AAB4` | secondary text |
| `--outline` | `#3C3F4A` | hairlines, clip borders |
| `--clip-video` | `#2E4A73` | video clip fill |

No gradients, no glassmorphism, no decorative blobs, no accent soup.

## 2. Typography

System stack (`Roboto / Noto Sans / system-ui`) — same rationale as Android
(no custom font downloads for a local tool). Timecodes use the mono stack
with `font-variant-numeric: tabular-nums`. Sizes: 24/32 screen titles, 16/24
titles+buttons, 14/20 body, 11/16 labels/ruler.

## 3. Shape, spacing, elevation

Radii: 8 (chips/badges/fields), 12 (clips/cards), 20 (sheets/dialogs).
Spacing: 4dp grid (4/8/16/24/32). Elevation: flat by default; sheets/dialogs
separate via backdrop, not shadow. Dragged-clip shadow: deferred (drag
feedback is selection-ring + context bar in v0.1.0 — recorded decision).

## 4. Iconography

Unicode glyph buttons in v0.1.0 (`‹ ⏮ ▶ ⏸ ⏭`) — deliberately minimal, every
button has an `aria-label`. Material Symbols was evaluated; for a local
single-binary tool with six icons, no icon-font download is warranted
(recorded decision; revisit if the icon set grows).

## 5. Motion

- Sheet: 300ms slide-up (CSS default timing).
- Progress: indeterminate 1.2s slide — real work only, never decorative.
- Selection: instant ring (canvas) + context bar appears immediately.
- No looping animations anywhere except the honest export progress bar.

## 6. Component semantics

App bar = actions; media strip = real probe truth; context bar appears ONLY
with a selection and offers only engine-valid operations for it (split is
disabled outside the clip bounds); export sheet blocks the editor while the
engine works (single-writer); snackbars are non-blocking, error ones styled
with the error role color.
