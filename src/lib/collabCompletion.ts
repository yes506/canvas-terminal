/**
 * Collaborator completion-signal codec, resolver, and failure policy.
 *
 * Pure, store-independent seam for the completion-signal → task-terminalization
 * pipeline (plan.md `collab-signal-hardening`, nodes N4/N5/N6/N7). Nothing here
 * imports the Zustand store or any React/Tauri surface — the resolver takes a
 * structural `ReadonlyArray<{ id: string }>` so the dependency direction stays
 * inward (`collaboratorStore` / `commands` → THIS → `scopedCollabMemory`), never
 * a cycle. This keeps every rule below unit-testable in isolation.
 *
 * Three concerns, three exports groups:
 *  - N5 `resolveTaskId` — exact-first, grammar-aware, ambiguity-safe id match.
 *  - N4 `validateSignal` — strict, legacy-compatible schema. `report_path` is
 *    NEVER a reject reason (G1); it is carried as a separately-flagged field so
 *    a bad/absent report can never strand an otherwise-valid completion.
 *  - N6/N7 `classifyFailure` + `StabilityTracker` — typed disposition taxonomy
 *    and the concurrency-safe, time-based stability gate.
 */

// ---------------------------------------------------------------------------
// Task-id grammar (N5)
// ---------------------------------------------------------------------------

/** Stripped (short) id shown to agents, e.g. `task-1`. No leading zero. */
export const SHORT_ID_RE = /^task-[1-9]\d*$/;
/** Full stored id, e.g. `task-1-1785474396813` (13-digit minted suffix). */
export const FULL_ID_RE = /^task-[1-9]\d*-\d{13}$/;

/**
 * Remove exactly one trailing 13-digit `-<timestamp>` suffix, if present.
 * `task-1-1785474396813` → `task-1`; `task-1` → `task-1`. Used on BOTH the
 * stored id and the incoming id so a stripped payload matches a full stored id
 * and vice-versa (the reason the old `startsWith` matcher existed — but without
 * its `task-1`/`task-10` collision).
 */
export function stripTaskId(id: string): string {
  return id.replace(/-\d{13}$/, "");
}

/** True when `id` is a syntactically valid short OR full task id. */
export function isValidTaskId(id: string): boolean {
  return SHORT_ID_RE.test(id) || FULL_ID_RE.test(id);
}

export type ResolveResult<T> =
  | { kind: "unique"; task: T }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: T[] };

/**
 * N5 — resolve a (possibly stripped) task id against a task list.
 *
 * Two-stage, EXACT-FIRST so a fully-qualified id never becomes "ambiguous"
 * merely because two tasks share a short id:
 *   1. exactly one `t.id === id` → unique (wins immediately);
 *   2. else, if `id` is a valid task id, exactly one task whose
 *      `stripTaskId(t.id) === stripTaskId(id)` → unique;
 *   3. else `none`, or `ambiguous` when >1 normalized match.
 *
 * Rejects whitespace / arbitrary prefixes / extra suffixes by requiring the
 * incoming id to satisfy the grammar before any normalized comparison.
 * Generic over `{ id: string }` so callers keep their concrete task type.
 */
export function resolveTaskId<T extends { id: string }>(
  tasks: ReadonlyArray<T>,
  id: string,
): ResolveResult<T> {
  const trimmed = id.trim();
  if (trimmed.length === 0) return { kind: "none" };

  // Stage 1 — exact full/verbatim match takes precedence.
  const exact = tasks.filter((t) => t.id === trimmed);
  if (exact.length === 1) return { kind: "unique", task: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", matches: exact };

  // Stage 2 — normalized match, but only for a grammar-valid id (no arbitrary
  // prefixes). An id that isn't a valid short/full form matches nothing.
  if (!isValidTaskId(trimmed)) return { kind: "none" };
  const key = stripTaskId(trimmed);
  const norm = tasks.filter((t) => stripTaskId(t.id) === key);
  if (norm.length === 1) return { kind: "unique", task: norm[0] };
  if (norm.length > 1) return { kind: "ambiguous", matches: norm };
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Signal schema + validation (N4)
// ---------------------------------------------------------------------------

/** Terminal status a completion signal may request. */
export type SignalStatus = "completed" | "blocked";

/** Disposition of the optional `report_path` field — never blocks validation. */
export type ReportPathFlag =
  | { kind: "absent" }
  | { kind: "unsafe"; raw: string }
  | { kind: "usable"; path: string };

/** A structurally valid completion signal (report reference not yet stat'd). */
export interface CompletionSignal {
  taskId: string;
  status: SignalStatus;
  /** Resolved author handle, or null → caller falls back to the assignee. */
  author: string | null;
  reasoning: string | null;
  conclusion: string | null;
  /** Legacy free-form output field (kept for backward compatibility). */
  output: string | null;
  /** Never causes `ok:false`; N8 does the async existence/no-follow check. */
  reportPath: ReportPathFlag;
}

/** Typed reasons a signal is rejected (consumed by N6/N14). */
export type IngestFailReason =
  | "parse-error"
  | "not-an-object"
  | "missing-task-id"
  | "bad-task-id-type"
  | "missing-status"
  | "bad-status"
  | "bad-field-type"
  | "filename-payload-mismatch"
  | "author-agent-conflict";

export type ValidateResult =
  | { ok: true; value: CompletionSignal }
  | { ok: false; reason: IngestFailReason };

/** Strip exactly one `.done.json` suffix from a basename; null if not present. */
export function completionBasename(relPath: string): string | null {
  const base = relPath.split("/").pop() ?? relPath;
  if (!base.endsWith(".done.json")) return null;
  return base.slice(0, -".done.json".length);
}

/** A present optional string must be a non-empty-after-trim string. */
function optTrimmedString(v: unknown): { ok: boolean; value: string | null } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, value: null };
  const t = v.trim();
  return { ok: true, value: t.length === 0 ? null : t };
}

