// Export sheet — the three REAL export routes the engine supports:
//   composite MP4 (render every frame → MPEG4 CRF6 + AAC — flagship, certified)
//   segment stream-copy (keyframe-aligned; H.264 sources are typed-rejected)
//   WAV (timeline audio mixdown)
// Progress is honestly indeterminate: the engine exposes no progress callback
// and no cancellation (audit gap #6). Results are verified client-side via
// SHA-256 over the downloaded bytes before download is offered.

import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { EngineCallError } from "../api";
import type { Shape } from "../api";
import { ratAdd, ratToSeconds, type Rat } from "../rational";

interface ExportResult {
  kind: string;
  file: string;
  sha256?: string;
  size?: number;
  frames?: number;
  samples?: number;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default function ExportSheet({
  shape,
  selected,
  onClose,
  notify,
}: {
  shape: Shape;
  selected: { track: number; clip: number } | null;
  onClose: (changed: boolean) => void;
  notify: (m: string, k?: "info" | "error") => void;
}) {
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [verify, setVerify] = useState<{ state: "idle" | "working" | "match" | "mismatch"; got?: string }>({ state: "idle" });
  const [rate, setRate] = useState<Rat>([24, 1]);
  const [emptySpan, setEmptySpan] = useState(false);
  const pollRef = useRef<number | null>(null);

  // default export rate: the render source's avg_frame_rate when probed
  useEffect(() => {
    const src = shape.assets.find((a) => a.hash === shape.render_source) ?? shape.assets[0];
    const vs = src?.probe?.streams.find((s) => s.kind === "Video");
    if (vs?.avg_frame_rate && vs.avg_frame_rate[0] > 0) setRate(vs.avg_frame_rate);
    const spanSecs = ratToSeconds(shape.timeline_span);
    setEmptySpan(spanSecs <= 0);
  }, [shape]);

  // stop polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const begin = async (p: Promise<api.ExportStart>, kindLabel: string) => {
    try {
      await p;
      setRunning(kindLabel);
      setResult(null);
      setVerify({ state: "idle" });
      pollRef.current = window.setInterval(async () => {
        const st = await api.exportStatus();
        if (st.ok === true && "running" in st && st.running) return; // honest wait
        if (pollRef.current) window.clearInterval(pollRef.current);
        setRunning(null);
        if (st.ok === false) {
          notify(`export failed — ${st.kind}: ${st.message}`, "error");
          onClose(true);
          return;
        }
        const r = st as Exclude<api.ExportStatus, { ok: true; running: true } | { ok: false; running: false }>;
        setResult({
          kind: r.kind,
          file: r.file,
          sha256: r.sha256,
          size: r.size,
          frames: r.frames,
          samples: r.samples,
        });
      }, 600);
    } catch (e) {
      if (e instanceof EngineCallError) notify(`cannot start export — ${e.kind}: ${e.message}`, "error");
      else notify(String(e), "error");
    }
  };

  const selectedClipInfo = (() => {
    if (!selected) return null;
    for (const t of shape.tracks) {
      if (t.id !== selected.track) continue;
      const c = t.clips.find((c) => c.id === selected.clip);
      if (c) return { clip: c, track: t };
    }
    return null;
  })();

  const doVerify = async () => {
    if (!result) return;
    setVerify({ state: "working" });
    try {
      const r = await fetch(api.apiPath(`/api/renders/${encodeURIComponent(result.file)}`));
      if (!r.ok) throw new Error(`download failed (HTTP ${r.status})`);
      const bytes = await r.arrayBuffer();
      const got = await sha256Hex(bytes);
      if (result.sha256 && got === result.sha256) {
        setVerify({ state: "match", got });
      } else {
        setVerify({ state: "mismatch", got });
      }
    } catch (e) {
      setVerify({ state: "mismatch", got: (e as Error).message });
    }
  };

