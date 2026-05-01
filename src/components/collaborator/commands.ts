import { invoke } from "@tauri-apps/api/core";
import {
  useCollaboratorStore,
  agentDisplayName,
  toolLabel,
  slugify,
  findWorktreeLeaseConflict,
} from "../../stores/collaboratorStore";
import { exportCanvasSnapshot, startImportForSession } from "../../lib/canvasOps";
import type { CollabTask, SpawnedAgent, TaskStatus } from "../../types/collaborator";

/**
 * LB4 helper (codex2 task-59 H1, hardened in round-8 per codex2 task-75
 * H2 + claude2 Concern feedback): a task is "worktree-backed" if ANY of:
 *
 *   1. `task.pendingMerge !== null` — gate already engaged. Manual
 *      `/task done` here would bypass an already-running approval flow.
 *
 *   2. The assignee's SpawnedAgent record (status `running` OR `exited`)
 *      has a non-null `worktree`. Round-8 keeps the SpawnedAgent record
 *      in the store after PTY exit when the worktree was preserved, so
 *      `agent.status === "exited"` no longer means "agent is gone for
 *      gate purposes" — it means "PTY exited but worktree work is
 *      still pending review/discard."
 *
 * Returns false when none of those apply: no assignee, no agent record,
 * agent has no worktree. In those cases the slash command's manual
 * transition is fine because there's no gate to bypass.
 */
export function isTaskWorktreeBacked(
  task: CollabTask,
  agents: SpawnedAgent[],
  collabSessionId: string,
): boolean {
  // (1) The gate has already engaged → don't allow slash-command bypass
  // even if the SpawnedAgent record was somehow lost.
  if (task.pendingMerge !== null) return true;
  // (2) Live OR exited-with-worktree agent record signals the gate
  // applies. After round-8, agent records persist when their worktree
  // has uncommitted/unmerged work.
  if (!task.assignee) return false;
  const handle = task.assignee.replace(/^@/, "");
  const agent = agents.find(
    (a) => a.collabSessionId === collabSessionId && a.handle === handle,
  );
  return Boolean(agent?.worktree);
}

/**
 * LB5 nice-UX helper for slash commands. Delegates to the store's
 * lease-based `findWorktreeLeaseConflict` — see that function's doc for
 * the full criteria (round-10 lease-based rule per codex1 task-81 H1).
 *
 * The structural gate inside `addTask`/`updateTask` is the load-bearing
 * enforcement; this helper exists so the slash-command surfaces can
 * surface the conflict reason BEFORE invoking the mutator (giving the
 * user a more actionable error message than "Assignee update dropped").
 */
export function findActiveWorktreeTaskForAgent(
  assigneeToken: string,
  agents: SpawnedAgent[],
  tasks: CollabTask[],
  collabSessionId: string,
): CollabTask | undefined {
  return findWorktreeLeaseConflict(assigneeToken, agents, tasks, collabSessionId);
}

/**
 * Shape of the LB6 structured GitError tagged-union, mirrored from
 * `src-tauri/src/commands/git.rs` (kind discriminator + variant fields).
 * Used by the D14 Approve flow to route on `kind` for actionable status
 * messages and the right task-status transition.
 */
export interface GitErrorShape {
  kind?:
    | "emptyCommit"
    | "hookFailed"
    | "mergeConflict"
    | "targetBranchStale"
    | "parentRepoDirty"
    | "pushFailedAfterMerge"
    | "authorIdentityMissing"
    | "genericFailure";
  message?: string;
  stage?: string;
  stderr?: string;
  branch?: string;
  files?: string[];
  target?: string;
  repoRoot?: string;
  mergedSha?: string;
  command?: string;
  exitCode?: number;
}

/**
 * Render a GitError variant into a single-line actionable status message.
 * Falls back to `String(err)` for non-tagged-union errors (network /
 * IPC failures that didn't come from the structured backend path).
 */
export function formatGitError(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as GitErrorShape;
  switch (e.kind) {
    case "emptyCommit":
      return `nothing to commit (${e.message ?? "working tree was already clean"})`;
    case "hookFailed": {
      // Round-12 claude3 O5: backend's from_command_failure classifier
      // always sets stage: "unknown" for hook failures (the stage isn't
      // recoverable from stderr alone). Fall back to "commit" — the
      // dominant case — instead of producing "pre-unknown hook failed".
      const stage =
        e.stage && e.stage !== "unknown" ? e.stage : "commit";
      return `pre-${stage} hook failed: ${(e.stderr ?? "").split("\n")[0]}`;
    }
    case "mergeConflict": {
      const fileList = (e.files ?? []).slice(0, 5).join(", ");
      const more =
        (e.files?.length ?? 0) > 5 ? ` (+${(e.files?.length ?? 0) - 5} more)` : "";
      return `merge conflict on branch ${e.branch ?? "?"}${fileList ? ` in ${fileList}${more}` : ""}. Resolve manually or Discard.`;
    }
    case "targetBranchStale":
      return `local '${e.target ?? "dev"}' can't fast-forward to origin. Run 'git pull' first. ${(e.message ?? "").split("\n")[0]}`;
    case "parentRepoDirty": {
      const fileList = (e.files ?? []).slice(0, 5).join(", ");
      const more =
        (e.files?.length ?? 0) > 5 ? ` (+${(e.files?.length ?? 0) - 5} more)` : "";
      return `parent repo has uncommitted changes${fileList ? `: ${fileList}${more}` : ""}. Commit or stash, then retry.`;
    }
    case "pushFailedAfterMerge":
      return `merge OK (${e.mergedSha ?? "?"}) but push failed: ${(e.stderr ?? "").split("\n")[0]}`;
    case "authorIdentityMissing":
      return `git committer identity unresolved. Set user.name / user.email and retry.`;
    case "genericFailure":
      return `${e.command ?? "git"} exited ${e.exitCode ?? "?"}: ${(e.stderr ?? "").split("\n")[0]}`;
    default:
      return String(err);
  }
}

/**
 * The branch that the orchestrator merges approved tasks into. Hardcoded
 * to `dev` for v1 because every task created from a worktree is based
 * on `origin/dev` (per the worktree-isolation policy v5 spec). This is
 * the branch LB3 must verify protection on — NOT `main`. round-13
 * codex1 H1 caught the wrong-branch bug: verifying `main` would silently
 * pass when `dev` (the actual landing branch) is unprotected.
 *
 * Future configurability: derive from `pendingMerge.targetBranch` once
 * non-`dev` bases are supported. For now, all merge sites and LB3 call
 * sites must use this constant.
 */
export const APPROVAL_TARGET_BRANCH = "dev";

/**
 * LB3 branch-protection three-state model (v5 §4 P2.h). Returned by
 * `checkBranchProtection`. Routing per state:
 *   - `verified-protected`: silent; Approve proceeds. Means a non-empty
 *     protection rule exists AND it has at least one direct-push-blocking
 *     field set (round-13 codex2 H1: bare 200 isn't enough).
 *   - `verified-unprotected`: refuse Approve until user enables real
 *     protection on GitHub OR runs `/branch-protection accept-limited`.
 *     Includes the case where a protection object exists but has no
 *     meaningful rules (empty or weak).
 *   - `unknown`: cannot verify (non-GitHub remote, missing gh, auth/
 *     network failure, rate-limited, malformed JSON). Refuse Approve
 *     until user runs `/branch-protection accept-limited`.
 */
export type BranchProtectionState =
  | "verified-protected"
  | "verified-unprotected"
  | "unknown";

/**
 * LB3 wizard's discriminator: extract the GitHub-flavored host from a
 * remote URL. Returns the host string when the URL is a recognizable
 * GitHub or GitHub Enterprise (GHE) remote, otherwise null.
 *
 * Round-19 P5 (claude3 task-99 O2 follow-up): GHE detection. The
 * prior `isGithubRemote` only matched `github.com` literally. Self-
 * hosted GHE installations (`github.acme.com`, etc.) routed to
 * `unknown` even though `gh` can talk to them when authed (`gh api`
 * uses the active host from `gh auth status`). Now any host that
 * starts with `github.` (the canonical GHE convention) OR equals
 * `github.com` is recognized. Other hosts still route to `unknown`.
 *
 * Round-25 P5 (claude2 task-115 carry-over): added `ssh://` URL
 * scheme support (with and without explicit port). Recognized URL
 * shapes:
 *   https://github.com/owner/repo(.git)?(/)?
 *   git@github.com:owner/repo(.git)?
 *   ssh://git@github.com/owner/repo(.git)?
 *   ssh://git@github.com:22/owner/repo(.git)?
 *   …same shapes for github.acme.com (GHE).
 */
