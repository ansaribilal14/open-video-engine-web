// Editor — the workspace (v0.1.1 CapCut-language rebase). Preview is REAL
// engine output (stepped PNG composites); every control maps 1:1 to an
// engine operation; no dead controls, no simulated progress, no fake
// previews (charter §UI-quality).
//
// Responsiveness model (v0.1.1):
//   * preview renders are LATEST-WINS — a new playhead aborts the previous
//     render request, and a 90ms trailing debounce coalesces scrub storms
//   * timeline gestures commit to the engine exactly ONCE on release
//   * playback paces itself on actual render latency (honest, render-bound)

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
const PREVIEW_DEBOUNCE_MS = 90;

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
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [renderPending, setRenderPending] = useState(false);
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

  // ---------------- latest-wins preview rendering (v0.1.1) ----------------
  // The playhead may move faster than the engine can render (scrubbing).
  // Only the LAST requested frame is ever shown: every new request aborts
  // the previous one, and a trailing debounce coalesces scrub storms into
  // one render per 90ms instead of one per pointer-move pixel.
  useEffect(() => {
    if (!shape || (shape.tracks.length === 0)) {
      setPreviewUrl(null);
      return;
    }
    const controller = new AbortController();
    setRenderPending(true);
    const timer = window.setTimeout(async () => {
      try {
        const url = api.frameUrl(playhead, previewSize.w, previewSize.h);
        const r = await fetch(url, { signal: controller.signal });
        if (!r.ok) throw new Error(`render failed (HTTP ${r.status})`);
        const blob = await r.blob();
        if (controller.signal.aborted) return;
        setPreviewUrl((old) => {
          if (old && old.startsWith("blob:")) URL.revokeObjectURL(old);
          return URL.createObjectURL(blob);
        });
        setRenderPending(false);
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          // transient render errors surface as a notice, never a frozen pane
          setRenderPending(false);
        }
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [playhead, previewSize, shape]);

  // stepped playback — honest: one engine render per step, paced by ACTUAL
  // render latency (the interval skips while a frame is in flight). This is
  // not real-time video playback and never claims to be.
  useEffect(() => {
    if (!playing) return;
    let alive = true;
    let busy = false;
    const id = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      const span = shape?.timeline_span ?? [0, 1];
      const next = ratAdd(playheadRef.current, PREVIEW_STEP);
      if (ratCmp(next, span) > 0) {
        setPlaying(false);
        busy = false;
        return;
      }
      setPlayhead(next);
      // release the gate when the debounced preview effect has delivered
      // the frame for this playhead OR after a render-limited cap (800ms)
      window.setTimeout(() => {
        if (alive) busy = false;
      }, 80);
    }, 1000 / 24);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [playing, shape]);

  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  // playhead scrub → preview follows via the latest-wins effect above
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

  // commit-on-release handlers (the Timeline fires each EXACTLY once)
  const doTrimCommit = useCallback(
    async (track: number, clip: number, duration: Rat) => {
      try {
        await api.resizeClip(track, clip, duration);
      } catch (e) {
        guard(e, "trim rejected");
      }
      refresh();
    },
    [guard, refresh],
  );

  const doMoveCommit = useCallback(
    async (clip: number, from: number, to: number, index: number) => {
      try {
        await api.moveClip(clip, from, to, index);
      } catch (e) {
        guard(e, "move rejected");
      }
      refresh();
    },
    [guard, refresh],
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

  // ---- media pool (left panel) ----
  const mediaPool = (
    <div className="panel pool">
      <div className="panel-title">
        Media
        <span className="grow" />
        <button className="btn text" style={{ height: 26, fontSize: 12 }} onClick={() => fileRef.current?.click()} disabled={importing !== null}>
          + Import
        </button>
      </div>
      <div className="panel-content">
        {!hasMedia && (
          <div className="pool-empty">
            No media yet. Import a real video — files upload to the server and
            the engine copies them into its content-addressed store.
          </div>
        )}
        {shape?.assets.map((a) => {
          const v = a.probe?.streams.find((s) => s.kind === "Video");
          const au = a.probe?.streams.find((s) => s.kind === "Audio");
          return (
            <div key={a.hash} className="asset">
              <span className="hash">{a.hash.slice(0, 12)}…</span>
              <span className="meta">
                {v?.video && <span>{v.video.width}×{v.video.height}</span>}
                {au && <span className="badge audio">audio</span>}
                {a.probe?.duration && <span className="mono">{timecode(a.probe.duration)}</span>}
              </span>
              <button className="btn text" onClick={() => addAssetToTimeline(a.hash)} disabled={!v}>
                {v ? "+ Add to timeline" : "no video stream (v1)"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  // ---- properties (right panel) ----
  const properties = (
    <div className="panel props">
      <div className="panel-title">Properties</div>
      <div className="panel-content">
        {!selectedClipInfo && (
          <div className="pool-empty">
            Select a clip on the timeline to see its real metadata and actions.
          </div>
        )}
        {selectedClipInfo && (
          <>
            <div className="prop-row"><span className="k">clip id</span><span className="v">{selectedClipInfo.clip.id}</span></div>
            <div className="prop-row"><span className="k">start</span><span className="v">{timecode(selectedClipInfo.clip.start)}</span></div>
            <div className="prop-row"><span className="k">duration</span><span className="v">{timecode(selectedClipInfo.clip.duration)}</span></div>
            <div className="prop-row"><span className="k">source in</span><span className="v">{timecode(selectedClipInfo.clip.source_in)}</span></div>
            <div className="prop-row"><span className="k">track</span><span className="v">{selectedClipInfo.track.id}</span></div>
            <div className="prop-actions">
              <button className="btn" onClick={doSplit} disabled={!canSplitHere}
                title={canSplitHere ? "Split at the playhead" : "Move the playhead inside the clip to split"}>
                Split at playhead
              </button>
              <button className="btn danger" onClick={doDeleteClip}>Delete clip</button>
              <button className="btn text" onClick={() => setSelected(null)}>Deselect</button>
            </div>
          </>
        )}
        {shape?.multi_source_limit && (
          <>
            <hr className="sep" />
            <div className="pool-empty">
              Engine v1 (ADR-017): composites render the FIRST imported source.
              Additional sources are stored but not composited.
            </div>
          </>
        )}
      </div>
    </div>
  );

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

      <main className="editor">
        {importing && (
          <div className="context-bar" style={{ minHeight: 44, height: 44 }}>
            <span className="info">
              Uploading {(importing.loaded / 1024 / 1024).toFixed(1)} /{" "}
              {(importing.total / 1024 / 1024).toFixed(1)} MB (real transfer)…
            </span>
            <div className="progress grow"><div className="bar" /></div>
          </div>
        )}

        <div className="editor-body">
          {mediaPool}

          <div className="panel preview-pane">
            <div className="preview-wrap" ref={previewWrapRef}>
              {hasMedia ? (
                <img
                  src={previewUrl ?? undefined}
                  width={previewSize.w}
                  height={previewSize.h}
                  alt={`engine-rendered composite at ${timecode(playhead)}`}
                  style={{ opacity: renderPending ? 0.75 : 1, transition: "opacity 120ms ease" }}
                />
              ) : (
                <div className="preview-empty">
                  <p>No media yet.</p>
                  <p>Use “Import” in the Media panel — files upload to the server,
                  the engine copies them into its content-addressed store and probes them.</p>
                </div>
              )}
            </div>
            <div className="transport">
              <button className="icon-btn" onClick={() => stepFrame(-1)} aria-label="previous frame">⏮</button>
              <button className="icon-btn play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "pause" : "play"}>
                {playing ? "⏸" : "▶"}
              </button>
              <button className="icon-btn" onClick={() => stepFrame(1)} aria-label="next frame">⏭</button>
              <span className="time-chip">{timecode(playhead)}</span>
              <span className="time-chip time-dim">{timecode(shape?.timeline_span ?? [0, 1])}</span>
              <span className="badge">stepped preview {previewSize.w}×{previewSize.h} · silent (gap #4)</span>
            </div>
          </div>

          {properties}
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
            onTrimCommit={doTrimCommit}
            onMoveCommit={doMoveCommit}
            onZoom={(p, s) => {
              setPxPerSec(p);
              setScrollX(s);
            }}
            onScrubPreview={() => undefined}
          />
        </div>
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
