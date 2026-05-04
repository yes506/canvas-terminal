/**
 * FSD protocol parser + classifier.
 *
 * Per plan v5 §3 grammar + §5.2 discriminator. Pure functions — no side
 * effects, no IPC, no state. The Rust orchestrator re-validates everything
 * authoritatively (defense in depth per plan v5 §2).
 */

import { FsdCommand, SCHEMA_VERSION } from "../types/fsd";

/**
 * Typed classification for malformed `##FSD` lines.
 *
 * - `shorthand-plan` — the leader emitted `##FSD plan` (a verb token, no JSON).
 *   Recoverable via `buildFallbackFsdPlanCommand` synthesis.
 * - `shorthand-other` — the leader emitted `##FSD dispatch|done|blocked` with
 *   no JSON payload. NOT recoverable: dispatch/done/blocked require live run
 *   context (task list / summary / reason) that the harness cannot fabricate.
 *   Strike with a clearer "must be a JSON object" message.
 * - `json-parse` — the line had a JSON payload but it failed to parse.
 * - `shape` — the JSON parsed but envelope/verb-specific shape validation failed.
 *
 * Replaces the prior engine-string-substring detection in
 * `AgentMiniTerminal.tsx::isShorthandPlanMalformed`, which depended on V8/JSC
 * error string formats that drift across runtimes/versions.
 */
export type MalformedCode = "shorthand-plan" | "shorthand-other" | "json-parse" | "shape";

export type ParseResult =
  | { kind: "ok"; cmd: FsdCommand }
  | { kind: "malformed"; code: MalformedCode; reason: string }
  | { kind: "skip" };

/**
 * Parse a single line. Returns:
 *  - `ok` if the line starts with `##FSD ` and contains a valid command JSON
 *  - `malformed` if it looks like a `##FSD` line but JSON parse / shape fails
 *  - `skip` if it isn't a `##FSD` line at all (just a normal CLI output line)
 *
 * The parser is intentionally lenient on leading whitespace (tolerates
 * markdown indentation), but the §5.4 escape `# #FSD` (single `#` + space +
 * `#FSD`) cannot match because the regex requires two adjacent `#`s.
 */
/**
 * Pre-parse shorthand check. Matches `##FSD <verb>` with no JSON payload —
 * a common leader emission failure where the leader writes the bare verb
 * token instead of a JSON object. Detected BEFORE `JSON.parse` so the
 * classification doesn't depend on engine-specific error strings.
 */
const SHORTHAND_RE = /^\s*##FSD\s+(plan|dispatch|done|blocked)\s*$/;

export function parseFsdLine(line: string): ParseResult {
  // Pre-parse shorthand classification. If the line is `##FSD plan` (or any
  // bare-verb form), short-circuit with a typed code so the caller can pick
  // an appropriate recovery: synthesize a fallback for `plan`, strike with a
  // clear message for the other three verbs (which need live run context).
  const shorthand = line.match(SHORTHAND_RE);
  if (shorthand) {
    const verb = shorthand[1];
    const code: MalformedCode = verb === "plan" ? "shorthand-plan" : "shorthand-other";
    return {
      kind: "malformed",
      code,
      reason: `shorthand: \`##FSD ${verb}\` requires a JSON object. Emit \`##FSD {\"type\":\"${verb}\", …}\` instead.`,
    };
  }

  // Match ##FSD followed by whitespace then ANYTHING. Tolerate leading
  // whitespace (markdown indent) but require the two-hash sigil. We capture
  // everything after `##FSD ` and try to parse as JSON — bad JSON / non-object
  // are reported as `malformed` so the strike protocol fires (a leader trying
  // to emit a command but botching the shape is a recoverable failure, not
  // a non-FSD line).
  const match = line.match(/^\s*##FSD\s+(.+?)\s*$/);
  if (!match) return { kind: "skip" };

  let json: unknown;
  try {
    json = JSON.parse(match[1]);
  } catch (e) {
    return {
      kind: "malformed",
      code: "json-parse",
      reason: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Shape check.
  if (!isObject(json)) return { kind: "malformed", code: "shape", reason: "not an object" };

  // Required envelope fields.
  for (const field of ["v", "cmd_id", "sn", "rn", "run_id", "type"] as const) {
    if (!(field in json)) {
      return { kind: "malformed", code: "shape", reason: `missing field: ${field}` };
    }
  }

  // Schema version.
  if (json.v !== SCHEMA_VERSION) {
    return { kind: "malformed", code: "shape", reason: `unsupported schema version v${json.v}` };
  }

  // Verb-specific validation.
  switch (json.type) {
    case "plan":
      if (typeof json.goal !== "string") {
        return { kind: "malformed", code: "shape", reason: "plan: goal must be string" };
      }
      break;
    case "dispatch":
      if (typeof json.turn !== "number" || !Array.isArray(json.tasks)) {
        return { kind: "malformed", code: "shape", reason: "dispatch: turn (number) + tasks (array) required" };
      }
      for (const [i, t] of json.tasks.entries()) {
        if (!isObject(t) || typeof t.task_id !== "string" || typeof t.tool !== "string"
            || typeof t.prompt !== "string") {
          return { kind: "malformed", code: "shape", reason: `dispatch.tasks[${i}]: bad shape` };
        }
      }
      break;
    case "done":
      if (typeof json.summary !== "string") {
        return { kind: "malformed", code: "shape", reason: "done: summary must be string" };
      }
      break;
    case "blocked":
      if (typeof json.reason !== "string") {
        return { kind: "malformed", code: "shape", reason: "blocked: reason must be string" };
      }
      break;
    default:
      return { kind: "malformed", code: "shape", reason: `unknown verb: ${(json as { type: unknown }).type}` };
  }

  return { kind: "ok", cmd: json as unknown as FsdCommand };
}

/**
 * Discriminator for nonce mismatch handling (plan v5 §5.2 + item δ).
 * Returns "drop" for echoed/placeholder text and "strike" for real
 * command-shaped lines outside the echo window.
 */
export type MismatchClassification = "drop" | "strike";

export function classifyMismatch(opts: {
  parsedJson: { sn?: string; rn?: string };
  activeSn: string;
  activeRn: string | null;
  insideEchoWindow: boolean;
}): MismatchClassification {
  const { parsedJson, insideEchoWindow } = opts;
  // Layer 1: literal placeholder text from header examples.
  if (parsedJson.sn === "<SESSION_NONCE>" || parsedJson.rn === "<RUN_NONCE>") {
    return "drop";
  }
  // Layer 2: inside echo-suppressor window from a recent inject.
  if (insideEchoWindow) return "drop";
  // Layer 3: real command-shaped line outside echo window with stale nonce.
  return "strike";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