function detectGithubHost(url: string): string | null {
  // Round-25 P5: ssh:// URL form first — has explicit scheme so we
  // don't conflict with the SCP-like form below.
  // ssh://[user@]<host>[:port][/path]
  const sshProtoMatch = url.match(/^ssh:\/\/(?:[^@/\s]+@)?([^:/\s]+)/);
  if (sshProtoMatch) {
    const host = sshProtoMatch[1].toLowerCase();
    if (host === "github.com" || host.startsWith("github.")) return host;
    return null;
  }
  // HTTPS/HTTP: https://<host>/owner/repo(.git)?
  const httpsMatch = url.match(/^https?:\/\/([^/\s]+)\//);
  if (httpsMatch) {
    const host = httpsMatch[1].toLowerCase();
    if (host === "github.com" || host.startsWith("github.")) return host;
    return null;
  }
  // SCP-like SSH (no protocol): user@<host>:owner/repo(.git)?
  const scpMatch = url.match(/^[^@\s]+@([^:\s]+):/);
  if (scpMatch) {
    const host = scpMatch[1].toLowerCase();
    if (host === "github.com" || host.startsWith("github.")) return host;
    return null;
  }
  return null;
}

/**
 * Parse `<owner>/<repo>` from a remote URL. Strips the trailing `.git`
 * suffix and optional trailing slash. Returns null on malformed input
 * — caller treats null as `unknown` state.
 *
 * Round-19 P5: parametric on the detected host (no longer hardcoded
 * to `github.com`) so GHE URLs parse correctly.
 *
 * Round-25 P5 (claude2 task-115 Concern 1 carry-over): handle SSH
 * URL scheme with optional port (`ssh://git@host:22/owner/repo`)
 * and trailing-slash URLs (`https://github.com/owner/repo/` from
 * copy-paste). The `(?::\d+)?` allows an optional port number after
 * the host; `/?` allows an optional trailing slash; the post-suffix
 * `$` anchor still ensures we don't match arbitrary paths after.
 */
function parseGithubOwnerRepo(url: string): { owner: string; repo: string } | null {
  const host = detectGithubHost(url);
  if (!host) return null;
  // Build a host-anchored regex so we don't accidentally match
  // `github.com` substring inside a path. Allow optional `:port`
  // after host (SSH URL form), then `[:/]` to step into the path
  // (`:` for SCP form, `/` for HTTPS/SSH-URL forms), then capture
  // owner and repo.
  const escapedHost = host.replace(/\./g, "\\.");
  const re = new RegExp(
    `${escapedHost}(?::\\d+)?[:/]([^/\\s]+)/([^/\\s]+?)(?:\\.git)?/?$`,
    "i",
  );
  const m = url.match(re);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Result discriminator for the protection-body classifier.
 *
 * Round-14 (codex2 M1 + claude2 O3 + claude3 O1): separates "parsed
 * cleanly, here's the verdict" from "couldn't parse the body at all"
 * so the caller can distinguish `verified-unprotected` (no meaningful
 * rule) from `unknown` (couldn't determine state).
 *
 * Round-19 P5 (claude3 task-99 O4): diagnostic specificity. The prior
 * `weak-or-empty` lumped two distinct sub-cases together:
 *   - `weak`: protection rule exists with status-checks-only or other
 *     non-blocking fields. User probably intended the branch to be
 *     gated; just needs to add PR-required or push-restrictions to
 *     get full protection.
 *   - `empty`: protection rule exists but every meaningful field is
 *     null. User configured something that does nothing.
 * Both still route to `verified-unprotected`, but the diagnostic
 * message can name the distinction so the user knows what they need
 * to add.
 */
type ProtectionClassification =
  | "meaningful"
  | "weak"
  | "empty"
  | "unparseable";

/**
 * Round-19 P5: extracted result from classifyProtectionBody so the
 * caller can render a more specific status message. The
 * BranchProtectionState routing is unchanged (weak/empty still both
 * map to verified-unprotected); the extra detail is consumed by the
 * `/branch-protection check` slash command for actionable messages.
 */
export interface ProtectionDetail {
  classification: ProtectionClassification;
  /**
   * For `weak`: the names of the non-blocking fields present (e.g.,
   * `["required_status_checks"]`). Empty for other classifications.
   */
  nonBlockingFields: string[];
}

/**
 * Classify a GitHub branch-protection response body into the three
 * categories that drive `checkBranchProtection`'s routing.
 *
 * Round-14 (codex2 H1, load-bearing): `required_status_checks` alone
 * is NOT sufficient for the no-direct-push guarantee. Per GitHub docs,
 * after required checks pass, commits CAN be pushed directly to the
 * protected branch by anyone with write access. A merchant-of-record
 * "no agent direct-pushes the landing branch" guarantee requires a
 * rule that blocks the push itself, not one that gates it on checks
 * passing. The two GitHub fields that actually block direct pushes are:
 *
 *   - `required_pull_request_reviews` — non-null means the branch
 *     accepts changes ONLY via approved PRs. Direct push refused.
 *   - `restrictions` — when populated with at least one user / team /
 *     app entry, only those actors may push directly. Treat an empty
 *     restrictions object (`{users: [], teams: [], apps: []}`) as
 *     non-restrictive.
 *
 * `required_status_checks` alone routes to `weak-or-empty`. Users who
 * actually need direct-push protection should configure either reviews
 * or non-empty restrictions; users who consciously want only status
 * checks gate their merges via `accept-limited`.
 */
function classifyProtectionBody(stdoutBody: string): ProtectionDetail {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdoutBody);
  } catch {
    // Round-14: parse failure is "can't verify", not "no protection".
    return { classification: "unparseable", nonBlockingFields: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { classification: "unparseable", nonBlockingFields: [] };
  }
  const obj = parsed as Record<string, unknown>;
  // Direct-push-blocking field #1: PR-required.
  if (obj.required_pull_request_reviews != null) {
    return { classification: "meaningful", nonBlockingFields: [] };
  }
  // Direct-push-blocking field #2: restrictions populated with at
  // least one allowed pusher.
  if (
    obj.restrictions != null &&
    typeof obj.restrictions === "object" &&
    restrictionsHasAllowlistedEntries(obj.restrictions as Record<string, unknown>)
  ) {
    return { classification: "meaningful", nonBlockingFields: [] };
  }
  // Direct-push-blocking field #3: lock_branch.enabled (round-15).
  if (
    obj.lock_branch != null &&
    typeof obj.lock_branch === "object" &&
    (obj.lock_branch as Record<string, unknown>).enabled === true
  ) {
    return { classification: "meaningful", nonBlockingFields: [] };
  }
  // Round-19 P5 (claude3 task-99 O4): diagnostic specificity for
  // weak-vs-empty. Collect any non-null non-blocking fields so the
  // status message can name them ("status checks gate but don't
  // block direct push; add PR-required or push-restrictions").
  const nonBlockingFields: string[] = [];
  if (obj.required_status_checks != null) nonBlockingFields.push("required_status_checks");
  if (
    obj.required_signatures != null &&
    typeof obj.required_signatures === "object" &&
    (obj.required_signatures as Record<string, unknown>).enabled === true
  ) {
    nonBlockingFields.push("required_signatures");
  }
  if (
    obj.required_linear_history != null &&
    typeof obj.required_linear_history === "object" &&
    (obj.required_linear_history as Record<string, unknown>).enabled === true
  ) {
    nonBlockingFields.push("required_linear_history");
  }
  if (
    obj.required_conversation_resolution != null &&
    typeof obj.required_conversation_resolution === "object" &&
    (obj.required_conversation_resolution as Record<string, unknown>).enabled === true
  ) {
    nonBlockingFields.push("required_conversation_resolution");
  }
  if (nonBlockingFields.length > 0) {
    return { classification: "weak", nonBlockingFields };
  }
  return { classification: "empty", nonBlockingFields: [] };
}

/**
 * Returns true when `restrictions` allowlist has at least one valid
 * user/team/app entry. Round-17 (claude3 task-102 O1): validate the
 * entries themselves are non-null objects, not just that the arrays
 * are non-empty. Prevents `[null]` or `["malformed"]` from being
 * treated as a valid allowlist when GitHub's response shape drifts
 * or a future user supplies adversarial input.
 */
function restrictionsHasAllowlistedEntries(r: Record<string, unknown>): boolean {
  const countValid = (k: string) => {
    const v = r[k];
    if (!Array.isArray(v)) return 0;
    // An entry is valid if it's a non-null object. GitHub serves these
    // as objects with `{login, id, ...}` or `{slug, id, ...}` shapes;
    // we don't pin specific fields because they vary across endpoint
    // versions, but the entry MUST be an object (not a string, null,
    // or scalar) to count.
    return v.filter((entry) => entry != null && typeof entry === "object").length;
  };
  return countValid("users") + countValid("teams") + countValid("apps") > 0;
}

/**
 * Run the LB3 three-state branch-protection check for a repo.
 *
 * The implementation is order-sensitive:
 *   1. Resolve `origin` URL — non-existent remote → `unknown`.
 *   2. GitHub host check — non-GitHub → `unknown` (no API to call).
 *   3. Parse owner/repo — malformed URL → `unknown`.
 *   4. Run `gh api /repos/<owner>/<repo>/branches/<targetBranch>/protection`:
 *      - exit 0 + protection JSON has meaningful fields → `verified-protected`.
 *      - exit 0 + empty/weak protection (round-13 codex2 H1) →
 *        `verified-unprotected` (the rule exists but doesn't block direct
 *        pushes; treat the same as no protection at all).
 *      - exit non-zero with stderr matching 404/Not Found →
 *        `verified-unprotected`.
 *      - any other failure (auth, network, gh missing, malformed JSON,
 *        rate limit) → `unknown`.
 *
 * The target branch defaults to `APPROVAL_TARGET_BRANCH` (currently
 * `dev`) per round-13 codex1 H1: the check must verify the actual
 * landing branch, not `main`.
 *
 * The Tauri command `run_gh_api` does NOT fail Rust-side on non-zero
 * exits — it returns `{exitCode, stdout, stderr}` so this routing
 * logic owns the state determination.
 */
/**
 * Round-20 (codex2 task-116 M1 + claude3 task-117 O1): rich variant
 * of `checkBranchProtection` that returns the full classification
 * detail so callers can render diagnostic-specific messages
 * ("rule includes status_checks but not PR-required" vs generic
 * "no protection"). Same routing as `checkBranchProtection`; just
 * exposes the inner `ProtectionDetail` for the verified-unprotected
 * case.
 */
export interface BranchProtectionVerdict {
  state: BranchProtectionState;
  /**
   * Populated when state is `verified-unprotected` AND the API
   * returned a parseable body. Carries `nonBlockingFields` for
   * `weak` classification so the slash-command surface can name
   * which fields are present-but-non-blocking.
   */
  detail?: ProtectionDetail;
  /**
   * The detected GitHub host used for the API call (e.g.,
   * `"github.acme.com"` for GHE). Useful for diagnostic messages
   * ("checking origin/dev on github.acme.com…").
   */
  host?: string;
}

/**
 * Round-21 P5 (claude3 task-99 O5): in-memory TTL cache for
 * `verified-protected` verdicts. Each Approve previously incurred a
 * ~1s `gh api` round-trip even when the protection state hadn't
 * changed since the last check. Cache only the protected verdict
 * (the only state that lets Approve proceed silently); the other
 * states already gate on user action so caching them adds no value.
 *
 * Keyed by `${repoRoot}|${targetBranch}` so a repo with multiple
 * tracked branches doesn't false-positive across them. TTL is 5
 * minutes — long enough to amortize the gh latency for typical
 * "approve a few tasks in a row" sessions, short enough that a user
 * who toggles protection on GitHub sees the change after a brief
 * wait. `/branch-protection check` always bypasses the cache (the
 * user explicitly asked to re-evaluate); `clear-ack` invalidates
 * the cache for that repoRoot. Backed off the per-process map; not
 * persisted to disk.
 */
const VERIFIED_PROTECTED_TTL_MS = 5 * 60 * 1000;
const verifiedProtectedCache = new Map<string, { expiresAt: number; verdict: BranchProtectionVerdict }>();

function verifiedCacheKey(repoRoot: string, targetBranch: string): string {
  return `${repoRoot}|${targetBranch}`;
}

/** Test-only: clear the verified-protected cache. Exported so the
 * test suite's _resetWriteStateForTests can flush it for isolation. */
export function _clearVerifiedProtectedCacheForTests(): void {
  verifiedProtectedCache.clear();
}

/**
 * Invalidate any cached verified-protected verdict for a specific
 * repoRoot. Called by the LB3 ack lifecycle (`clear-ack` should
 * force the next Approve to re-check) and by `/branch-protection
 * check` (explicit user re-evaluation request).
 */
export function invalidateVerifiedProtectedCache(repoRoot: string): void {
  // Drop every entry whose key starts with the repoRoot prefix —
  // covers all targetBranch variants for this repo.
  const prefix = `${repoRoot}|`;
  for (const key of verifiedProtectedCache.keys()) {
    if (key.startsWith(prefix)) verifiedProtectedCache.delete(key);
  }
}

/**
 * Round-24 (claude2 task-127 Concern 1): structural invariant
 * helper. Every fresh-fetch path goes through `finalizeVerdict`
 * which writes the cache on `verified-protected` and DELETES on
 * everything else. Centralizing the cache-mutation site in ONE
 * place means future code drift (a new return path added by a
 * future commit) cannot violate the invariant — there is nothing
 * left to remember. Replaces the round-22+23 explicit-call form
 * where every return manually had to call `verifiedProtectedCache.
 * delete(cacheKey)`. Five rounds caught the same write-or-delete
 * asymmetry on different paths because the prior form was fragile;
 * this refactor makes drift impossible.
 */
function finalizeVerdict(
  verdict: BranchProtectionVerdict,
  cacheKey: string,
): BranchProtectionVerdict {
  if (verdict.state === "verified-protected") {
    verifiedProtectedCache.set(cacheKey, {
      expiresAt: Date.now() + VERIFIED_PROTECTED_TTL_MS,
      verdict,
    });
  } else {
    // Every non-protected verdict (verified-unprotected, unknown,
    // including the four early-return paths and the post-API
    // non-protected/non-zero-exit paths) invalidates any stale
    // protected entry. Round-22 + round-23 BLOCKING fixes are now
    // expressed structurally — no manual calls needed.
    verifiedProtectedCache.delete(cacheKey);
  }
  return verdict;
}

export async function checkBranchProtectionDetail(
  repoRoot: string,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke,
  targetBranch: string = APPROVAL_TARGET_BRANCH,
  options: { useCache?: boolean } = { useCache: true },
): Promise<BranchProtectionVerdict> {
  const cacheKey = verifiedCacheKey(repoRoot, targetBranch);
  // Round-21 (claude3 task-99 O5): cache hit short-circuits the
  // entire fresh-fetch path. Cached verdicts are always
  // `verified-protected` (we only cache that state — round-22).
  // The cache hit does NOT go through `finalizeVerdict` because no
  // new observation has happened to reconcile against.
  const useCache = options.useCache ?? true;
  if (useCache) {
    const cached = verifiedProtectedCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.verdict;
    }
  }
  // Round-24 (claude2 task-127 Concern 1): the entire fresh-fetch
  // body lives in an inner async IIFE that returns a verdict. The
  // outer function passes that verdict through `finalizeVerdict`
  // which centralizes the cache write/delete. Future code can add
  // new early-return paths inside the IIFE without touching cache
  // logic — the structural invariant guarantees reconciliation.
  const verdict = await (async (): Promise<BranchProtectionVerdict> => {
    let remoteUrl: string;
    try {
      remoteUrl = await invokeFn<string>("git_get_remote_url", {
        repoRoot,
        remoteName: "origin",
      });
    } catch {
      return { state: "unknown" };
    }
    const host = detectGithubHost(remoteUrl);
    if (!host) return { state: "unknown" };
    const parsed = parseGithubOwnerRepo(remoteUrl);
    if (!parsed) return { state: "unknown", host };
    // Round-20 (codex1 round-7 + codex2 task-116 H1 BLOCKING fix):
    // pass `--hostname <host>` to `gh api` for non-default GitHub
    // hosts so the request targets the GHE installation, not the
    // user's default-authed `github.com`. Per `gh api --help`:
    // "--hostname string ... override default host (default:
    // github.com)".
    const args: string[] = [
      `/repos/${parsed.owner}/${parsed.repo}/branches/${targetBranch}/protection`,
    ];
    if (host !== "github.com") args.push("--hostname", host);
    let res: { exitCode: number; stdout: string; stderr: string };
    try {
      res = await invokeFn<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>("run_gh_api", { args });
    } catch {
      return { state: "unknown", host };
    }
    if (res.exitCode === 0) {
      const detail = classifyProtectionBody(res.stdout);
      if (detail.classification === "meaningful") {
        return { state: "verified-protected", detail, host };
      }
      if (detail.classification === "unparseable") {
        return { state: "unknown", detail, host };
      }
      return { state: "verified-unprotected", detail, host };
    }
    const stderrLc = res.stderr.toLowerCase();
    if (stderrLc.includes("not found") || stderrLc.includes("404")) {
      return { state: "verified-unprotected", host };
    }
    return { state: "unknown", host };
  })();
  // Single finalize site — write or delete based on verdict state.
  return finalizeVerdict(verdict, cacheKey);
}

/**
 * Round-21 refactor (codex1 round-8 + codex2 task-119 + claude2
 * task-118 Concern 1 convergent): the prior `checkBranchProtection`
 * duplicated the entire IPC sequence + classification logic from
 * `checkBranchProtectionDetail`. A future fix to one would have
 * required a parallel fix to the other; drift risk. Now wraps the
 * detail variant and projects out the `state` field. Single source
 * of truth.
 */
export async function checkBranchProtection(
  repoRoot: string,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke,
  targetBranch: string = APPROVAL_TARGET_BRANCH,
): Promise<BranchProtectionState> {
  const verdict = await checkBranchProtectionDetail(
    repoRoot,
    invokeFn,
    targetBranch,
  );
  return verdict.state;
}

export interface ParsedCommand {
  type:
    | "send"
    | "broadcast"
    | "needs-target"
    | "status"
    | "clear"
    | "help"
    | "canvas-export"
    | "canvas-import"
    | "context"
    | "memory"
    | "task"
    | "rename"
    | "branch-protection"
    | "unknown";
  target?: string;
  message?: string;
  raw: string;
}

export function parseInput(input: string): ParsedCommand {
  const trimmed = input.trim();

  if (trimmed === "/status") return { type: "status", raw: trimmed };
  if (trimmed === "/clear") return { type: "clear", raw: trimmed };
  if (trimmed === "/help") return { type: "help", raw: trimmed };

  // Canvas export: require explicit @target to distinguish agent handle from prompt message.
  // Branch 1: /canvas-export @target [message] → groups 1,2
  // Branch 2: /canvas-export message (no @)   → group 3
  const canvasExportMatch = trimmed.match(/^\/canvas-export(?:\s+@(\S+)(?:\s+([\s\S]+))?|\s+([\s\S]+))?$/);
  if (canvasExportMatch) {
    return {
      type: "canvas-export",
      target: canvasExportMatch[1],
      message: (canvasExportMatch[2] ?? canvasExportMatch[3])?.trim(),
      raw: trimmed,
    };
  }
  // Canvas import: require explicit @target (same fix as export)
  const canvasImportMatch = trimmed.match(/^\/canvas-import(?:\s+@(\S+))?(?:\s+([\s\S]+))?$/);
  if (canvasImportMatch) {
    return { type: "canvas-import", target: canvasImportMatch[1], message: canvasImportMatch[2]?.trim(), raw: trimmed };
  }

  if (trimmed === "/context" || trimmed.startsWith("/context ")) {
    const text = trimmed.slice("/context".length).trim();
    return { type: "context", message: text || undefined, raw: trimmed };
  }

  if (trimmed === "/memory" || trimmed.startsWith("/memory ")) {
    const rest = trimmed.slice("/memory".length).trim();
    return { type: "memory", message: rest || undefined, raw: trimmed };
  }

  if (trimmed === "/task" || trimmed.startsWith("/task ")) {
    const rest = trimmed.slice("/task".length).trim();
    return { type: "task", message: rest || undefined, raw: trimmed };
  }

  // /branch-protection <subcommand> — LB3 wizard surface
  if (
    trimmed === "/branch-protection" ||
    trimmed.startsWith("/branch-protection ")
  ) {
    const rest = trimmed.slice("/branch-protection".length).trim();
    return {
      type: "branch-protection",
      message: rest || undefined,
      raw: trimmed,
    };
  }

  // /rename @<agent> <new-nickname>
  // Captures the new nickname as the rest of the line (allows spaces).
  const renameMatch = trimmed.match(/^\/rename\s+@(\S+)\s+(.+)$/);
  if (renameMatch) {
    return {
      type: "rename",
      target: renameMatch[1],
      message: renameMatch[2].trim(),
      raw: trimmed,
    };
  }
  if (trimmed === "/rename" || trimmed.startsWith("/rename ")) {
    // Malformed — pass through with no target/message so the executor can
    // surface a usage hint.
    return { type: "rename", raw: trimmed };
  }

  // @agent message
  const atMatch = trimmed.match(/^@(\S+)\s+(.+)$/s);
  if (atMatch) {
    const target = atMatch[1];
    const message = atMatch[2];
    if (target === "all") {
      return { type: "broadcast", message, raw: trimmed };
    }
    return { type: "send", target, message, raw: trimmed };
  }

  // Bare text → needs target selection (no auto-broadcast)
  if (trimmed.length > 0) {
    return { type: "needs-target", message: trimmed, raw: trimmed };
  }

  return { type: "unknown", raw: trimmed };
}

export function resolveAgent(
  target: string,
  agents: SpawnedAgent[],
): SpawnedAgent | null {
  const lower = target.toLowerCase();
  const slug = slugify(target);

  // Exact handle match (primary resolution path; allows exited agents — handles
  // are immutable + unique forever within a collabSessionId).
  const exactHandleMatch = agents.find((a) => a.handle === lower);
  if (exactHandleMatch) return exactHandleMatch;

  // Exact nickname-slug match — LIVE AGENTS ONLY. Per v5 §4 "live agents own
  // the namespace": after a rename releases an exited agent's slug, the resolver
  // must prefer the live agent. Otherwise `@bug-hunter` could route to dead A.
  if (slug.length > 0) {
    const exactSlugMatch = agents.find(
      (a) => a.status !== "exited" && a.nicknameSlug === slug,
    );
    if (exactSlugMatch) return exactSlugMatch;
  }

  // Handle prefix match: "@claude" → first agent whose handle starts with
  // "claude". Allows exited agents — prefix routing is best-effort and
  // first-match by iteration order; a user typing a partial handle is
  // intentionally targeting that named agent regardless of liveness.
  const prefixHandleMatch = agents.find((a) => a.handle.startsWith(lower));
  if (prefixHandleMatch) return prefixHandleMatch;

  // Nickname-slug prefix — LIVE AGENTS ONLY. Same rationale as exact-slug.
  if (slug.length > 0) {
    const prefixSlugMatch = agents.find(
      (a) => a.status !== "exited" && a.nicknameSlug.startsWith(slug),
    );
    if (prefixSlugMatch) return prefixSlugMatch;
  }

  // History-slug match — LIVE AGENTS ONLY. Lets users address an agent by any
  // PAST nickname; a renamed agent stays reachable even if the user remembers
  // the old label (e.g., scrolling back through the conversation log and
  // typing the name they see there). v6 §2 step 5. (claude2 G6 round-8.)
  if (slug.length > 0) {
    const historyMatch = agents.find(
      (a) =>
        a.status !== "exited" &&
        a.nameHistory.some((r) => slugify(r.nickname) === slug),
    );
    if (historyMatch) return historyMatch;
  }

  // Fallback: sessionId match
  return agents.find((a) => a.sessionId === target) ?? null;
}

export function getHelpText(): string {
  return [
    "Type directly in each agent terminal. This prompt is for commands & targeted messages.",
    "",
    "Commands:",
    "  @<agent> <msg>    Send message to specific agent",
    "  @all <msg>        Broadcast to all agents",
    "  <bare text>       Shows target selector before sending",
    "  /status           Show running agents",
    "  /help             Show help",
    "",
    "Tasks: /task list  /task add <title> | <objective> [@agent]",
    "       /task <id> status <pending|in-progress|completed|blocked>",
    "       /task <id> assign @<agent>  /task <id> done [notes]",
    "       /task <id> approve [--push] [-- <message>]   (worktree-backed only)",
    "       /task <id> discard [<reason>]                (worktree-backed only)",
    "Protection: /branch-protection [status|check|accept-limited [-- <note>]|clear-ack [<repo>]|list-acks]",
    "Canvas: /canvas-export [msg]  /canvas-export @agent [msg]  /canvas-import @agent",
    "Memory: /context <text>  /memory list|read|delete|clear",
    "Agents: @claude @codex @gemini @copilot  Indexed: @claude1 @claude2  Or by nickname: @bug-hunter",
    "Rename: /rename @<agent> <new nickname>",
  ].join("\n");
}

export function getStatusText(agents: SpawnedAgent[]): string {
  if (agents.length === 0) {
    return "No agents running. Use the toolbar to launch AI tools.";
  }
  const lines = [`${agents.length} agent${agents.length !== 1 ? "s" : ""}:`];
  for (const a of agents) {
    const name = agentDisplayName(a);
    const statusTag = a.status === "exited" ? " [exited]" : "";
    lines.push(`  ${name}${statusTag}`);
  }
  return lines.join("  ");
}

// ---------------------------------------------------------------------------
// Command Execution
// ---------------------------------------------------------------------------

export async function executeCommand(cmd: ParsedCommand, collabSessionId?: string): Promise<void> {
  const store = useCollaboratorStore.getState();
  const status = (msg: string | null) => store.setStatus(msg, collabSessionId);
  // Scope agents to the current collaborator session when available
  const scopedAgents = collabSessionId
    ? store.agents.filter((a) => a.collabSessionId === collabSessionId)
    : store.agents;

  switch (cmd.type) {
    case "status": {
      status(getStatusText(scopedAgents));
      break;
    }

    case "clear": {
      status(null);
      break;
    }

    case "help": {
      status(getHelpText());
      break;
    }

    case "send": {
      if (!cmd.target || !cmd.message) break;
      const agent = resolveAgent(cmd.target, scopedAgents);
      if (!agent) {
        status(`Agent "${cmd.target}" not found.`);
        break;
      }
      const lower = cmd.target.toLowerCase();
      if (!/\d$/.test(cmd.target)) {
        const matches = scopedAgents.filter((a) =>
          a.handle.startsWith(lower),
        );
        if (matches.length > 1) {
          status(
            `Multiple ${cmd.target} sessions. Use @${matches[0].handle}, @${matches[1].handle}. Sent to first.`,
          );
        }
      }
      await store.sendToAgent(agent.sessionId, cmd.message);
      break;
    }

    case "broadcast": {
      if (!cmd.message) break;
      await store.broadcastToAll(cmd.message, collabSessionId);
      break;
    }

    case "canvas-export": {
      try {
        const target = cmd.target ?? "all";
        const path = await exportCanvasSnapshot();
        if (!path) {
          status("Canvas is empty.");
          break;
        }

        const lines = [
          "[Canvas Terminal] A canvas snapshot has been exported for your reference.",
          `Image path: ${path}`,
        ];
        if (cmd.message) {
          lines.push(cmd.message);
        } else {
          lines.push("Please analyze this image and respond.");
        }
        const prompt = lines.join("\n");

        if (target.toLowerCase() === "all") {
          if (scopedAgents.length === 0) {
            status(`Canvas exported at ${path}. No agents running to broadcast.`);
            break;
          }
          await store.broadcastToAll(prompt, collabSessionId);
          status(`Canvas broadcast to ${scopedAgents.length} agent${scopedAgents.length !== 1 ? "s" : ""}`);
          break;
        }

        const agent = resolveAgent(target, scopedAgents);
        if (!agent) {
          status(`Agent "${target}" not found. Saved at ${path}`);
          break;
        }

        await store.sendToAgent(agent.sessionId, prompt);
        status(`Canvas exported to ${toolLabel(agent.tool)}`);
      } catch (err) {
        status(`Export failed: ${err}`);
      }
      break;
    }

    case "canvas-import": {
      try {
        if (!cmd.target) {
          status("Usage: /canvas-import @<agent>  (specify a target agent)");
          break;
        }
        const agent = resolveAgent(cmd.target, scopedAgents);
        if (!agent) {
          status(`Agent "${cmd.target}" not found.`);
          break;
        }

        await startImportForSession(
          agent.sessionId,
          agent.tool,
          (msg) => status(msg),
          () => {},
          {
            sendFn: async (prompt) => {
              await store.sendToAgent(agent.sessionId, prompt);
            },
          },
        );
      } catch (err) {
        status(`Import failed: ${err}`);
      }
      break;
    }

    case "context": {
      try {
        if (cmd.message === "clear") {
          await invoke<boolean>("delete_memory_file", {
            relativePath: "context.md",
          });
          status("Shared context cleared.");
        } else if (cmd.message) {
          await invoke<string>("write_memory_file", {
            relativePath: "context.md",
            content: cmd.message,
          });
          status("Shared context updated.");
        } else {
          const content = await invoke<string | null>("read_memory_file", {
            relativePath: "context.md",
          });
          status(content ? `Context: ${content}` : "No shared context set.");
        }
      } catch (err) {
        status(`Context error: ${err}`);
      }
      break;
    }

    case "task": {
      try {
        const sub = cmd.message ?? "";

        // /task  or  /task list
        if (sub === "" || sub === "list") {
          if (!collabSessionId) {
            status("Task commands require a collaborator session.");
            break;
          }
          const tasks = store.getTasks(collabSessionId);
          if (tasks.length === 0) {
            status("No tasks. Create one: /task add <title> | <objective> [@agent]");
          } else {
            const lines = [`${tasks.length} task(s):`];
            for (const t of tasks) {
              const a = t.assignee ?? "unassigned";
              lines.push(`  [${t.status}] ${t.id}: ${t.title} (${a})`);
            }
            status(lines.join("  "));
          }
          break;
        }

        // /task add <title> | <objective> [@agent]
        if (sub.startsWith("add ") || sub === "add") {
          if (!collabSessionId) {
            status("Task commands require a collaborator session.");
            break;
          }
          const body = sub.slice("add".length).trim();
          if (!body) {
            status("Usage: /task add <title> | <objective> [@agent]");
            break;
          }
          const pipeIdx = body.indexOf("|");
          let title: string;
          let objective: string;
          let assignee: string | null = null;

          // Canonicalize the trailing @-token through resolveAgent BEFORE
          // writing the assignee. Symmetric with the /task <id> assign path
          // (see comment there). Without this, `/task add ... @bug-hunter`
          // would persist the mutable nickname token into t.assignee, and
          // every handle-keyed downstream lookup (findFreshestActiveTaskForMention,
          // recentOutcomesBySession) would fail to match. (codex3 round-8.)
          const canonicalizeAssignee = (rawToken: string): string | null => {
            const resolved = resolveAgent(rawToken, scopedAgents);
            return resolved ? `@${resolved.handle}` : null;
          };
          let unresolvedToken: string | null = null;
          if (pipeIdx >= 0) {
            title = body.slice(0, pipeIdx).trim();
            let rest = body.slice(pipeIdx + 1).trim();
            const atMatch = rest.match(/\s+@(\S+)$/);
            if (atMatch) {
              const canonical = canonicalizeAssignee(atMatch[1]);
              if (canonical) {
                assignee = canonical;
              } else {
                unresolvedToken = atMatch[1];
              }
              rest = rest.slice(0, -atMatch[0].length).trim();
            }
            objective = rest;
          } else {
            let rest = body;
            const atMatch = rest.match(/\s+@(\S+)$/);
            if (atMatch) {
              const canonical = canonicalizeAssignee(atMatch[1]);
              if (canonical) {
                assignee = canonical;
              } else {
                unresolvedToken = atMatch[1];
              }
              rest = rest.slice(0, -atMatch[0].length).trim();
            }
            title = rest;
            objective = rest;
          }

          if (unresolvedToken) {
            status(`Agent "${unresolvedToken}" not found.`);
            break;
          }

          // LB5 (claude3 task-46 ISS-2): if assigning to a worktree-backed
          // agent that already has a non-terminal task, refuse — running
          // two concurrent git-write tasks in the same worktree would
          // co-mingle their diffs and defeat the per-task approval gate.
          if (assignee) {
            const conflict = findActiveWorktreeTaskForAgent(
              assignee,
              store.agents,
              store.getTasks(collabSessionId),
              collabSessionId,
            );
            if (conflict) {
              status(
                `Cannot assign new task to ${assignee} — already has active worktree-backed task ` +
                  `${conflict.id} (status: ${conflict.status}). Approve, discard, or finish that task first, ` +
                  `or create this task without an assignee.`,
              );
              break;
            }
          }

          const task = store.addTask({ title, objective, assignee }, collabSessionId);
          status(`Task created: ${task.id} — "${task.title}"${assignee ? ` → ${assignee}` : ""}`);
          break;
        }

        // /task <id> status <status>
        const statusMatch = sub.match(/^(\S+)\s+status\s+(\S+)$/);
        if (statusMatch) {
          if (!collabSessionId) {
            status("Task commands require a collaborator session.");
            break;
          }
          const [, taskId, newStatus] = statusMatch;
          const valid = ["pending", "in-progress", "completed", "blocked"];
          if (!valid.includes(newStatus)) {
            status(`Invalid status. Use: ${valid.join(", ")}`);
            break;
          }
          const task = store.getTasks(collabSessionId).find((t) => t.id === taskId || t.id.startsWith(taskId));
          if (!task) {
            status(`Task not found: ${taskId}`);
            break;
          }
          // LB4 (codex2 task-59 H1): refuse manual `completed` on
          // worktree-backed tasks. The slash-command path bypasses the
          // P2 awaiting-approval gate that scanForTaskCompletions enforces
          // for agent-authored .done.json. Manual `blocked` is fine —
          // user is explicitly choosing to abandon the task.
          if (
            newStatus === "completed" &&
            isTaskWorktreeBacked(task, store.agents, collabSessionId)
          ) {
            status(
              `Task ${task.id} is assigned to a worktree-backed agent — manual /task status completed bypasses the approval gate. ` +
                `Use the agent's .done.json (auto-routes through the gate) or /task ${task.id} status blocked to abandon.`,
            );
            break;
          }
          store.updateTask(task.id, { status: newStatus as TaskStatus }, collabSessionId);
          status(`Task ${task.id} → ${newStatus}`);
          break;
        }

        // /task <id> assign @<agent>
        const assignMatch = sub.match(/^(\S+)\s+assign\s+@(\S+)$/);
        if (assignMatch) {
          if (!collabSessionId) {
            status("Task commands require a collaborator session.");
            break;
          }
          const [, taskId, agent] = assignMatch;
          const task = store.getTasks(collabSessionId).find((t) => t.id === taskId || t.id.startsWith(taskId));
          if (!task) {
            status(`Task not found: ${taskId}`);
            break;
          }
          // Canonicalize the typed token through resolveAgent BEFORE writing to
          // the task ledger. Otherwise a user typing /task X assign @bug-hunter
          // (a nickname) would land assignee: "@bug-hunter" — which never
          // matches handle-keyed lookups in findFreshestActiveTaskForMention or
          // recentOutcomesBySession after a future rename. The on-disk audit
          // also stays canonical: the markdown writer at formatTasksMarkdown
          // (`Assignee` line) sees @<handle>, not the typed nickname.
          const resolved = resolveAgent(agent, scopedAgents);
          if (!resolved) {
            status(`Agent "${agent}" not found.`);
            break;
          }
          // LB5 (claude3 task-46 ISS-2): refuse re-assignment to a
          // worktree-backed agent that already has a different non-
          // terminal task. Same reasoning as /task add — co-mingled
          // diffs in one worktree defeat the per-task approval gate.
          // The conflict lookup excludes THIS task so re-assigning to
          // the same agent (no-op) doesn't trip the check.
          const newAssignee = `@${resolved.handle}`;
          // Don't fire the check when the assignee isn't actually changing.
          if (task.assignee !== newAssignee) {
            const otherTasks = store
              .getTasks(collabSessionId)
              .filter((t) => t.id !== task.id);
            const conflict = findActiveWorktreeTaskForAgent(
              newAssignee,
              store.agents,
              otherTasks,
              collabSessionId,
            );
            if (conflict) {
              status(
                `Cannot reassign ${task.id} to ${newAssignee} — already has active worktree-backed task ` +
                  `${conflict.id} (status: ${conflict.status}). Approve, discard, or finish that task first.`,
              );
              break;
            }
          }
          store.updateTask(task.id, { assignee: newAssignee }, collabSessionId);
          status(`Task ${task.id} assigned to ${newAssignee}`);
          break;
        }

        // /task <id> approve [--push] [-- <commit message>]
        // D14 (codex2 task-67 H3, claude2 task-50): the user-facing surface
        // that consumes pendingMerge. Runs the orchestrator-owned merge
        // sequence:
        //   1. (conditional) git_create_approval_commit when the diff
        //      summary shows uncommitted residue (staged|unstaged|untracked).
        //   2. git_merge_worktree(repoRoot, branch, "dev", push) — always.
        //   3. On success: git_worktree_remove + transition task to
        //      `completed` + release the agent's worktree lease.
        //   4. On structured GitError: surface actionable text; transition
        //      task to `merge-conflict` for the merge-failure subset, or
        //      restore `awaiting-approval` for retryable preconditions
        //      (TargetBranchStale, ParentRepoDirty, AuthorIdentityMissing).
        // Worktree is NEVER auto-removed on failure (LB6 invariant).
        const approveMatch = sub.match(
          /^(\S+)\s+approve(?:\s+--push)?(?:\s+--\s+(.+))?$/s,
        );
        if (approveMatch) {
          if (!collabSessionId) {
            status("Task commands require a collaborator session.");
            break;
          }
          const wantsPush = /\s--push(\s|$)/.test(sub);
          const [, taskId, customMessage] = approveMatch;
          const task = store
            .getTasks(collabSessionId)
            .find((t) => t.id === taskId || t.id.startsWith(taskId));
          if (!task) {
            status(`Task not found: ${taskId}`);
            break;
          }
          if (!task.pendingMerge) {
            status(
              `Task ${task.id} has no pending merge — Approve only applies to ` +
                `tasks in awaiting-approval (or merge-conflict for retry). ` +
                `Current status: ${task.status}.`,
            );
            break;
          }
          if (
            task.status !== "awaiting-approval" &&
            task.status !== "merge-conflict"
          ) {
            status(
              `Task ${task.id} status is ${task.status} — Approve only fires for ` +
                `awaiting-approval or merge-conflict (retry).`,
            );
            break;
          }
          const snapshot = task.pendingMerge;
          const message =
            customMessage?.trim() ||
            `Approve task ${task.id}: ${task.title}`;

          // LB3 (round-13): branch-protection three-state check. Refuse
          // Approve when the repo's protection cannot be verified or
          // is verified-unprotected, UNLESS the user has explicitly
          // accepted the limited guarantee (`/branch-protection
          // accept-limited`). The flag is per-repoRoot so a single ack
          // covers all subsequent Approves for the same repo.
          const ackedRepo = !!store.branchProtectionAcks[snapshot.repoRoot];
          let limitedGuarantee = ackedRepo;
          if (!ackedRepo) {
            const protectionState = await checkBranchProtection(snapshot.repoRoot);
            if (protectionState === "verified-unprotected") {
              status(
                `Branch protection NOT enabled on origin/${APPROVAL_TARGET_BRANCH} for ${snapshot.repoRoot}. ` +
                  `Enable it via the GitHub repo's Settings → Branches page, OR run ` +
                  `'/branch-protection accept-limited' to proceed with limited guarantee. ` +
                  `Approve refused for task ${task.id}.`,
              );
              break;
            }
            if (protectionState === "unknown") {
              status(
                `Cannot verify branch protection on origin/${APPROVAL_TARGET_BRANCH} for ${snapshot.repoRoot} ` +
                  `(non-GitHub remote, missing 'gh', or auth/network failure). ` +
                  `Run '/branch-protection accept-limited [-- <note>]' to confirm equivalent ` +
                  `protection elsewhere and proceed. Approve refused for task ${task.id}.`,
              );
              break;
            }
            // verified-protected → silent, proceed (no flag set).
          }

          // In-flight indicator. The user-facing footer shows a clear
          // progression: awaiting-approval → approved-merging → completed.
          store.updateTask(
            task.id,
            { status: "approved-merging" },
            collabSessionId,
          );
          status(`Approving task ${task.id}…`);

          // Step 1: capture uncommitted residue if present. Skip when the
          // diff summary shows committed-only delta — calling
          // git_create_approval_commit on a clean tree returns EmptyCommit
          // which we'd then have to special-case (see backend doc on
          // line 845 of git.rs).
          //
          // Round-12 codex1+codex2+claude2 H1: after a successful approval-
          // commit, we MUST mutate pendingMerge.diffSummary so a subsequent
          // retry (after merge failure) doesn't re-issue the now-redundant
          // approval-commit against a clean tree (which would short-circuit
          // to EmptyCommit and never reach the merge step). Fold the residue
          // into `committed` and zero out the working-tree fields.
          const ds = snapshot.diffSummary;
          const hasResidue =
            ds.staged.length > 0 ||
            ds.unstaged.length > 0 ||
            ds.untracked.length > 0;
          if (hasResidue) {
            try {
              // Round-20 P5 (claude2 task-70 Concern 5 carry-over):
              // strip the leading `@` so the git author string renders
              // as `claude1 via orchestrator <…>` instead of `@claude1
              // via orchestrator <…>`. The `@` is a UI/mention sigil,
              // not part of the actual handle.
              const cleanAgentHandle = snapshot.agentHandle.replace(/^@/, "");
              const result = await invoke<{ commitSha: string; stagedCount: number }>(
                "git_create_approval_commit",
                {
                  worktreePath: snapshot.worktreePath,
                  message,
                  agentHandle: cleanAgentHandle,
                },
              );
              // Normalize the snapshot so retries skip approval-commit.
              // The residue files (staged|unstaged|untracked) are now part
              // of `committed`; drop duplicates while folding.
              const newCommitted = Array.from(
                new Set([
                  ...ds.committed,
                  ...ds.staged,
                  ...ds.unstaged,
                  ...ds.untracked,
                ]),
              );
              const updatedSnapshot = {
                ...snapshot,
                diffSummary: {
                  committed: newCommitted,
                  staged: [] as string[],
                  unstaged: [] as string[],
                  untracked: [] as string[],
                },
              };
              store.updateTask(
                task.id,
                { pendingMerge: updatedSnapshot },
                collabSessionId,
              );
              // Mutate the local snapshot too so the rest of this Approve
              // run sees the normalized state (cosmetic — the merge step
              // doesn't read diffSummary, but be consistent).
              snapshot.diffSummary = updatedSnapshot.diffSummary;
              // commitSha / stagedCount are informational; the merge step
              // is what advances the task forward.
              void result;
            } catch (err) {
              // Structured GitError → surface variant. Restore status
              // to awaiting-approval so the user can fix and retry.
              store.updateTask(
                task.id,
                { status: "awaiting-approval" },
                collabSessionId,
              );
              status(`Approval-commit failed for ${task.id}: ${formatGitError(err)}`);
              break;
            }
          }

          // Step 2: merge into dev.
          let mergedSha: string | undefined;
          let pushed = false;
          let pushFailedAfterMerge: { sha: string; stderr: string } | null = null;
          try {
            const result = await invoke<{ mergedSha: string; pushed: boolean }>(
              "git_merge_worktree",
              {
                repoRoot: snapshot.repoRoot,
                branchName: snapshot.branch,
                targetBranch: APPROVAL_TARGET_BRANCH,
                push: wantsPush,
              },
            );
            mergedSha = result.mergedSha;
            pushed = result.pushed;
          } catch (err) {
            // Structured GitError → variant-specific status routing.
            const gitErr = err as GitErrorShape;
            const kind = gitErr?.kind;
            // PushFailedAfterMerge is special: the local merge succeeded;
            // only the push failed. Treat as merge-locally-completed; the
            // user can re-push manually with `git push origin dev`.
            if (kind === "pushFailedAfterMerge") {
              pushFailedAfterMerge = {
                sha: gitErr.mergedSha ?? "(unknown sha)",
                stderr: gitErr.stderr ?? "",
              };
              mergedSha = gitErr.mergedSha;
              pushed = false;
            } else {
              // Merge-conflict subset → status `merge-conflict`. The
              // worktree is preserved (backend ran `git merge --abort`
              // on the parent, leaving the worktree itself intact).
              const isMergeFailure =
                kind === "mergeConflict" ||
                kind === "hookFailed";
              const newStatus: TaskStatus = isMergeFailure
                ? "merge-conflict"
                : "awaiting-approval";
              store.updateTask(
                task.id,
                { status: newStatus },
                collabSessionId,
              );
              status(`Merge failed for ${task.id}: ${formatGitError(err)}`);
              break;
            }
          }

          // Step 3: cleanup the worktree on disk + release the lease.
          // Never block on cleanup failure — the merge is the load-bearing
          // outcome; cleanup residue is recoverable. Surface as a warning
          // appended to the status, but treat the task as completed.
          let cleanupWarn = "";
          try {
            const outcome = await invoke<unknown>("git_worktree_remove", {
              repoRoot: snapshot.repoRoot,
              worktreePath: snapshot.worktreePath,
              branchName: snapshot.branch,
            });
            // Recognize the WorktreeRemovedBranchPreserved variant so the
            // user knows the branch survived (cleanup needed manually).
            if (
              outcome &&
              typeof outcome === "object" &&
              "kind" in outcome &&
              (outcome as { kind?: string }).kind ===
                "worktreeRemovedBranchPreserved"
            ) {
              cleanupWarn = ` (worktree removed; branch ${snapshot.branch} preserved — delete manually if desired)`;
            }
          } catch (err) {
            cleanupWarn = ` (cleanup warning: ${err})`;
          }
          // Even if the worktree-remove call failed, we successfully
          // merged the work into dev. Release the lease so a new task
          // can be assigned to this agent.
          store.releaseAgentWorktree(snapshot.agentHandle, collabSessionId);

          // Step 4: transition task to terminal `completed`. The central
          // pendingMerge cleanup in updateTask auto-clears the snapshot.
          const conclusion = pushFailedAfterMerge
            ? `Approved & merged locally as ${pushFailedAfterMerge.sha} (push failed: ${pushFailedAfterMerge.stderr.split("\n")[0]})`
            : pushed
            ? `Approved, merged, and pushed: ${mergedSha}`
            : `Approved & merged locally: ${mergedSha}`;
          store.updateTask(
            task.id,
            { status: "completed", conclusion },
            collabSessionId,
          );

          // LB3 P7: prefix `[limited-guarantee]` on the final status when
          // the user has accepted the limited guarantee for this repo.
          // Equivalent to the v5-spec "yellow banner" since the slash-
          // command surface is text-only.
          const lgPrefix = limitedGuarantee ? "[limited-guarantee] " : "";
          if (pushFailedAfterMerge) {
            status(
              `${lgPrefix}Task ${task.id} approved & merged locally as ${pushFailedAfterMerge.sha}, but push failed: ${pushFailedAfterMerge.stderr.split("\n")[0]}. ` +
                `Re-push manually with 'git push origin ${APPROVAL_TARGET_BRANCH}'.${cleanupWarn}`,
            );
          } else {
            status(
              `${lgPrefix}Task ${task.id} approved${pushed ? " & pushed" : " & merged locally"}: ${mergedSha}${cleanupWarn}`,
            );
          }
          break;
        }

        // /task <id> discard [<reason>]
        // D14: explicitly throw away the worktree + branch. Used when the
        // reviewer rejects the agent's work entirely. Runs:
        //   1. git_worktree_remove (force)
        //   2. git_branch_force_delete (the user's explicit decision to
        //      destroy unmerged work)
        //   3. transition task to `blocked` (the abandoned terminal state;
        //      central cleanup auto-clears pendingMerge), with reason in
        //      the conclusion.
        //   4. release the agent's worktree lease.
        const discardMatch = sub.match(/^(\S+)\s+discard(?:\s+(.+))?$/s);
        if (discardMatch) {
          if (!collabSessionId) {
            status("Task commands require a collaborator session.");
            break;
          }
          const [, taskId, reason] = discardMatch;
          const task = store
            .getTasks(collabSessionId)
            .find((t) => t.id === taskId || t.id.startsWith(taskId));
          if (!task) {
            status(`Task not found: ${taskId}`);
            break;
          }
          if (!task.pendingMerge) {
            status(
              `Task ${task.id} has no pending merge to discard — Discard only ` +
                `applies to tasks in awaiting-approval or merge-conflict.`,
            );
            break;
          }
          const snapshot = task.pendingMerge;

          // Step 1: remove the worktree from disk.
          //
          // Round-12 codex2 H2: worktree removal is LOAD-BEARING for
          // Discard, not "best-effort + partial-cleanup-still-a-Discard"
          // as the prior round-11 implementation treated it. If the
          // backend can't remove the worktree (e.g., locked by another
          // git operation, file-system error), the source delta still
          // exists on disk and we MUST NOT release the lease or mark
          // the task `blocked` — that would corrupt the LB5 lease model
          // and lose the only remaining handle on the orphaned worktree.
          // Refuse the entire Discard and let the user retry after
          // resolving the cleanup error.
          try {
            await invoke("git_worktree_remove", {
              repoRoot: snapshot.repoRoot,
              worktreePath: snapshot.worktreePath,
              branchName: snapshot.branch,
            });
          } catch (err) {
            status(
              `Discard refused for ${task.id}: worktree-remove failed (${err}). ` +
                `Resolve the cleanup error and retry — task remains in ${task.status} ` +
                `with the lease held to keep the orphaned worktree visible.`,
            );
            break;
          }

          // Step 2: force-delete the branch (Discard explicitly throws
          // away the work; -d would refuse on unmerged commits). Branch
          // deletion failure AFTER successful worktree removal is just
          // cleanup debt — the load-bearing artifact (the worktree) is
          // gone, so it's safe to mark the task discarded with a warning.
          let removeWarn = "";
          try {
            await invoke("git_branch_force_delete", {
              repoRoot: snapshot.repoRoot,
              branchName: snapshot.branch,
            });
          } catch (err) {
            removeWarn = ` (branch-delete warning: ${err})`;
          }

          // Step 3: release the lease and mark task blocked. The central
          // pendingMerge cleanup in updateTask clears the snapshot.
          store.releaseAgentWorktree(snapshot.agentHandle, collabSessionId);
          const conclusion = reason?.trim()
            ? `Discarded: ${reason.trim()}`
            : "Discarded";
          store.updateTask(
            task.id,
            { status: "blocked", conclusion },
            collabSessionId,
          );
          status(`Task ${task.id} discarded${removeWarn}`);
          break;
        }

        // /task <id> done [notes]
        const doneMatch = sub.match(/^(\S+)\s+done(?:\s+(.+))?$/s);
        if (doneMatch) {
          if (!collabSessionId) {
            status("Task commands require a collaborator session.");
            break;
          }
          const [, taskId, notes] = doneMatch;
          const task = store.getTasks(collabSessionId).find((t) => t.id === taskId || t.id.startsWith(taskId));
          if (!task) {
            status(`Task not found: ${taskId}`);
            break;
          }
          // LB4 (codex2 task-59 H1): refuse manual /task done for
          // worktree-backed tasks. This slash-command bypasses the P2
          // awaiting-approval gate. The agent should write .done.json
          // (which routes through scanForTaskCompletions and engages
          // the gate). Manual completion would silently mark the task
          // `completed` without orchestrator review of the worktree's
          // diff.
          if (isTaskWorktreeBacked(task, store.agents, collabSessionId)) {
            status(
              `Task ${task.id} is assigned to a worktree-backed agent — /task done bypasses the approval gate. ` +
                `Use the agent's .done.json flow (auto-routes through the gate) or /task ${task.id} status blocked to abandon.`,
            );
            break;
          }
          store.updateTask(task.id, {
            status: "completed",
            conclusion: notes?.trim() ?? null,
          }, collabSessionId);
          status(`Task ${task.id} completed${notes ? ` — ${notes.trim()}` : ""}`);
          break;
        }

        status("Usage: /task list | add <title> | <id> status|assign|done|approve|discard");
      } catch (err) {
        status(`Task error: ${err}`);
      }
      break;
    }

    case "branch-protection": {
      // LB3 wizard slash-command surface. Subcommands:
      //   /branch-protection                 — list current state across
      //                                        repos that have agents
      //   /branch-protection check           — re-run the check for
      //                                        the active session's repo
      //   /branch-protection accept-limited [-- <note>]
      //                                      — explicitly accept the
      //                                        limited guarantee for
      //                                        the active session's repo
      //   /branch-protection list-acks       — show acked repos
      //   /branch-protection clear-ack [<repoRoot>]
      //                                      — undo a previous ack
      //                                        (round-15 polish for
      //                                        post-protection-enable)
      try {
        if (!collabSessionId) {
          status("Branch-protection commands require a collaborator session.");
          break;
        }
        const sub = cmd.message ?? "";

        // Find the repo root, preferring a live agent record. Round-13
        // codex2 M1 fallback: if no agent has a worktree (e.g., the
        // close-pane race or a manual record removal stripped the
        // SpawnedAgent record), look at the freshest task with
        // `pendingMerge`. The pendingMerge snapshot is self-contained
        // (RESID-5) and carries `repoRoot` independent of the agent
        // record, so accept-limited can still identify the repo when
        // the user needs it most — i.e., when an Approve has just
        // refused with "run accept-limited" but the agent record was
        // lost in between.
        const sessionAgent = scopedAgents.find((a) => a.worktree);
        let activeRepoRoot = sessionAgent?.worktree?.repoRoot;
        if (!activeRepoRoot && collabSessionId) {
          const sessionTasks = store.getTasks(collabSessionId);
          // Prefer awaiting-approval / merge-conflict (the states where
          // the user actually needs to ack to proceed) over any random
          // task with a stale pendingMerge.
          const candidates = sessionTasks
            .filter((t) => t.pendingMerge)
            .sort((a, b) => {
              const priority = (s: string): number =>
                s === "awaiting-approval" || s === "merge-conflict" ? 0 : 1;
              return priority(a.status) - priority(b.status);
            });
          activeRepoRoot = candidates[0]?.pendingMerge?.repoRoot;
        }

        if (sub === "" || sub === "status") {
          if (!activeRepoRoot) {
            status(
              "No worktree-backed agent in this session — branch-protection " +
                "applies to repos with active worktrees.",
            );
            break;
          }
          const ack = store.branchProtectionAcks[activeRepoRoot];
          if (ack) {
            status(
              `Limited guarantee accepted for ${activeRepoRoot} at ${ack.acceptedAt}` +
                (ack.note ? ` — note: ${ack.note}` : "") +
                ". Run '/branch-protection check' to re-evaluate.",
            );
          } else {
            status(
              `No limited-guarantee ack for ${activeRepoRoot}. ` +
                `Run '/branch-protection check' to verify origin/${APPROVAL_TARGET_BRANCH} protection.`,
            );
          }
          break;
        }

        if (sub === "check") {
          if (!activeRepoRoot) {
            status(
              "No worktree-backed agent in this session — cannot identify " +
                "a repo to check.",
            );
            break;
          }
          // Round-20: use the detail-returning variant so we can render
          // weak-vs-empty diagnostic specificity per claude3 task-99 O4.
          // Round-21 (claude3 task-99 O5): /branch-protection check is
          // an explicit user re-evaluation request — bypass the cache
          // so the user sees fresh protection state, e.g., after they
          // just enabled protection on GitHub.
          const verdict = await checkBranchProtectionDetail(
            activeRepoRoot,
            undefined,
            undefined,
            { useCache: false },
          );
          // Show the detected host (GHE-aware) when available, otherwise
          // the canonical origin/<branch> name.
          const branchLabel = verdict.host
            ? `${verdict.host}/${APPROVAL_TARGET_BRANCH}`
            : `origin/${APPROVAL_TARGET_BRANCH}`;
          if (verdict.state === "verified-protected") {
            status(
              `Branch protection verified on ${branchLabel} for ${activeRepoRoot}. ` +
                "Approve will run silently.",
            );
          } else if (verdict.state === "verified-unprotected") {
            // Round-20 (codex2 task-116 M1, claude3 task-117 O1): render
            // the weak-vs-empty diagnostic. If the rule exists but only
            // has non-blocking fields, name them so the user knows
            // exactly what to add.
            let detailMsg = "";
            const d = verdict.detail;
            if (d?.classification === "weak" && d.nonBlockingFields.length > 0) {
              detailMsg =
                ` (rule includes ${d.nonBlockingFields.join(", ")} but no direct-push-blocking field)`;
            } else if (d?.classification === "empty") {
              detailMsg = " (rule exists but every direct-push-blocking field is null)";
            }
            status(
              `Branch protection NOT enabled on ${branchLabel} for ${activeRepoRoot}${detailMsg}. ` +
                "Enable via Settings → Branches (add Required PR reviews or push restrictions), OR run " +
                "'/branch-protection accept-limited' to proceed with limited guarantee.",
            );
          } else {
            status(
              `Cannot verify branch protection on ${branchLabel} for ${activeRepoRoot} ` +
                "(non-GitHub remote, missing 'gh', or auth/network failure). " +
                "Run '/branch-protection accept-limited [-- <note>]' to proceed.",
            );
          }
          break;
        }

        const ackMatch = sub.match(/^accept-limited(?:\s+--\s+(.+))?$/s);
        if (ackMatch) {
          if (!activeRepoRoot) {
            status(
              "No worktree-backed agent in this session — cannot identify " +
                "a repo to ack.",
            );
            break;
          }
          const note = ackMatch[1]?.trim();
          if (store.branchProtectionAcks[activeRepoRoot]) {
            status(
              `Limited guarantee already accepted for ${activeRepoRoot}. No change.`,
            );
            break;
          }
          store.acceptBranchProtectionLimited(activeRepoRoot, note);
          status(
            `Limited guarantee accepted for ${activeRepoRoot}` +
              (note ? ` (note: ${note})` : "") +
              ". Future Approves will proceed with the [limited-guarantee] prefix.",
          );
          break;
        }

        if (sub === "list-acks") {
          const acks = store.branchProtectionAcks;
          const entries = Object.entries(acks);
          if (entries.length === 0) {
            status("No limited-guarantee acks recorded.");
          } else {
            const lines = [`${entries.length} ack(s):`];
            for (const [repo, info] of entries) {
              lines.push(
                `  ${repo} @ ${info.acceptedAt}` +
                  (info.note ? ` — ${info.note}` : ""),
              );
            }
            status(lines.join("  "));
          }
          break;
        }

        // /branch-protection clear-ack [<repoRoot>]
        // Round-15 polish (claude3 O3): undo a previous accept-limited
        // for a repo, e.g., after the user has enabled real branch
        // protection on GitHub. Without this, the persisted ack would
        // bypass the wizard forever. With no arg, clears the active
        // session's repo (same fallback as accept-limited).
        const clearMatch = sub.match(/^clear-ack(?:\s+(.+))?$/);
        if (clearMatch) {
          const explicitRepo = clearMatch[1]?.trim();
          const target = explicitRepo || activeRepoRoot;
          if (!target) {
            status(
              "No worktree-backed agent in this session and no explicit " +
                "<repoRoot> argument — cannot identify a repo to clear. " +
                "Usage: /branch-protection clear-ack [<repoRoot>]",
            );
            break;
          }
          if (!store.branchProtectionAcks[target]) {
            status(`No limited-guarantee ack to clear for ${target}.`);
            break;
          }
          store.clearBranchProtectionAck(target);
          // Round-21 (claude3 task-99 O5): also flush any cached
          // verified-protected verdict so the next Approve re-checks
          // gh api. Without this, a user clearing the ack would still
          // hit a cached "verified-protected" entry (if they happened
          // to be acked AND had a cached protected verdict) and skip
          // the wizard. Cache flush ensures the next check is fresh.
          invalidateVerifiedProtectedCache(target);
          status(
            `Cleared limited-guarantee ack for ${target}. Next /task approve ` +
              "will re-run the branch-protection wizard.",
          );
          break;
        }

        status(
          "Usage: /branch-protection [status] | check | accept-limited [-- <note>] " +
            "| clear-ack [<repoRoot>] | list-acks",
        );
      } catch (err) {
        status(`Branch-protection error: ${err}`);
      }
      break;
    }

    case "memory": {
      try {
        const sub = cmd.message ?? "";
        if (sub === "list" || sub === "") {
          const files = await invoke<string[]>("list_memory_files");
          status(
            files.length === 0
              ? "No shared memory files."
              : `Memory: ${files.join(", ")}`,
          );
        } else if (sub.startsWith("read ")) {
          const relPath = sub.slice("read ".length).trim();
          const content = await invoke<string | null>("read_memory_file", {
            relativePath: relPath,
          });
          status(
            content
              ? `${relPath}: ${content.slice(0, 200)}`
              : `Not found: ${relPath}`,
          );
        } else if (sub.startsWith("delete ")) {
          const relPath = sub.slice("delete ".length).trim();
          const deleted = await invoke<boolean>("delete_memory_file", {
            relativePath: relPath,
          });
          status(deleted ? `Deleted: ${relPath}` : `Not found: ${relPath}`);
        } else if (sub === "clear") {
          await invoke("clear_memory_dir");
          status("All shared memory files cleared.");
        } else {
          status("Usage: /memory list|read <p>|delete <p>|clear");
        }
      } catch (err) {
        status(`Memory error: ${err}`);
      }
      break;
    }

    case "rename": {
      if (!cmd.target || !cmd.message) {
        status('Usage: /rename @<agent> <new nickname>');
        break;
      }
      const targetAgent = resolveAgent(cmd.target, scopedAgents);
      if (!targetAgent) {
        status(`Agent "${cmd.target}" not found.`);
        break;
      }
      // Strip a leading "@" if the user typed it as part of the nickname value.
      // The rename action validates and returns RenameResult — we surface
      // result.message verbatim on failure (store owns the strings).
      const newNickname = cmd.message.replace(/^@/, "");
      const result = store.renameAgent(targetAgent.sessionId, newNickname);
      if (result.ok) {
        status(
          `Agent @${targetAgent.handle} renamed to "${newNickname.trim()}"`,
        );
      } else {
        status(result.message);
      }
      break;
    }

    default: {
      status("Unknown command. Type /help.");
    }
  }
}