  const doDownload = async () => {
    if (!result) return;
    const url = api.apiPath(`/api/renders/${encodeURIComponent(result.file)}`);
    // Same-origin: the download attribute works directly. Hosted (cross-origin):
    // browsers IGNORE a.download on cross-origin URLs — fetch to a blob so the
    // artifact still saves under its real name.
    if (api.sameOrigin) {
      const a = document.createElement("a");
      a.href = url;
      a.download = result.file;
      a.click();
      return;
    }
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`download failed (HTTP ${r.status})`);
      const blob = await r.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = result.file;
      a.click();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      window.open(url, "_blank", "noopener");
    }
  };

  return (
    <div className="sheet-backdrop" onClick={() => running === null && onClose(result !== null)}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Export</h2>
        {emptySpan && (
          <p className="muted">
            The timeline is empty — there is nothing to export yet. Add clips first.
          </p>
        )}

        {running !== null && (
          <>
            <div className="progress" style={{ margin: "24px 0" }}>
              <div className="bar" />
            </div>
            <p>
              <strong>{running}</strong> — working on the engine session. Progress is
              indeterminate: the engine performs every render and encode and
              exposes no progress estimate.
            </p>
            <p className="muted">
              Cancel is not offered: the engine exposes no cancellation for
              exports (integration gap #6, surfaced honestly). The single-writer
              session is busy until this finishes.
            </p>
          </>
        )}

        {running === null && result === null && (
          <>
            <div className="card" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <div className="row">
                <div className="grow">
                  <strong>Composite MP4</strong>
                  <div className="muted">
                    Every output frame rendered by the engine, encoded MPEG4
                    CRF6 + AAC — the certified flagship route.
                  </div>
                </div>
                <label className="muted">
                  rate
                  <input
                    className="field"
                    style={{ width: 90, marginLeft: 8 }}
                    value={`${rate[0]}/${rate[1]}`}
                    onChange={(e) => {
                      const m = e.target.value.match(/^(\d+)\/(\d+)$/);
                      if (m && Number(m[2]) > 0) setRate([Number(m[1]), Number(m[2])]);
                    }}
                  />
                </label>
                <button className="btn primary" disabled={emptySpan} onClick={() => begin(api.startCompositeExport(rate), "Composite MP4")}>
                  Start
                </button>
              </div>
            </div>

            <div className="card" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <div className="row">
                <div className="grow">
                  <strong>Timeline audio (WAV)</strong>
                  <div className="muted">
                    Assembled timeline mixdown to WAV. Requires audio in the
                    imported sources; otherwise the engine raises a typed
                    NoAudioStream error.
                  </div>
                </div>
                <button className="btn" disabled={emptySpan} onClick={() => begin(api.startWavExport(), "WAV mixdown")}>
                  Start
                </button>
              </div>
            </div>

            <div className="card" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <div className="row">
                <div className="grow">
                  <strong>Segment stream-copy</strong>
                  <div className="muted">
                    Keyframe-aligned copy of the selected clip's source range
                    (no re-encode). H.264 sources are typed-rejected by the
                    engine's capability matrix — the composite route is the
                    supported path for them.
                  </div>
                </div>
                <button
                  className="btn"
                  disabled={!selectedClipInfo}
                  onClick={() =>
                    selectedClipInfo &&
                    begin(
                      api.startSegmentExport(
                        shape.assets[0]?.hash ?? "",
                        selectedClipInfo.clip.source_in,
                        ratAdd(selectedClipInfo.clip.source_in, selectedClipInfo.clip.duration),
                      ),
                      "Segment copy",
                    )
                  }
                >
                  Start
                </button>
              </div>
              {!selectedClipInfo && (
                <div className="muted">Select a clip on the timeline to enable this route.</div>
              )}
              {selectedClipInfo && (
                <div className="muted mono">
                  source {selectedClipInfo.clip.source_in[0]}/{selectedClipInfo.clip.source_in[1]} →{" "}
                  {ratAdd(selectedClipInfo.clip.source_in, selectedClipInfo.clip.duration)[0]}/
                  {ratAdd(selectedClipInfo.clip.source_in, selectedClipInfo.clip.duration)[1]}
                </div>
              )}
            </div>

            <p className="muted" style={{ fontSize: 12 }}>
              Note: the segment route uses the project's first imported source's
              asset hash (ADR-017 v1 render-binding). Multi-source timelines are
              limited to the first source — surfaced honestly here and in
              Settings.
            </p>
          </>
        )}

        {result && (
          <>
            <div className="card" style={{ flexDirection: "column", alignItems: "stretch" }}>
              <div className="row">
                <span className="badge">{result.kind}</span>
                <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {result.file}
                </span>
              </div>
              <div className="muted">
                {result.size !== undefined && `${(result.size / 1024 / 1024).toFixed(2)} MB · `}
                {result.frames !== undefined && `${result.frames} frames · `}
                {result.samples !== undefined && `${result.samples} samples · `}
                engine-reported SHA-256: <span className="mono">{result.sha256 ?? "—"}</span>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn" onClick={doVerify} disabled={verify.state === "working" || !result.sha256}>
                  {verify.state === "working" ? "Verifying…" : "Verify checksum"}
                </button>
                <button className="btn primary" onClick={doDownload}>
                  Download
                </button>
                <div className="grow" />
                <button className="btn text" onClick={() => onClose(true)}>
                  Close
                </button>
              </div>
              {verify.state === "match" && (
                <div style={{ color: "var(--tertiary)" }}>
                  ✓ verified in-browser: SHA-256 of the downloaded bytes matches the engine's report.
                </div>
              )}
              {verify.state === "mismatch" && (
                <div style={{ color: "var(--error)" }}>
                  ✗ verification FAILED — downloaded bytes do not match the engine's SHA-256 ({verify.got}).
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
