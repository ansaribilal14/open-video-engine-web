// Canvas timeline — ruler / tracks / clips / selection / trim handles /
// playhead / zoom. All geometry uses float seconds for PIXELS ONLY; every
// value sent back to the engine is exact-rational (see rational.ts).

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
  onTrim: (track: number, clip: number, duration: Rat) => void;
  onMove: (clip: number, from: number, to: number, index: number) => void;
  onZoom: (pxPerSec: number, scrollX: number) => void;
  onScrubPreview: () => void;
}

const RULER_H = 24;
const TRACK_PITCH = 48;
const HANDLE_W = 7;

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

export default function Timeline(props: TimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(props);
  stateRef.current = props;

  // keep a mutable interaction state in refs (pointer drags)
  const dragRef = useRef<
    | null
    | { kind: "pan"; startX: number; startScroll: number }
    | { kind: "scrub" }
    | { kind: "trimL" | "trimR"; track: number; clip: Clip }
    | { kind: "move"; clipId: number; from: number; grabOffset: number; moved: boolean }
  >(null);

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
      ctx.fillStyle = col("--surface-container");
      ctx.fillRect(0, RULER_H, w, h - RULER_H);

      // ruler
      ctx.fillStyle = col("--surface-variant");
      ctx.fillRect(0, 0, w, RULER_H);
      const step = drawRulerStep(px);
      const first = Math.floor(sx / px / step) * step;
      ctx.font = "11px " + col("--font");
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
          const cw = Math.max(2, ratToSeconds(clip.duration) * px);
          if (x + cw < 0 || x > w) continue;
          const isSel = sel?.track === track.id && sel?.clip === clip.id;
          ctx.fillStyle = col("--clip-video");
          roundRect(ctx, x + 1, y + 5, cw - 2, TRACK_PITCH - 14, 6);
          ctx.fill();
          if (isSel) {
            ctx.strokeStyle = col("--primary");
            ctx.lineWidth = 2;
            roundRect(ctx, x + 1, y + 5, cw - 2, TRACK_PITCH - 14, 6);
            ctx.stroke();
            // trim handles
            ctx.fillStyle = col("--primary");
            ctx.fillRect(x + 1, y + 5, HANDLE_W, TRACK_PITCH - 14);
            ctx.fillRect(x + cw - 1 - HANDLE_W, y + 5, HANDLE_W, TRACK_PITCH - 14);
          }
          // label (real metadata: clip id + exact duration — gap #7: no
          // thumbnails or waveforms at client surfaces)
          ctx.fillStyle = "#ffffff";
          ctx.font = "11px " + col("--font");
          const label = `clip ${clip.id} · ${timecode(clip.duration)}`;
          if (cw > 60) ctx.fillText(label, x + 10 + (isSel ? HANDLE_W : 0), y + 14, cw - 24);
        }
      });

      // playhead (error color — editor convention, UI_SYSTEM §1)
      const pxh = t2x(stateRef.current.playhead);
      if (pxh >= -1 && pxh <= w + 1) {
        ctx.fillStyle = col("--error");
        ctx.fillRect(pxh, 0, 2, h);
        ctx.beginPath();
        ctx.moveTo(pxh - 5, 0);
        ctx.lineTo(pxh + 7, 0);
        ctx.lineTo(pxh + 1, 8);
        ctx.closePath();
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
      if (x <= hit.cx + HANDLE_W) {
        dragRef.current = { kind: "trimL", track: hit.track.id, clip: hit.clip };
        return;
      }
      if (x >= hit.cx + hit.cw - HANDLE_W) {
        dragRef.current = { kind: "trimR", track: hit.track.id, clip: hit.clip };
        return;
      }
    }
    dragRef.current = { kind: "move", clipId: hit.clip.id, from: hit.track.id, grabOffset: x - hit.cx, moved: false };
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
        // right edge: new duration = t - start (min one tick)
        const d = secondsToTickRat(Math.max(1 / 48000, ratToSeconds(t) - ratToSeconds(clipStart)));
        props.onTrim(drag.track, drag.clip.id, d);
      } else {
        // left edge: engine v1 resizes DURATION (start stays; source_in shifts
        // are move+resize compositions) — left trim adjusts duration only when
        // the pointer stays right of the clip start; otherwise clamp to one tick.
        const d = secondsToTickRat(Math.max(1 / 48000, ratToSeconds(drag.clip.start) + ratToSeconds(drag.clip.duration) - Math.max(ratToSeconds(clipStart), ratToSeconds(t))));
        props.onTrim(drag.track, drag.clip.id, d);
      }
    } else if (drag.kind === "move") {
      drag.moved = true;
      // live feedback happens via hover highlight only; commit on pointerup
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === "move" && drag.moved) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const px = stateRef.current.pxPerSec;
      const sx = stateRef.current.scrollX;
      const tracks = stateRef.current.tracks;
      const trackIndex = Math.max(0, Math.min(tracks.length - 1, Math.floor((y - RULER_H) / TRACK_PITCH)));
      const target = tracks[trackIndex];
      // insertion index (post-state semantics): clips before the drop time,
      // excluding the dragged clip itself
      const dropTime = (x + sx - drag.grabOffset) / px;
      let index = 0;
      for (const c of target.clips) {
        if (c.id !== drag.clipId && ratToSeconds(c.start) < dropTime) index++;
      }
      props.onMove(drag.clipId, drag.from, target.id, index);
    }
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
        onPointerCancel={() => (dragRef.current = null)}
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
