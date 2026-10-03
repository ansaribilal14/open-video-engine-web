// Typed HTTP client for the ove-web API.
// Envelopes: {"ok":true,...} | {"ok":false,"kind":...,"message":...}
// Rationals: [num, den].

import type { Rat } from "./rational";

// ---------------------------------------------------------------------------
// Server base — hosted-UI mode.
//
// This UI may be served from static hosting (e.g. Netlify) while the real
// engine runs LOCALLY in the ove-web binary (libav cannot run in a browser —
// ENGINE_INTEGRATION_AUDIT §2). The API base is resolved once per load:
//   1. `?server=<url>` query param (wins; persisted to localStorage; empty
//      value clears the override and returns to same-origin)
//   2. previously saved value in localStorage ("ove.serverUrl")
//   3. same-origin (the normal single-binary deployment)
// A cross-origin server only works if it was started with OVE_WEB_ALLOW_ORIGIN
// allowing this page's origin — a deliberate, documented opt-in (README).
// ---------------------------------------------------------------------------
function resolveServerBase(): string {
  try {
    const q = new URLSearchParams(window.location.search).get("server");
    if (q !== null) {
      const v = q.trim().replace(/\/+$/, "");
      localStorage.setItem("ove.serverUrl", v);
      return v;
    }
    const saved = localStorage.getItem("ove.serverUrl");
    return saved ? saved.replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

export const serverBase: string = resolveServerBase();
export const sameOrigin: boolean = serverBase === "";

/// Prefix an API path with the configured server base.
export function apiPath(path: string): string {
  return serverBase + path;
}

/// Persist a new server base ("" = same-origin) and return to the bare page
/// path so a stale `?server=` query param cannot override the saved value on
/// the next load.
export function setServerBase(url: string): void {
  localStorage.setItem("ove.serverUrl", url.trim().replace(/\/+$/, ""));
  window.location.assign(window.location.pathname);
}

export interface ProbeStream {
  kind: string;
  codec: string;
  time_base: Rat;
  duration: Rat | null;
  avg_frame_rate: Rat | null;
  video: { width: number; height: number } | null;
  audio: { sample_rate: number; channels: number } | null;
}

export interface Probe {
  duration: Rat | null;
  streams: ProbeStream[];
}

export interface Asset {
  id: number;
  hash: string;
  probe: Probe | null;
}

export interface Clip {
  id: number;
  start: Rat;
  duration: Rat;
  source_in: Rat;
}

export interface Track {
  id: number;
  clips: Clip[];
}

export interface Shape {
  ok: true;
  state_hash: string;
  undo_depth: number;
  assets: Asset[];
  tracks: Track[];
  timeline_span: Rat;
  render_source: string | null;
  multi_source_limit: boolean;
  hash?: string;
  clip_id?: number;
  new_clip_id?: number;
  did?: boolean;
  project?: { name: string; dir: string };
}

export interface ApiErrorShape {
  ok: false;
  kind: string;
  message: string;
}

export type ApiResult<T> = T | ApiErrorShape;

export function isErr(v: unknown): v is ApiErrorShape {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { ok?: unknown }).ok === false
  );
}

export class EngineCallError extends Error {
  kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

async function unwrap<T>(r: Response): Promise<T> {
  const body: unknown = await r.json();
  if (
    typeof body === "object" &&
    body !== null &&
    (body as { ok?: unknown }).ok === false
  ) {
    const b = body as ApiErrorShape;
    throw new EngineCallError(b.kind, b.message);
  }
  return body as T;
}

export async function getVersion(): Promise<{
  ok: true;
  server: string;
  engine_pin: string;
  engine_version: string;
  ui_available: boolean;
  data_root: string;
  engine_busy: boolean;
}> {
  const r = await fetch(apiPath("/api/version"));
  return unwrap(r);
}

export interface SettingsInfo {
  ok: true;
  server: string;
  engine_pin: string;
  data_root: string;
  single_writer: boolean;
  engine_busy: boolean;
  limitations: string[];
}

export async function getSettings(): Promise<SettingsInfo> {
  const r = await fetch(apiPath("/api/settings"));
  return unwrap(r);
}

export interface ProjectEntry {
  name: string;
  exists_on_disk: boolean;
  created: number | null;
  last_opened: number | null;
}

export async function listProjects(): Promise<{ ok: true; projects: ProjectEntry[] }> {
  const r = await fetch(apiPath("/api/projects"));
  return unwrap(r);
}

export async function createProject(name: string): Promise<Shape> {
  const r = await fetch(apiPath("/api/projects/create"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, tick: [48000, 1] }),
  });
  return unwrap(r);
}