/** Shape-only report-path check. NEVER returns a reject — flags instead (G1). */
export function classifyReportPath(v: unknown): ReportPathFlag {
  if (v === undefined || v === null) return { kind: "absent" };
  if (typeof v !== "string" || v.trim().length === 0) {
    return { kind: "unsafe", raw: String(v) };
  }
  const raw = v.trim();
  // Session-relative, `.md`, no absolute root, no traversal, not a signal file.
  const unsafe =
    raw.startsWith("/") ||
    raw.split("/").some((seg) => seg === ".." || seg === ".") ||
    !raw.endsWith(".md") ||
    raw.endsWith(".done.json");
  return unsafe ? { kind: "unsafe", raw } : { kind: "usable", path: raw };
}

/**
 * N4 — parse + legacy-compatible strict schema. Pure (no filesystem).
 *
 * `ok:false` ONLY for structural problems: parse error, non-object,
 * missing/typed-wrong `task_id`, missing/invalid `status`, filename↔payload
 * disagreement, or an author/agent conflict. `report_path` problems are NEVER
 * `ok:false` (G1) — carried on `value.reportPath` for N8 to act on.
 *
 * Backward compatible: `author`/`agent`/prose are optional; a legacy `agent`
 * alias is accepted; on author-vs-agent disagreement, `author` wins (least
 * breaking vs the current `author ?? agent`) — the caller may log the ignored
 * alias. `fileName` is the relative path from the recursive listing.
 */
export function validateSignal(raw: string, fileName: string): ValidateResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "parse-error" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, reason: "not-an-object" };
  }
  const obj = data as Record<string, unknown>;

  if (obj.task_id === undefined || obj.task_id === null) {
    return { ok: false, reason: "missing-task-id" };
  }
  if (typeof obj.task_id !== "string" || obj.task_id.trim().length === 0) {
    return { ok: false, reason: "bad-task-id-type" };
  }
  const taskId = obj.task_id.trim();

  if (obj.status === undefined || obj.status === null) {
    return { ok: false, reason: "missing-status" };
  }
  if (obj.status !== "completed" && obj.status !== "blocked") {
    // Drops the old permissive "anything-not-blocked → completed" coercion.
    return { ok: false, reason: "bad-status" };
  }
  const status: SignalStatus = obj.status;

  // filename↔payload agreement via the SHARED canonicalizer (strip both sides).
  const fileId = completionBasename(fileName);
  if (fileId !== null && stripTaskId(fileId) !== stripTaskId(taskId)) {
    return { ok: false, reason: "filename-payload-mismatch" };
  }

  const authorRes = optTrimmedString(obj.author);
  const agentRes = optTrimmedString(obj.agent);
  const reasoningRes = optTrimmedString(obj.reasoning);
  const conclusionRes = optTrimmedString(obj.conclusion);
  const outputRes = optTrimmedString(obj.output);
  if (
    !authorRes.ok || !agentRes.ok || !reasoningRes.ok ||
    !conclusionRes.ok || !outputRes.ok
  ) {
    return { ok: false, reason: "bad-field-type" };
  }
  // author precedence over legacy agent; conflict only when BOTH present & differ.
  if (
    authorRes.value !== null && agentRes.value !== null &&
    authorRes.value !== agentRes.value
  ) {
    return { ok: false, reason: "author-agent-conflict" };
  }
  const author = authorRes.value ?? agentRes.value;

  return {
    ok: true,
    value: {
      taskId,
      status,
      author,
      reasoning: reasoningRes.value,
      conclusion: conclusionRes.value,
      output: outputRes.value,
      reportPath: classifyReportPath(obj.report_path),
    },
  };
}

// ---------------------------------------------------------------------------
// Failure taxonomy + stability gate (N6 / N7)
// ---------------------------------------------------------------------------

/** How the scanner should act on a given ingestion outcome. */
export type Disposition =
  | "terminalize" // valid + unique match — proceed immediately
  | "stabilize-then-quarantine" // content-derived error; gate on stability
  | "grace-then-quarantine" // no-match / wrong-session; honor 24h grace
  | "retry" // transient IPC — content unknown, never quarantine
  | "noop"; // file-gone / benign

