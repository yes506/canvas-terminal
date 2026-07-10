import { useCallback, useEffect, useMemo, useState } from "react";

interface Health {
  ok: boolean;
  port: number;
  pid: number;
  session_alive: boolean;
}

interface SnapshotEntry {
  path: string;
  size: number;
  mtime_ms: number;
}

type SnapshotResponse =
  | { status: "alive"; pid: number; files: SnapshotEntry[] }
  | { status: "ended" };

interface FileResponse {
  path: string;
  content: string;
  size: number;
  mtime_ms: number;
}

type DashboardEvent =
  | { kind: "file-added"; path: string; mtime_ms: number }
  | { kind: "file-changed"; path: string; mtime_ms: number }
  | { kind: "file-removed"; path: string };

type EventLogEntry = DashboardEvent & { receivedAt: number };

const FETCH_OPTS: RequestInit = { credentials: "include" };

const styles = {
  root: {
    display: "grid",
    gridTemplateColumns: "260px 1fr 320px",
    gridTemplateRows: "44px 1fr",
    gridTemplateAreas: '"header header header" "files viewer events"',
    height: "100vh",
    width: "100vw",
    background: "#0a0a0a",
    color: "#ddd",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    fontSize: 12,
    overflow: "hidden",
  } as const,
  header: {
    gridArea: "header",
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "0 16px",
    borderBottom: "1px solid #222",
    background: "#111",
  } as const,
  pane: {
    overflowY: "auto",
    overflowX: "hidden",
    height: "100%",
    minHeight: 0,
  } as const,
  filesPane: {
    gridArea: "files",
    borderRight: "1px solid #222",
    background: "#0e0e0e",
  } as const,
  viewerPane: {
    gridArea: "viewer",
    background: "#0a0a0a",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
  } as const,
  eventsPane: {
    gridArea: "events",
    borderLeft: "1px solid #222",
    background: "#0e0e0e",
  } as const,
  fileItem: (selected: boolean) => ({
    padding: "6px 12px",
    cursor: "pointer",
    borderLeft: selected ? "3px solid #7c3aed" : "3px solid transparent",
    background: selected ? "#1a1432" : "transparent",
    color: selected ? "#fff" : "#bbb",
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  }),
  meta: {
    color: "#666",
    fontSize: 10,
    paddingLeft: 4,
  } as const,
  viewerHeader: {
    padding: "8px 16px",
    borderBottom: "1px solid #222",
    background: "#111",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexShrink: 0,
    minWidth: 0,
  } as const,
  viewerPath: {
    color: "#fff",
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
    flex: 1,
  } as const,
  viewerMeta: {
    color: "#666",
    fontSize: 10,
    paddingLeft: 4,
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
  } as const,
  viewerBody: {
    flex: 1,
    overflow: "auto",
    padding: 16,
    minHeight: 0,
  } as const,
  pre: {
    margin: 0,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    color: "#ddd",
  } as const,
  pill: (color: string) => ({
    background: color,
    color: "#fff",
    padding: "2px 8px",
    borderRadius: 10,
    fontSize: 10,
    fontWeight: 600,
  }),
  ghostBtn: {
    background: "transparent",
    border: "1px solid #333",
    color: "#bbb",
    padding: "4px 10px",
    borderRadius: 4,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 11,
  } as const,
  eventRow: (kind: DashboardEvent["kind"]) => ({
    padding: "4px 12px",
    borderBottom: "1px solid #181818",
    fontSize: 11,
    color: kind === "file-added" ? "#7ee787" : kind === "file-removed" ? "#ff7b72" : "#ffd479",
    overflowWrap: "anywhere" as const,
  }),
  empty: { padding: 16, color: "#666", fontSize: 11 } as const,
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatRelative(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  if (delta < 1000) return "now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// Exported for the collab-isolation smoke test: session files now live in
// nested per-session subtrees (`<collabSessionId>/…`), so the per-segment
// encoding (slashes preserved as separators) is what keeps the
// `/api/sessions/current/files/*path` viewer working for nested paths.
export function encodePathForUrl(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileData, setFileData] = useState<FileResponse | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  // Set when a probeHealth fetch fails at the network layer (TypeError /
  // Failed to fetch). That's the only signal we get when the Tauri process
  // is fully gone — `/api/health` can't return `session_alive: false` if it
  // can't return anything at all. Cleared on the next successful probe so
  // a transient network blip doesn't sticky to "ended".
  const [healthProbeFailed, setHealthProbeFailed] = useState(false);
  // Tick the clock so "Xs ago" labels stay fresh without re-fetching.
  const [, setNowTick] = useState(Date.now());

  // 1Hz clock tick. Cheap; only re-renders the file list and event log.
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const refreshSnapshot = useCallback(async () => {
    try {
      const r = await fetch("/api/sessions/current/snapshot", FETCH_OPTS);
      if (r.status === 410) {
        setSnapshot({ status: "ended" });
        return;
      }
      if (!r.ok) throw new Error(`/snapshot → ${r.status}`);
      const data: SnapshotResponse = await r.json();
      setSnapshot(data);
      setSnapshotError(null);
    } catch (e) {
      setSnapshotError(String(e));
    }
  }, []);

  // Initial snapshot fetch.
  useEffect(() => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  // Probe `/api/health` once. Used at mount and after SSE errors to
  // distinguish three states:
  //   - server alive, session alive    → `health.session_alive = true`
  //   - server alive, session ending   → `health.session_alive = false`
  //   - server gone (process died)     → fetch throws → `healthProbeFailed = true`
  // The third case is the one the previous round of reviewers flagged: with
  // only the first two signals, the pill could stuck on "reconnecting" forever
  // because `/api/health` is unreachable. Treating a network-layer fetch
  // failure as "session ended" closes that gap. Successful responses always
  // clear `healthProbeFailed` so a transient blip doesn't stick.
  const probeHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", FETCH_OPTS);
      setHealthProbeFailed(false);
      if (!r.ok) return;
      const h: Health = await r.json();
      setHealth(h);
    } catch {
      setHealthProbeFailed(true);
    }
  }, []);

  // Initial mount probe.
  useEffect(() => {
    probeHealth();
  }, [probeHealth]);

  // SSE connection. EventSource auto-reconnects on transient failures, which
  // is what we want during the brief shutdown-grace window. On 410 the
  // browser will keep retrying — but we re-probe /api/health on each error
  // so the pill flips to "session ended" within ~one fetch round-trip when
  // the Tauri process is actually gone.
  useEffect(() => {
    const es = new EventSource("/api/sessions/current/events", {
      withCredentials: true,
    });
    es.addEventListener("file", (raw) => {
      try {
        const ev = JSON.parse((raw as MessageEvent).data) as DashboardEvent;
        setEvents((prev) => {
          const next = [{ ...ev, receivedAt: Date.now() }, ...prev];
          // Cap at 200 entries — the live log isn't meant for forensics.
          return next.length > 200 ? next.slice(0, 200) : next;
        });
        // Any file event invalidates the cached snapshot. Keep it fresh.
        refreshSnapshot();
      } catch {
        // ignore parse errors — keepalive comments arrive as noop
      }
    });
    es.onopen = () => {
      setSseConnected(true);
      // Reset the network-failure flag — a successful SSE handshake means
      // the server is back. probeHealth on the next render will refresh
      // `health.session_alive` if it changed.
      setHealthProbeFailed(false);
      probeHealth();
    };
    es.onerror = () => {
      setSseConnected(false);
      // Cheap one-shot probe — flips the header pill to "session ended"
      // either when the server replies with `session_alive: false` OR when
      // the fetch itself fails (process gone).
      probeHealth();
    };
    return () => es.close();
  }, [refreshSnapshot, probeHealth]);

  // Whenever the selected path or snapshot changes, refetch the file body so
  // the viewer reflects the latest mtime. Selected path can outlive the file
  // (e.g. the agent deleted it); show fileError in that case.
  useEffect(() => {
    if (!selectedPath) {
      setFileData(null);
      setFileError(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/sessions/current/files/${encodePathForUrl(selectedPath)}`, FETCH_OPTS)
      .then((r) => {
        if (r.status === 404) throw new Error("File no longer exists");
        if (r.status === 410) throw new Error("Session ended");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: FileResponse) => {
        if (cancelled) return;
        setFileData(data);
        setFileError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setFileError(String(e));
        setFileData(null);
      });
    return () => {
      cancelled = true;
    };
    // snapshot included so we refetch on file mtime change
  }, [selectedPath, snapshot]);

  // Auto-select the first file on first successful snapshot, but never
  // overwrite a user choice.
  useEffect(() => {
    if (selectedPath) return;
    if (snapshot?.status === "alive" && snapshot.files.length > 0) {
      setSelectedPath(snapshot.files[0].path);
    }
  }, [snapshot, selectedPath]);

  const sessionEnded =
    health?.session_alive === false ||
    snapshot?.status === "ended" ||
    healthProbeFailed;

  const files = useMemo(
    () => (snapshot?.status === "alive" ? snapshot.files : []),
    [snapshot]
  );

  const now = Date.now();

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <strong style={{ color: "#7c3aed" }}>Canvas Terminal Dashboard</strong>
        {health && (
          <span style={styles.meta}>
            pid {health.pid} · port {health.port}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span
          style={styles.pill(
            sessionEnded ? "#7f1d1d" : sseConnected ? "#166534" : "#92400e"
          )}
        >
          {sessionEnded ? "session ended" : sseConnected ? "live" : "reconnecting"}
        </span>
        <button style={styles.ghostBtn} onClick={refreshSnapshot}>
          refresh
        </button>
      </header>

      <div style={{ ...styles.pane, ...styles.filesPane }}>
        {snapshotError && <div style={styles.empty}>{snapshotError}</div>}
        {!snapshotError && files.length === 0 && (
          <div style={styles.empty}>
            No files in the session yet. Start a Collaborator session to populate it.
          </div>
        )}
        {files.map((f) => (
          <div
            key={f.path}
            style={styles.fileItem(f.path === selectedPath)}
            onClick={() => setSelectedPath(f.path)}
            title={`${f.path} · ${formatBytes(f.size)} · ${formatRelative(
              f.mtime_ms,
              now
            )}`}
          >
            {f.path}
            <div style={styles.meta}>
              {formatBytes(f.size)} · {formatRelative(f.mtime_ms, now)}
            </div>
          </div>
        ))}
      </div>

      <div style={styles.viewerPane}>
        <div style={styles.viewerHeader}>
          <span style={styles.viewerPath} title={selectedPath ?? undefined}>
            {selectedPath ?? "no file selected"}
          </span>
          {fileData && (
            <span style={styles.viewerMeta}>
              {formatBytes(fileData.size)} · last modified {formatRelative(fileData.mtime_ms, now)}
            </span>
          )}
        </div>
        <div style={styles.viewerBody}>
          {fileError && (
            <pre style={{ ...styles.pre, color: "#ff7b72" }}>{fileError}</pre>
          )}
          {fileData && <pre style={styles.pre}>{fileData.content}</pre>}
          {!fileData && !fileError && !selectedPath && (
            <div style={styles.empty}>Select a file from the list on the left.</div>
          )}
        </div>
      </div>

      <div style={{ ...styles.pane, ...styles.eventsPane }}>
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid #222",
            color: "#888",
            fontSize: 11,
          }}
        >
          live events ({events.length})
        </div>
        {events.length === 0 && (
          <div style={styles.empty}>
            No file activity yet. Events will appear here as agents write to
            shared memory.
          </div>
        )}
        {events.map((ev, idx) => (
          <div key={idx} style={styles.eventRow(ev.kind)}>
            <span style={{ color: "#666" }}>{formatTime(ev.receivedAt)}</span>{" "}
            <span style={{ color: "#999" }}>{ev.kind}</span>{" "}
            <span style={{ color: "#ddd" }}>{ev.path}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
