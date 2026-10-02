// Editor — the workspace. Preview is REAL engine output (stepped PNG
// composites); every control maps 1:1 to an engine operation; no dead
// controls, no simulated progress, no fake previews (charter §UI-quality).

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { EngineCallError } from "../api";
import type { Shape } from "../api";
import Timeline from "../components/Timeline";
import ExportSheet from "../components/ExportSheet";
import {
  ratAdd,
  ratCmp,
  ratSub,
  ratToSeconds,
  secondsToTickRat,
  timecode,
  type Rat,
} from "../rational";

const PREVIEW_STEP: Rat = [1, 24];

function aspectOf(shape: Shape | null): number {
  const src = shape?.assets.find((a) => a.hash === shape.render_source) ?? shape?.assets[0];
  const v = src?.probe?.streams.find((s) => s.kind === "Video");
  if (v?.video && v.video.width > 0) return v.video.width / v.video.height;
  return 16 / 9;
}

export default function Editor({
  project,
  onHome,
  notify,
}: {
  project: string;
  onHome: () => void;
  notify: (m: string, k?: "info" | "error") => void;
}) {
  const [shape, setShape] = useState<Shape | null>(null);
  const [playhead, setPlayhead] = useState<Rat>([0, 48000]);
  const [selected, setSelected] = useState<{ track: number; clip: number } | null>(null);
  const [pxPerSec, setPxPerSec] = useState(120);
  const [scrollX, setScrollX] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [importing, setImporting] = useState<{ loaded: number; total: number } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [previewSize, setPreviewSize] = useState({ w: 640, h: 360 });
  const fileRef = useRef<HTMLInputElement | null>(null);
  const previewWrapRef = useRef<HTMLDivElement | null>(null);

  // ------------------------------------------------------------- data flow
  const refresh = useCallback(async () => {
    try {
      const s = await api.getShape();
      setShape(s);
      return s;
    } catch (e) {
      if (e instanceof EngineCallError && (e.kind === "NoSession" || e.kind === "EngineBusy")) {
        // during export the session is honestly busy; keep the last shape
        return null;
      }
      notify((e as Error).message, "error");
      return null;
    }
  }, [notify]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // preview size follows the pane, aspect-locked to the render source
  useEffect(() => {
    const el = previewWrapRef.current;
    if (!el) return;
    const update = () => {
      const ar = aspectOf(shape);
      const pw = el.clientWidth - 16;
      const ph = el.clientHeight - 16;
      let w = Math.min(pw, 1280);
      let h = Math.round(w / ar);
      if (h > ph) {
        h = Math.max(2, ph);
        w = Math.round(h * ar);
      }
      setPreviewSize({ w: Math.max(2, w), h: Math.max(2, h) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shape]);

  // stepped playback — honest: one engine render per step, paced, machine-
  // relative. This is not real-time video playback and never claims to be.
  useEffect(() => {
    if (!playing) return;
    let alive = true;
    let busy = false;
    const id = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      const span = shape?.timeline_span ?? [0, 1];
      setPlayhead((prev) => {
        const next = ratAdd(prev, PREVIEW_STEP);
        if (ratCmp(next, span) > 0) {
          setPlaying(false);
          return prev;
        }
        return next;
      });
      // wait for the frame image to actually load before scheduling more
      const url = api.frameUrl(playheadRef.current, previewSize.w, previewSize.h);
      const img = new Image();
      img.onload = () => (busy = false);
      img.onerror = () => (busy = false);
      img.src = url;
      if (!alive) return;
    }, 1000 / 24);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [playing, shape, previewSize]);

  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  // playhead scrub → preview follows on the next tick (img src swap)
  const scrub = useCallback((t: Rat) => setPlayhead(t), []);

  // ------------------------------------------------------------- mutations
  const guard = useCallback(
    (e: unknown, what: string): boolean => {
      if (e instanceof EngineCallError) {
        notify(`${what} — ${e.kind}: ${e.message}`, "error");
        return false;
      }
      notify(`${what}: ${(e as Error).message}`, "error");
      return false;
    },
    [notify],
  );

  const doImport = async (file: File) => {
    setImporting({ loaded: 0, total: file.size });
    try {
      await api.importMedia(file, (loaded, total) => setImporting({ loaded, total }));
      const s = await refresh();
      // auto-place on track 1 (or create the first track) — end-placement is
      // the engine's add_clip semantics (F-6)
      const s2 = s ?? (await api.getShape());
      if (!s2.tracks.some((t) => t.id === 1)) await api.addTrack(1);
      const s3 = await api.getShape();
      const asset = s3.assets[s3.assets.length - 1];
      const vStream = asset.probe?.streams.find((st) => st.kind === "Video");
      const dur = asset.probe?.duration ?? [1, 1];
      if (!vStream) {
        notify("imported, but the source has no video stream — audio-only sources cannot be placed on the v1 gap-track timeline", "error");
        return;
      }
      await api.addClip(1, asset.hash, dur, [0, 1]);
      await refresh();
      notify(`imported + placed on track 1 (${timecode(dur)})`);
    } catch (e) {
      guard(e, "import failed");
    } finally {
      setImporting(null);
    }
  };

  const addAssetToTimeline = async (hash: string) => {
    try {
      if (!shape?.tracks.some((t) => t.id === 1)) await api.addTrack(1);
      const asset = shape?.assets.find((a) => a.hash === hash);
      if (!asset?.probe) return;
      const vStream = asset.probe.streams.find((s) => s.kind === "Video");
      if (!vStream) {
        notify("audio-only sources cannot be placed on the v1 gap-track timeline", "error");
        return;
      }
      await api.addClip(1, hash, asset.probe.duration ?? [1, 1], [0, 1]);
      await refresh();
    } catch (e) {
      guard(e, "add clip failed");
    }
  };

  const mediaStrip = (() => {
    if (!shape || shape.assets.length === 0) return null;
    return (
      <div className="context-bar" style={{ height: 52, minHeight: 52, overflowX: "auto" }}>
        {shape.assets.map((a) => {
          const v = a.probe?.streams.find((s) => s.kind === "Video");
          const au = a.probe?.streams.find((s) => s.kind === "Audio");
          return (
            <span key={a.hash} className="row" style={{ border: "1px solid var(--outline)", borderRadius: 8, padding: "4px 8px" }}>
              <span className="mono muted" style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>
                {a.hash.slice(0, 10)}…
              </span>
              {v?.video && <span className="badge">{v.video.width}×{v.video.height}</span>}
              {au && <span className="badge audio">audio</span>}
              {a.probe?.duration && <span className="mono muted">{timecode(a.probe.duration)}</span>}
              <button className="btn text" onClick={() => addAssetToTimeline(a.hash)}>
                + Add to timeline
              </button>
            </span>
          );
        })}
      </div>
    );
  })();

  const doUndo = async () => {
    try {
      const v = await api.undo();
      if (!v.did) notify("nothing to undo");
      setSelected(null);
      refresh();
    } catch (e) {
      guard(e, "undo failed");
    }
  };

  const doRedo = async () => {
    try {
      const v = await api.redo();
      if (!v.did) notify("nothing to redo");
      refresh();
    } catch (e) {
      guard(e, "redo failed");
    }
  };

  const selectedClipInfo = (() => {
    if (!shape || !selected) return null;
    for (const t of shape.tracks) {
      if (t.id !== selected.track) continue;
      const c = t.clips.find((c) => c.id === selected.clip);
      if (c) return { clip: c, track: t };
    }
    return null;
  })();

  const canSplitHere = (() => {
    if (!selectedClipInfo) return false;
    const s = selectedClipInfo.clip.start;
    const e = ratAdd(s, selectedClipInfo.clip.duration);
    const c = ratCmp(playhead, s) > 0 && ratCmp(playhead, e) < 0;
    return c;
  })();

  const doSplit = async () => {
    if (!selected || !canSplitHere) return;
    try {
      await api.splitClip(selected.track, selected.clip, playhead);
      refresh();
      notify("split at playhead");
    } catch (e) {
      guard(e, "split failed");
    }
  };

  const doDeleteClip = async () => {
    if (!selected) return;
    try {
      await api.removeClip(selected.track, selected.clip);
      setSelected(null);
      refresh();
    } catch (e) {
      guard(e, "delete failed");
    }
  };

  const doTrim = useCallback(
    async (track: number, clip: number, duration: Rat) => {
      try {
        await api.resizeClip(track, clip, duration);
        refresh();
      } catch (e) {
        guard(e, "trim rejected");
        refresh();
      }
    },
    [guard, refresh, notify],
  );

  const doMove = useCallback(
    async (clip: number, from: number, to: number, index: number) => {
      try {
        await api.moveClip(clip, from, to, index);
        refresh();
      } catch (e) {
        guard(e, "move rejected");
        refresh();
      }
    },
    [guard, refresh, notify],
  );

  // frame stepping (exact ±1 preview frame)
  const stepFrame = (dir: 1 | -1) => {
    setPlaying(false);
    setPlayhead((prev) => {
      const next = dir > 0 ? ratAdd(prev, PREVIEW_STEP) : ratSub(prev, PREVIEW_STEP);
      const span = shape?.timeline_span ?? [0, 1];
      if (ratCmp(next, span) > 0) return prev;
      if (ratCmp(next, [0, 1]) < 0) return [0, 1];
      return next;
    });
  };

  const hasMedia = (shape?.assets.length ?? 0) > 0;
  const spanSecs = shape ? ratToSeconds(shape.timeline_span) : 0;

  return (
    <>
      <header className="appbar">
        <button className="icon-btn" onClick={onHome} aria-label="home">‹</button>
        <span className="title">{project}</span>
        <span className="subtitle mono" title="engine-authoritative state hash (BLAKE3-256)">
          {shape ? `${shape.state_hash.slice(0, 12)}… · undo ${shape.undo_depth}` : "…"}
        </span>
        <button className="btn text" onClick={doUndo} disabled={!shape || shape.undo_depth === 0}>Undo</button>
        <button className="btn text" onClick={doRedo}>Redo</button>
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={importing !== null}>
          Import media
        </button>
        <button className="btn primary" onClick={() => setExportOpen(true)} disabled={!shape}>
          Export
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="video/*,audio/*,.mp4,.mov,.mkv,.avi,.webm,.wav,.mp3"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) doImport(f);
            e.target.value = "";
          }}
        />
      </header>

      {shape && shape.multi_source_limit && (
        <div className="context-bar" style={{ minHeight: 40, height: 40 }}>
          <span className="info">
            Multi-source timeline: the engine v1 (ADR-017) renders the FIRST imported
            source. Additional sources are stored but not composited.
          </span>
        </div>
      )}

      <main className="editor">
        {mediaStrip}
        <div className="preview-wrap" ref={previewWrapRef}>
          {hasMedia ? (
            <img
              key={`${playhead[0]}/${playhead[1]}`}
              src={api.frameUrl(playhead, previewSize.w, previewSize.h)}
              width={previewSize.w}
              height={previewSize.h}
              alt={`engine-rendered composite at ${timecode(playhead)}`}
            />
          ) : (
            <div className="preview-empty">
              <p>No media yet.</p>
              <p>Use “Import media” — files upload to the server, the engine copies
              them into its content-addressed store and probes them.</p>
            </div>
          )}
        </div>

        {importing && (
          <div className="context-bar" style={{ minHeight: 48, height: 48 }}>
            <span className="info">
              Uploading {(importing.loaded / 1024 / 1024).toFixed(1)} /{" "}
              {(importing.total / 1024 / 1024).toFixed(1)} MB (real transfer)…
            </span>
            <div className="progress grow"><div className="bar" /></div>
          </div>
        )}

        <div className="transport">
          <button className="icon-btn" onClick={() => stepFrame(-1)} aria-label="previous frame">⏮</button>
          <button className="icon-btn play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "pause" : "play"}>
            {playing ? "⏸" : "▶"}
          </button>
          <button className="icon-btn" onClick={() => stepFrame(1)} aria-label="next frame">⏭</button>
          <span className="time">{timecode(playhead)}</span>
          <span className="badge">stepped preview {previewSize.w}×{previewSize.h} · silent (gap #4)</span>
        </div>

        <div className="timeline-zone">
          <div className="timeline-toolbar">
            <span>timeline</span>
            <span className="mono">{timecode(shape?.timeline_span ?? [0, 1])} span</span>
            <div className="grow" />
            <span>zoom</span>
            <input
              type="range"
              min={50}
              max={5000}
              value={pxPerSec}
              onChange={(e) => setPxPerSec(Number(e.target.value))}
              style={{ width: 140 }}
            />
            <span className="mono" style={{ width: 70 }}>{(100 / pxPerSec).toFixed(2)} s/100px</span>
          </div>
          <Timeline
            tracks={shape?.tracks ?? []}
            span={shape?.timeline_span ?? [0, 1]}
            playhead={playhead}
            selected={selected}
            pxPerSec={pxPerSec}
            scrollX={scrollX}
            onScrub={(t) => {
              scrub(secondsToTickRat(Math.min(ratToSeconds(t), Math.max(0, spanSecs))));
            }}
            onSelect={setSelected}
            onTrim={doTrim}
            onMove={doMove}
            onZoom={(p, s) => {
              setPxPerSec(p);
              setScrollX(s);
            }}
            onScrubPreview={() => undefined}
          />
        </div>

        {selectedClipInfo && (
          <div className="context-bar">
            <span className="info mono">
              clip {selectedClipInfo.clip.id} · start {timecode(selectedClipInfo.clip.start)} ·
              dur {timecode(selectedClipInfo.clip.duration)} · in {timecode(selectedClipInfo.clip.source_in)}
            </span>
            <button className="btn" onClick={doSplit} disabled={!canSplitHere}
              title={canSplitHere ? "Split at the playhead" : "Move the playhead inside the clip to split"}>
              Split at playhead
            </button>
            <button className="btn danger" onClick={doDeleteClip}>Delete</button>
            <button className="btn text" onClick={() => setSelected(null)}>Deselect</button>
          </div>
        )}
      </main>

      {exportOpen && shape && (
        <ExportSheet
          shape={shape}
          selected={selected}
          onClose={(changed) => {
            setExportOpen(false);
            if (changed) refresh();
          }}
          notify={notify}
        />
      )}
    </>
  );
}

// re-export for tests/tooling without breaking tree-shaking
export { secondsToTickRat };
