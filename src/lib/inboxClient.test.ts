/**
 * Tests for `inboxClient` — the typed Tauri command wrappers.
 *
 * Round-7 frontend slice (claude5). Validates:
 *
 * 1. Each wrapper invokes the correct Tauri command name.
 * 2. Argument names follow Tauri's snake_case→camelCase convention
 *    (so the IPC layer correctly routes parameters to the Rust signature).
 * 3. The `InboxScope` constructors produce JSON shapes that match what the
 *    Rust adjacently-tagged enum expects on deserialization.
 * 4. Validation helpers in `types/inbox.ts` accept canonical inputs and
 *    reject malformed inputs symmetrically with the Rust validator.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/api/core BEFORE importing the client.
// `invoke` is the only symbol the client uses. Using vi.hoisted because
// vi.mock factories are hoisted above imports, so the mock fn must be
// defined inside the hoisted block to avoid the
// "Cannot access 'invokeMock' before initialization" error.
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

// Imports must come AFTER vi.mock — Vitest hoists `vi.mock` calls so they
// run before any module imports, but the imports themselves must resolve
// after the mock factory runs.
import {
  fsdInboxAck,
  fsdInboxClaim,
  fsdInboxListPending,
  fsdInboxReapStale,
  fsdInboxWriteMessage,
} from "./inboxClient";
import {
  AGENT_ID_HEX_WIDTH,
  ENVELOPE_SCHEMA_VERSION,
  InboxScope,
  MAX_ATTEMPTS,
  MESSAGE_ID_HEX_WIDTH,
  priorityForKind,
  validateIdHex,
  type ClaimedMessage,
  type InboxMessage,
  type InboxMessagePartial,
} from "../types/inbox";

beforeEach(() => {
  invokeMock.mockReset();
});

// ---------------------------------------------------------------------------
// Constants — pin the wire-shape contract
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("MESSAGE_ID_HEX_WIDTH matches Rust value (16)", () => {
    // Rust: src-tauri/src/fsd/inbox.rs::MESSAGE_ID_HEX_WIDTH
    expect(MESSAGE_ID_HEX_WIDTH).toBe(16);
  });

  it("AGENT_ID_HEX_WIDTH matches Rust value (8)", () => {
    expect(AGENT_ID_HEX_WIDTH).toBe(8);
  });

  it("ENVELOPE_SCHEMA_VERSION matches Rust value (1)", () => {
    expect(ENVELOPE_SCHEMA_VERSION).toBe(1);
  });

  it("MAX_ATTEMPTS matches Rust value (3)", () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// priorityForKind — must match Rust's `priority_for_kind` table exactly
// ---------------------------------------------------------------------------

describe("priorityForKind", () => {
  it("control = 9 (urgent)", () => {
    expect(priorityForKind("control")).toBe(9);
  });

  it("user_prompt = 7 (high)", () => {
    expect(priorityForKind("user_prompt")).toBe(7);
  });

  it("iteration_report = 5 (normal)", () => {
    expect(priorityForKind("iteration_report")).toBe(5);
  });

  it("agent_message = 3 (low)", () => {
    expect(priorityForKind("agent_message")).toBe(3);
  });

  it("broadcast = 1 (background)", () => {
    expect(priorityForKind("broadcast")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// InboxScope constructors — wire shape MUST match adjacently-tagged serde
// ---------------------------------------------------------------------------

describe("InboxScope constructors", () => {
  // Empirically verified against Rust: serde adjacently-tagged enum
  // (`#[serde(tag = "kind", content = "value")]`) emits:
  //   Global               → {"kind":"global"}
  //   Leader { handle }    → {"kind":"leader","value":{"handle":"..."}}
  //   Agent { agent_id }   → {"kind":"agent","value":{"agent_id":"..."}}

  it("global() emits {kind: 'global'} with NO value field", () => {
    const scope = InboxScope.global();
    expect(scope).toEqual({ kind: "global" });
    expect("value" in scope).toBe(false);
  });

  it("leader() emits {kind: 'leader', value: { handle }}", () => {
    const scope = InboxScope.leader("claude1");
    expect(scope).toEqual({
      kind: "leader",
      value: { handle: "claude1" },
    });
  });

  it("agent() emits {kind: 'agent', value: { agent_id }}", () => {
    const scope = InboxScope.agent("abc12345");
    expect(scope).toEqual({
      kind: "agent",
      value: { agent_id: "abc12345" },
    });
  });

  it("JSON round-trip preserves shape (matches Rust deserialization)", () => {
    const cases = [
      InboxScope.global(),
      InboxScope.leader("h1"),
      InboxScope.agent("abc12345"),
    ];
    for (const scope of cases) {
      const json = JSON.stringify(scope);
      const parsed = JSON.parse(json);
      expect(parsed).toEqual(scope);
    }
  });
});

// ---------------------------------------------------------------------------
// validateIdHex — symmetric with Rust's `validate_id_hex`
// ---------------------------------------------------------------------------

describe("validateIdHex", () => {
  it("accepts canonical 16-hex (lowercase)", () => {
    expect(validateIdHex("0123456789abcdef", 16)).toBeNull();
  });

  it("accepts canonical 8-hex (lowercase)", () => {
    expect(validateIdHex("a1b2c3d4", 8)).toBeNull();
  });

  it("rejects too-short", () => {
    expect(validateIdHex("a1b2c3d", 8)).toMatch(/expected exactly 8/);
  });

  it("rejects too-long", () => {
    expect(validateIdHex("a1b2c3d4e", 8)).toMatch(/expected exactly 8/);
  });

  it("rejects non-hex chars", () => {
    expect(validateIdHex("g1b2c3d4", 8)).toMatch(/lowercase hex/);
  });

  it("rejects uppercase hex (lowercase-only invariant)", () => {
    // Mirrors Rust: validate_id_hex_rejects_uppercase
    expect(validateIdHex("0123456789ABCDEF", 16)).toMatch(/lowercase hex/);
  });
});

// ---------------------------------------------------------------------------
// IPC wrappers — verify command name + camelCased argument routing
// ---------------------------------------------------------------------------

describe("fsdInboxWriteMessage", () => {
  it("invokes fsd_inbox_write_message with snake_case→camelCase args", async () => {
    invokeMock.mockResolvedValue("4-00000000000000000043-1714823900000-0123456789abcdef.json");

    const scope = InboxScope.leader("claude1");
    const partial: InboxMessagePartial = {
      message_id: "PLACEHOLDER0_____", // server-stamped; placeholder OK
      sender_id: "PLACEHOLDER",
      sender_kind: "user", // server-stamped
      target_id: "leader-claude1",
      kind: "user_prompt",
      content: "hello",
      created_at_ms: 1714823900000,
      run_id: null,
      task_id: null,
      turn: null,
      source_cmd_id: null,
      sn: null,
      rn: null,
      attempt: 1,
    };

    const filename = await fsdInboxWriteMessage(scope, partial, "pending");

    expect(invokeMock).toHaveBeenCalledOnce();
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("fsd_inbox_write_message");
    expect(args).toEqual({
      scope,
      partial,
      targetState: "pending", // camelCased per Tauri convention
    });
    expect(filename).toContain("0123456789abcdef.json");
  });
});

describe("fsdInboxListPending", () => {
  it("invokes fsd_inbox_list_pending with scope + limit", async () => {
    invokeMock.mockResolvedValue([
      "0-00000000000000000001-1714823900000-0123456789abcdef.json",
    ]);

    const result = await fsdInboxListPending(InboxScope.global(), 100);

    expect(invokeMock).toHaveBeenCalledOnce();
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("fsd_inbox_list_pending");
    expect(args).toEqual({ scope: { kind: "global" }, limit: 100 });
    expect(result).toHaveLength(1);
  });

  it("supports limit=0 for no-cap iteration", async () => {
    invokeMock.mockResolvedValue([]);
    await fsdInboxListPending(InboxScope.global(), 0);
    const [, args] = invokeMock.mock.calls[0];
    expect(args.limit).toBe(0);
  });
});

describe("fsdInboxClaim", () => {
  const sampleEnvelope: InboxMessage = {
    message_id: "0123456789abcdef",
    schema: 1,
    sender_id: "orchestrator",
    sender_kind: "orchestrator",
    target_id: "leader-claude1",
    kind: "iteration_report",
    content: "report content",
    created_at_ms: 1714823900000,
    seq_global: 43,
    priority: 5,
    run_id: "r1",
    task_id: null,
    turn: 3,
    source_cmd_id: null,
    sn: null,
    rn: null,
    attempt: 1,
  };

  it("returns ClaimedMessage on success", async () => {
    const claimed: ClaimedMessage = {
      envelope: sampleEnvelope,
      claim_token: "4-00000000000000000043-1714823900000-0123456789abcdef.json",
      claimed_at_ms: 1714823900100,
    };
    invokeMock.mockResolvedValue(claimed);

    const result = await fsdInboxClaim(
      InboxScope.leader("claude1"),
      "4-00000000000000000043-1714823900000-0123456789abcdef.json",
    );

    expect(invokeMock).toHaveBeenCalledOnce();
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("fsd_inbox_claim");
    expect(args.scope).toEqual({
      kind: "leader",
      value: { handle: "claude1" },
    });
    expect(args.filename).toBe(
      "4-00000000000000000043-1714823900000-0123456789abcdef.json",
    );
    expect(result).toEqual(claimed);
  });

  it("returns null on race-loss (another claimer won)", async () => {
    invokeMock.mockResolvedValue(null);

    const result = await fsdInboxClaim(
      InboxScope.leader("claude1"),
      "4-00000000000000000043-1714823900000-0123456789abcdef.json",
    );

    expect(result).toBeNull();
  });
});

describe("fsdInboxAck", () => {
  it("invokes fsd_inbox_ack with snake_case→camelCase args", async () => {
    invokeMock.mockResolvedValue(true);

    const ok = await fsdInboxAck(
      InboxScope.leader("claude1"),
      "4-00000000000000000043-1714823900000-0123456789abcdef.json",
      "0123456789abcdef",
    );

    expect(invokeMock).toHaveBeenCalledOnce();
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("fsd_inbox_ack");
    expect(args).toEqual({
      scope: { kind: "leader", value: { handle: "claude1" } },
      fullFilename:
        "4-00000000000000000043-1714823900000-0123456789abcdef.json",
      messageId: "0123456789abcdef",
    });
    expect(ok).toBe(true);
  });

  it("returns false on idempotent retry (file already moved)", async () => {
    invokeMock.mockResolvedValue(false);

    const ok = await fsdInboxAck(
      InboxScope.global(),
      "0-00000000000000000001-1714823900000-0123456789abcdef.json",
      "0123456789abcdef",
    );

    expect(ok).toBe(false);
  });
});

describe("fsdInboxReapStale", () => {
  it("invokes fsd_inbox_reap_stale with snake_case→camelCase args", async () => {
    invokeMock.mockResolvedValue(7); // 7 files reaped

    const moved = await fsdInboxReapStale(InboxScope.global(), 30);

    expect(invokeMock).toHaveBeenCalledOnce();
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("fsd_inbox_reap_stale");
    expect(args).toEqual({
      scope: { kind: "global" },
      olderThanSecs: 30,
    });
    expect(moved).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe("error propagation", () => {
  it("write rejects when invoke throws (server-side validation failure)", async () => {
    invokeMock.mockRejectedValue(
      "fsd_inbox_write_message: target_state \"audit\" not allowed (only Pending)",
    );

    await expect(
      fsdInboxWriteMessage(
        InboxScope.global(),
        {
          message_id: "0123456789abcdef",
          sender_id: "user",
          sender_kind: "user",
          target_id: "global",
          kind: "user_prompt",
          content: "x",
          created_at_ms: 0,
          run_id: null,
          task_id: null,
          turn: null,
          source_cmd_id: null,
          sn: null,
          rn: null,
          attempt: 1,
        },
        "audit", // server rejects this
      ),
    ).rejects.toMatch(/not allowed/);
  });

  it("ack rejects on filename/message_id mismatch (server cross-check)", async () => {
    invokeMock.mockRejectedValue(
      "fsd_inbox_ack: filename '...' does not match message_id '...'",
    );

    await expect(
      fsdInboxAck(
        InboxScope.global(),
        "0-00000000000000000001-1714823900000-deadbeefdeadbeef.json",
        "0123456789abcdef", // doesn't match the suffix
      ),
    ).rejects.toMatch(/does not match/);
  });
});
