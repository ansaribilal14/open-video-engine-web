// Canvas timeline — ruler / tracks / clips / selection / trim handles /
// playhead / zoom / move ghost. All geometry uses float seconds for PIXELS
// ONLY; every value sent back to the engine is exact-rational (rational.ts).
//
// v0.1.1 responsiveness rework: gestures keep ALL interaction state local
// (trim preview, move ghost) and commit to the engine exactly ONCE on
// release — v0.1.0 fired a network mutation on every pointermove, which
// flooded the single-writer session and froze the UI.

import { useEffect, useRef } from "react";
import type { Clip, Track } from "../api";
import { ratToSeconds, secondsToTickRat, timecode, type Rat } from "../rational";

export interface TimelineProps {
  tracks: Track[];
  span: Rat;
  playhead: Rat;
  selected: { track: number; clip: number } | null;
  pxPerSec: number;
  scrollX: number;
  onScrub: (t: Rat) => void;
  onSelect: (sel: { track: number; clip: number } | null) => void;
  /** fired ONCE per gesture, on release — engine resize with exact rational */
  onTrimCommit: (track: number, clip: number, duration: Rat) => void;
  /** fired ONCE per gesture, on release — engine move (post-state index) */
  onMoveCommit: (clip: number, from: number, to: number, index: number) => void;
  onZoom: (pxPerSec: number, scrollX: number) => void;
  onScrubPreview: () => void;
}

const RULER_H = 24;
const TRACK_PITCH = 56;
const HANDLE_W = 8;          // visual handle width (px)
const HANDLE_HIT = 14;       // half-width of the touch zone around an edge
const SNAP_PX = 10;          // edge-snap threshold

function drawRulerStep(pxPerSec: number): number {
  const candidates = [1 / 24, 1 / 8, 1 / 4, 1 / 2, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const c of candidates) {
    if (c * pxPerSec >= 80) return c;
  }
  return candidates[candidates.length - 1];
}