export async function openProject(name: string): Promise<Shape> {
  const r = await fetch(apiPath("/api/projects/open"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return unwrap(r);
}

export async function closeProject(): Promise<{ ok: true; closed: boolean }> {
  const r = await fetch(apiPath("/api/projects/close"), { method: "POST" });
  return unwrap(r);
}

export async function deleteProject(name: string): Promise<{ ok: true; deleted: string }> {
  const r = await fetch(apiPath("/api/projects/delete"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return unwrap(r);
}

export interface ImportProgress {
  (loaded: number, total: number): void;
}

/// Multipart upload with REAL progress (XHR — fetch cannot report upload
/// progress). The server stages the file, the engine copies it into its
/// content-addressed assets, then the staging copy is deleted.
export function importMedia(
  file: File,
  onProgress: ImportProgress,
): Promise<Shape> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiPath("/api/media/import"));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (body.ok === false) reject(new EngineCallError(body.kind, body.message));
        else resolve(body as Shape);
      } catch (err) {
        reject(new EngineCallError("BadRequest", `malformed response (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new EngineCallError("NetworkError", "upload failed"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export async function addTrack(id: number): Promise<Shape> {
  const r = await fetch(apiPath("/api/track/add"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return unwrap(r);
}

/// Current UI projection of the live document (engine-authoritative via
/// state_hash — the client verifies after every mutation batch).
export async function getShape(): Promise<Shape> {
  const r = await fetch(apiPath("/api/shape"));
  return unwrap(r);
}

export async function addClip(track: number, hash: string, duration: Rat, source_in: Rat): Promise<Shape> {
  const r = await fetch(apiPath("/api/clip/add"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ track, hash, duration, source_in }),
  });
  return unwrap(r);
}

export async function splitClip(track: number, clip: number, at: Rat): Promise<Shape> {
  const r = await fetch(apiPath("/api/clip/split"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ track, clip, at }),
  });
  return unwrap(r);
}

export async function resizeClip(track: number, clip: number, duration: Rat): Promise<Shape> {
  const r = await fetch(apiPath("/api/clip/resize"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ track, clip, duration }),
  });
  return unwrap(r);
}

export async function moveClip(clip: number, from: number, to: number, index: number): Promise<Shape> {
  const r = await fetch(apiPath("/api/clip/move"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clip, from, to, index }),
  });
  return unwrap(r);
}

export async function removeClip(track: number, clip: number): Promise<Shape> {
  const r = await fetch(apiPath("/api/clip/remove"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ track, clip }),
  });
  return unwrap(r);
}

export async function undo(): Promise<Shape> {
  const r = await fetch(apiPath("/api/undo"), { method: "POST" });
  return unwrap(r);
}

export async function redo(): Promise<Shape> {
  const r = await fetch(apiPath("/api/redo"), { method: "POST" });
  return unwrap(r);
}

export function frameUrl(t: Rat, w: number, h: number): string {
  return apiPath(`/api/frame?num=${t[0]}&den=${t[1]}&w=${w}&h=${h}`);
}

// ---------------------------------------------------------------------------
// Exports — background jobs (honest indeterminate progress; no cancel:
// the engine exposes no progress callback and no cancellation, gap #6)
// ---------------------------------------------------------------------------
export type ExportStart = { ok: true; started: true; job: string };

export type ExportStatus =
  | { ok: true; running: true; kind: string }
  | ({ ok: true; kind: string; path: string; sha256?: string; size?: number; frames?: number; samples?: number; file: string })
  | { ok: false; running: false; kind: string; message: string };

export async function startCompositeExport(rate: Rat): Promise<ExportStart> {
  const r = await fetch(apiPath("/api/export/reencode"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rate }),
  });
  return unwrap(r);
}

export async function startSegmentExport(hash: string, start: Rat, end: Rat): Promise<ExportStart> {
  const r = await fetch(apiPath("/api/export/copy"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash, start, end }),
  });
  return unwrap(r);
}

export async function startWavExport(): Promise<ExportStart> {
  const r = await fetch(apiPath("/api/export/wav"), { method: "POST" });
  return unwrap(r);
}

export async function exportStatus(): Promise<ExportStatus> {
  const r = await fetch(apiPath("/api/export/status"));
  return r.json();
}
