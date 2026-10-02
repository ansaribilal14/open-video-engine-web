import { useEffect, useState } from "react";
import * as api from "../api";

export default function SettingsView({ onBack }: { onBack: () => void }) {
  const [info, setInfo] = useState<api.SettingsInfo | null>(null);

  useEffect(() => {
    api.getSettings().then(setInfo).catch(() => setInfo(null));
  }, []);

  return (
    <>
      <header className="appbar">
        <button className="icon-btn" onClick={onBack} aria-label="back">‹</button>
        <span className="title">Settings & diagnostics</span>
      </header>
      <main className="home">
        {!info && <div className="empty">Loading…</div>}
        {info && (
          <>
            <h2>Engine</h2>
            <div className="card">
              <div className="meta">
                <div className="name">Open Video Engine {info.server}</div>
                <div className="sub mono">pinned commit {info.engine_pin}</div>
                <div className="sub">data root {info.data_root}</div>
              </div>
              <span className="badge">{info.single_writer ? "single-writer session" : "session"}</span>
            </div>

            <hr className="sep" />

            <h2>Honest product limitations</h2>
            <p className="muted">
              These are engine-interface limits and client v0.1.0 scope
              decisions — surfaced verbatim from the server's own registry.
              Nothing here is hidden or faked.
            </p>
            <ul className="limitations">
              {info.limitations.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>

            <hr className="sep" />

            <h2>About</h2>
            <p className="muted">
              OVE Studio Web is an independent client of the Open Video Engine
              (repository <span className="mono">open-video-engine-web</span>).
              The engine is a read-only dependency pinned by commit hash; all
              decoding, rendering, editing semantics, persistence and exports
              are performed by the engine session hosted by the local server.
            </p>
          </>
        )}
      </main>
    </>
  );
}