function fmtRuler(t: number, step: number): string {
  if (step >= 1) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t - m * 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
  const frames = Math.round(t * 24);
  const ff = frames % 24;
  const s = Math.floor(t);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toString().padStart(2, "0")}.${ff.toString().padStart(2, "0")}f`;
}

type Drag =
  | { kind: "pan"; startX: number; startScroll: number }
  | { kind: "scrub" }
  | { kind: "trimL" | "trimR"; track: number; clip: Clip }
  | { kind: "move"; clip: Clip; from: number; grabOffsetX: number; grabOffsetY: number };

export default function Timeline(props: TimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(props);
  stateRef.current = props;
  const dragRef = useRef<Drag | null>(null);
  // LOCAL gesture visuals (never sent anywhere; committed once on release)
  const trimPreviewRef = useRef<{ clipId: number; durationSec: number } | null>(null);
  const moveGhostRef = useRef<{ trackIndex: number; x: number; w: number; y: number } | null>(null);

  // ------------------------------------------------------------------ draw
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const css = getComputedStyle(document.documentElement);
      const col = (name: string) => css.getPropertyValue(name).trim() || "#000";
      const px = stateRef.current.pxPerSec;
      const sx = stateRef.current.scrollX;
      const t2x = (t: Rat | number) => (typeof t === "number" ? t : ratToSeconds(t)) * px - sx;

      // background lanes
      ctx.fillStyle = col("--background");
      ctx.fillRect(0, RULER_H, w, h - RULER_H);

      // ruler
      ctx.fillStyle = col("--surface");
      ctx.fillRect(0, 0, w, RULER_H);
      const step = drawRulerStep(px);
      const first = Math.floor(sx / px / step) * step;
      ctx.font = "10px " + col("--font");
      ctx.textBaseline = "middle";
      for (let t = first; t * px - sx < w + 1; t += step) {
        const x = t * px - sx;
        ctx.fillStyle = col("--outline");
        ctx.fillRect(x, RULER_H - 8, 1, 8);
        ctx.fillStyle = col("--on-surface-variant");
        ctx.fillText(fmtRuler(t, step), x + 4, RULER_H / 2 - 2);
      }

      // tracks
      const tracks = stateRef.current.tracks;
      const sel = stateRef.current.selected;
      tracks.forEach((track, i) => {
        const y = RULER_H + i * TRACK_PITCH;
        if (y > h) return;
        ctx.fillStyle = col("--surface");
        ctx.fillRect(0, y + 2, w, TRACK_PITCH - 4);
        ctx.strokeStyle = col("--outline");
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, y + 2.5, w - 1, TRACK_PITCH - 5);

        for (const clip of track.clips) {
          const x = t2x(clip.start);
          const preview = trimPreviewRef.current;
          const durSec =
            preview && preview.clipId === clip.id
              ? preview.durationSec
              : ratToSeconds(clip.duration);
          const cw = Math.max(2, durSec * px);
          if (x + cw < 0 || x > w) continue;
          const isSel = sel?.track === track.id && sel?.clip === clip.id;
          ctx.fillStyle = col("--clip-video");
          roundRect(ctx, x + 1, y + 5, cw - 2, TRACK_PITCH - 14, 4);
          ctx.fill();
          if (isSel) {
            // selection ring — 1.5px primary (OpenCut convention)
            ctx.strokeStyle = col("--primary");
            ctx.lineWidth = 1.5;
            roundRect(ctx, x + 1, y + 5, cw - 2, TRACK_PITCH - 14, 4);
            ctx.stroke();
            // trim handles — visual 8px (touch zone is wider, see hit test)
            ctx.fillStyle = col("--primary");
            ctx.fillRect(x + 1, y + 5, HANDLE_W, TRACK_PITCH - 14);
            ctx.fillRect(x + cw - 1 - HANDLE_W, y + 5, HANDLE_W, TRACK_PITCH - 14);
          }
          // label (real metadata: clip id + exact duration — gap #7: no
          // thumbnails or waveforms at client surfaces)
          ctx.fillStyle = "#DEDEDE";
          ctx.font = "11px " + col("--font");
          const label = `clip ${clip.id} · ${timecode(clip.duration)}`;
          if (cw > 60) ctx.fillText(label, x + 10 + (isSel ? HANDLE_W : 0), y + 14, cw - 24);
        }
      });

      // move ghost (live drop preview)
      const ghost = moveGhostRef.current;
      if (ghost) {
        ctx.fillStyle = col("--primary-dim") || "rgba(22,169,243,0.4)";
        roundRect(ctx, ghost.x, RULER_H + ghost.trackIndex * TRACK_PITCH + 5, ghost.w, TRACK_PITCH - 14, 4);
        ctx.fill();
      }

      // playhead (primary accent — CapCut/OpenCut convention)
      const pxh = t2x(stateRef.current.playhead);
      if (pxh >= -1 && pxh <= w + 1) {
        ctx.fillStyle = col("--primary");
        ctx.fillRect(pxh, 0, 2, h);
        ctx.beginPath();
        ctx.arc(pxh + 1, 7, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    const mo = new MutationObserver(draw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  });

  // (the draw effect above has no dependency array — it re-runs after every
  // render, so prop changes redraw the canvas directly)

  // ------------------------------------------------------------- pointers
  const timeAt = (clientX: number): { t: Rat; x: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = clientX - rect.left;
    const secs = (x + stateRef.current.scrollX) / stateRef.current.pxPerSec;
    return { t: secondsToTickRat(Math.max(0, secs)), x };
  };

  const hitTest = (x: number, y: number) => {
    const px = stateRef.current.pxPerSec;
    const sx = stateRef.current.scrollX;
    const tracks = stateRef.current.tracks;
    const trackIndex = Math.floor((y - RULER_H) / TRACK_PITCH);
    if (trackIndex < 0 || trackIndex >= tracks.length) return null;
    const track = tracks[trackIndex];
    for (const clip of track.clips) {
      const cx = ratToSeconds(clip.start) * px - sx;
      const cw = Math.max(2, ratToSeconds(clip.duration) * px);
      const top = RULER_H + trackIndex * TRACK_PITCH + 5;
      if (y >= top && y <= top + TRACK_PITCH - 14 && x >= cx && x <= cx + cw) {
        return { track, clip, trackIndex, cx, cw };
      }
    }
    return null;
  };

  /** index within a track for a drop x (post-state semantics, excluding id) */
  const insertionIndex = (track: Track, dropSec: number, excludeId: number): number => {
    let idx = 0;
    for (const c of track.clips) {
      if (c.id !== excludeId && ratToSeconds(c.start) < dropSec) idx++;
    }
    return idx;
  };

  /** snap drop seconds to nearby clip edges (visual stabilization only) */
  const snapDrop = (dropSec: number): number => {
    const px = stateRef.current.pxPerSec;
    const tracks = stateRef.current.tracks;
    let best = dropSec;
    let bestDist = SNAP_PX / px;
    for (const tr of tracks) {
      for (const c of tr.clips) {
        for (const edge of [ratToSeconds(c.start), ratToSeconds(c.start) + ratToSeconds(c.duration)]) {
          const d = Math.abs(edge - dropSec);
          if (d < bestDist) {
            bestDist = d;
            best = edge;
          }
        }
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    (e.target as Element).setPointerCapture(e.pointerId);

    if (y <= RULER_H) {
      dragRef.current = { kind: "scrub" };
      const { t } = timeAt(e.clientX);
      props.onScrub(t);
      props.onScrubPreview();
      return;
    }

    const hit = hitTest(x, y);
    if (!hit) {
      // pan empty space
      dragRef.current = { kind: "pan", startX: e.clientX, startScroll: stateRef.current.scrollX };
      return;
    }
    const sel = stateRef.current.selected;
    props.onSelect({ track: hit.track.id, clip: hit.clip.id });
    const isSel = sel?.track === hit.track.id && sel?.clip === hit.clip.id;
    if (isSel) {
      if (x <= hit.cx + HANDLE_HIT) {
        dragRef.current = { kind: "trimL", track: hit.track.id, clip: hit.clip };
        return;
      }
      if (x >= hit.cx + hit.cw - HANDLE_HIT) {
        dragRef.current = { kind: "trimR", track: hit.track.id, clip: hit.clip };
        return;
      }
    }
    dragRef.current = {
      kind: "move",
      clip: hit.clip,
      from: hit.track.id,
      grabOffsetX: x - hit.cx,
      grabOffsetY: y,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "scrub") {
      const { t } = timeAt(e.clientX);
      props.onScrub(t);
      props.onScrubPreview();
    } else if (drag.kind === "pan") {
      const dx = e.clientX - drag.startX;
      props.onZoom(stateRef.current.pxPerSec, Math.max(0, drag.startScroll - dx));
    } else if (drag.kind === "trimL" || drag.kind === "trimR") {
      const { t } = timeAt(e.clientX);
      const clipStart = drag.clip.start;
      if (drag.kind === "trimR") {
        const d = secondsToTickRat(Math.max(1 / 48000, ratToSeconds(t) - ratToSeconds(clipStart)));
        trimPreviewRef.current = { clipId: drag.clip.id, durationSec: ratToSeconds(d) };
      } else {
        const d = secondsToTickRat(
          Math.max(
            1 / 48000,
            ratToSeconds(drag.clip.start) + ratToSeconds(drag.clip.duration) -
              Math.max(ratToSeconds(clipStart), ratToSeconds(t)),
          ),
        );
        trimPreviewRef.current = { clipId: drag.clip.id, durationSec: ratToSeconds(d) };
      }
    } else if (drag.kind === "move") {
      const rect = canvasRef.current!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const px = stateRef.current.pxPerSec;
      const tracks = stateRef.current.tracks;
      const trackIndex = Math.max(
        0,
        Math.min(tracks.length - 1, Math.floor((y - RULER_H) / TRACK_PITCH)),
      );
      const w = Math.max(2, ratToSeconds(drag.clip.duration) * px);
      moveGhostRef.current = { trackIndex, x: x - drag.grabOffsetX, w, y };
    }
  };

  const onPointerUp = (_e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === "trimL" || drag.kind === "trimR") {
      const preview = trimPreviewRef.current;
      trimPreviewRef.current = null;
      if (preview) {
        const d = secondsToTickRat(preview.durationSec);
        props.onTrimCommit(drag.track, drag.clip.id, d);
      }
    } else if (drag.kind === "move") {
      const ghost = moveGhostRef.current;
      moveGhostRef.current = null;
      if (!ghost) return;
      const tracks = stateRef.current.tracks;
      const target = tracks[ghost.trackIndex];
      if (!target) return;
      const px = stateRef.current.pxPerSec;
      const sx = stateRef.current.scrollX;
      const dropSec = snapDrop((ghost.x + drag.grabOffsetX + sx) / px);
      const index = insertionIndex(target, dropSec, drag.clip.id);
      props.onMoveCommit(drag.clip.id, drag.from, target.id, index);
    }
  };

  const onPointerCancel = () => {
    dragRef.current = null;
    trimPreviewRef.current = null;
    moveGhostRef.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const cur = stateRef.current;
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      // zoom anchored at cursor (desktop NLE convention, documented)
      const tCursor = (x + cur.scrollX) / cur.pxPerSec;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = Math.min(5000, Math.max(50, cur.pxPerSec * factor));
      const nextScroll = Math.max(0, tCursor * next - x);
      props.onZoom(next, nextScroll);
    } else {
      props.onZoom(cur.pxPerSec, Math.max(0, cur.scrollX + (e.deltaX > 0 ? 60 : -60)));
    }
  };

  return (
    <div ref={wrapRef} className="timeline-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="timeline"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onWheel={onWheel}
      />
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
