import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import type { ProjectEntry } from "../api";

function fmtTime(secs: number | null): string {
  if (!secs) return "—";
  const d = new Date(secs * 1000);
  return d.toLocaleString();
}

export default function Home({
  onOpen,
  onSettings,
  notify,
}: {
  onOpen: (name: string) => void;
  onSettings: () => void;
  notify: (m: string, k?: "info" | "error") => void;
}) {
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [version, setVersion] = useState<{ server: string; engine_pin: string; engine_version: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, v] = await Promise.all([api.listProjects(), api.getVersion()]);
      setProjects(list.projects);
      setVersion(v);
    } catch (e) {
      notify(`cannot reach the engine server: ${(e as Error).message}`, "error");
      setProjects([]);
    }
  }, [notify]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const doCreate = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const shape = await api.createProject(name.trim());
      notify(`project '${name.trim()}' created`);
      setCreating(false);
      setName("");
      onOpen(shape.project?.name ?? name.trim());
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const doOpen = async (p: ProjectEntry) => {
    if (!p.exists_on_disk) {
      notify("project folder is missing on disk — delete it from the registry", "error");
      return;
    }
    setBusy(true);
    try {
      await api.openProject(p.name);
      onOpen(p.name);
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (p: ProjectEntry) => {
    if (!confirm(`Delete project '${p.name}' and ALL of its media on disk? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.deleteProject(p.name);
      notify(`project '${p.name}' deleted`);
      refresh();
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="appbar">
        <span className="title">OVE Studio</span>
        <span className="subtitle">
          {version ? `server ${version.server} · engine ${version.engine_version} @ ${version.engine_pin.slice(0, 12)}` : "connecting…"}
        </span>
        <button className="btn text" onClick={onSettings}>Settings</button>
      </header>
      <main className="home">
        <div className="head">
          <h1>Projects</h1>
          <button
            className="btn primary"
            onClick={() => setCreating(true)}
            disabled={busy}
          >
            New project
          </button>
        </div>

        {projects === null && <div className="empty">Loading…</div>}

        {projects !== null && projects.length === 0 && (
          <div className="empty">
            <p>No projects yet.</p>
            <p>Create one, then import real media in the editor.</p>
          </div>
        )}

        {projects?.map((p) => (
          <div key={p.name} className={`card ${p.exists_on_disk ? "" : "missing"}`}>
            <div className="meta">
              <div className="name">{p.name}</div>
              <div className="sub">
                {p.exists_on_disk
                  ? `last opened ${fmtTime(p.last_opened)}`
                  : "folder missing on disk"}
              </div>
            </div>
            <button className="btn primary" disabled={busy || !p.exists_on_disk} onClick={() => doOpen(p)}>
              Open
            </button>
            <button className="btn danger text" disabled={busy} onClick={() => doDelete(p)}>
              Delete
            </button>
          </div>
        ))}
      </main>

      {creating && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h2>New project</h2>
            <p className="muted">
              A project is a folder on the server's disk (engine-authoritative
              format). Name: letters, digits, dash, underscore.
            </p>
            <input
              className="field"
              autoFocus
              placeholder="project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doCreate()}
            />
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn text" onClick={() => setCreating(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={doCreate} disabled={busy || !name.trim()}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