/** The abstract failure kinds the scanner feeds to `classifyFailure`. */
export type FailureKind =
  | "content-error" // parse/schema/filename → stabilize
  | "ambiguous" // resolver ambiguous → content-derived → stabilize
  | "no-match" // resolver none, own session → grace
  | "wrong-session" // resolver matched another loaded session → grace+diagnose
  | "transient-ipc" // read/stat failed → retry
  | "file-gone"; // disappeared mid-scan → noop

/**
 * N6 — map an abstract failure kind to its disposition. Ambiguity is
 * content-derived (a non-atomic writer can momentarily expose valid-but-
 * ambiguous JSON), so it takes the SAME stability gate as parse/schema errors.
 * No-match keeps the longer 24h grace; transient IPC never quarantines.
 */
export function classifyFailure(kind: FailureKind): Disposition {
  switch (kind) {
    case "content-error":
    case "ambiguous":
      return "stabilize-then-quarantine";
    case "no-match":
    case "wrong-session":
      return "grace-then-quarantine";
    case "transient-ipc":
      return "retry";
    case "file-gone":
      return "noop";
  }
}

/** Minimal clock seam so fake-timer tests are deterministic. */
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/**
 * Minimum elapsed wall-clock between two distinct observations before a content
 * failure is "stable". Strictly greater than one 2 s poll period so two
 * overlapping scans firing near-simultaneously (onFlush + poll + exit) cannot
 * both advance the count on effectively the same instant.
 */
export const STABILITY_MIN_INTERVAL_MS = 3000;
/** Minimum file age (now − mtime) at the final observation. */
export const STABILITY_MIN_AGE_MS = 2500;

/** Deterministic, dependency-free content fingerprint (FNV-1a, 32-bit hex). */
export function contentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

interface TrackRecord {
  hash: string;
  errorCategory: string;
  mtimeMs: number;
  firstSeen: number;
  lastSeen: number;
}

/**
 * N7 — concurrency-safe, time-based stability gate for content-derived
 * quarantine AND the peer-visible diagnostic. A content failure is confirmed
 * only when the SAME `(contentHash, errorCategory)` is observed across ≥2
 * calls separated by `STABILITY_MIN_INTERVAL_MS`, with the file's mtime older
 * than `STABILITY_MIN_AGE_MS` at the final observation. Any change to
 * hash/mtime/errorCategory resets the record — so a still-being-written legacy
 * heredoc (whose bytes keep changing) never stabilizes and is neither
 * quarantined nor falsely reported.
 *
 * Instantiable with an injected clock (fake timers in tests) and per-key state
 * that PERSISTS across scan invocations. Bounded: `purge` drops keys on
 * success / quarantine / file-gone / teardown; callers should purge on those.
 * The per-path in-flight guard that prevents two overlapping scans from
 * double-entering ingestion lives in the scanner (wrapping the whole
 * per-file operation), not here.
 */
export class StabilityTracker {
  private records = new Map<string, TrackRecord>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly minIntervalMs: number = STABILITY_MIN_INTERVAL_MS,
    private readonly minAgeMs: number = STABILITY_MIN_AGE_MS,
  ) {}

  /**
   * Record one observation of a content failure and report whether it is now
   * stable enough to quarantine + diagnose. `key` is `${session} ${relPath}`.
   */
  observe(
    key: string,
    fingerprint: { hash: string; errorCategory: string; mtimeMs: number },
  ): boolean {
    const now = this.clock.now();
    const prev = this.records.get(key);
    const changed =
      !prev ||
      prev.hash !== fingerprint.hash ||
      prev.errorCategory !== fingerprint.errorCategory ||
      prev.mtimeMs !== fingerprint.mtimeMs;

    if (changed) {
      this.records.set(key, {
        hash: fingerprint.hash,
        errorCategory: fingerprint.errorCategory,
        mtimeMs: fingerprint.mtimeMs,
        firstSeen: now,
        lastSeen: now,
      });
      return false;
    }

    prev.lastSeen = now;
    const separated = now - prev.firstSeen >= this.minIntervalMs;
    const oldEnough = now - fingerprint.mtimeMs >= this.minAgeMs;
    return separated && oldEnough;
  }

  /** Convenience: observe with a raw file body (hashes it). */
  shouldQuarantine(
    key: string,
    body: string,
    errorCategory: string,
    mtimeMs: number,
  ): boolean {
    return this.observe(key, {
      hash: contentHash(body),
      errorCategory,
      mtimeMs,
    });
  }

  /** Drop a key's record (call on success / quarantine / file-gone / teardown). */
  purge(key: string): void {
    this.records.delete(key);
  }

  /** Drop every record whose key belongs to `session` (session teardown). */
  purgeSession(session: string): void {
    const prefix = `${session} `;
    for (const k of this.records.keys()) {
      if (k.startsWith(prefix)) this.records.delete(k);
    }
  }

  /** Drop every tracked record (session teardown / test isolation). */
  clearAll(): void {
    this.records.clear();
  }

  /** Test/inspection helper: number of tracked keys. */
  size(): number {
    return this.records.size;
  }
}

/** Compose a tracker key from session + relative path. */
export function stabilityKey(session: string, relPath: string): string {
  return `${session} ${relPath}`;
}
