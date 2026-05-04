import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({ session_nonce: "abc12345", emission_mode: "prompt_lines" }),
}));

import { FsdToggle } from "./FsdToggle";
import { useCollaboratorStore } from "../../stores/collaboratorStore";
import type { FsdLeaderState } from "../../types/fsd";

const SESSION = "pty-leader-1";
const HANDLE = "claude1";
const COLLAB = "collab-1";

function seedAgent() {
  useCollaboratorStore.setState({
    agents: [
      {
        sessionId: SESSION,
        tool: "claude_code",
        status: "running",
        collabSessionId: COLLAB,
        ordinal: 1,
        handle: HANDLE,
        nickname: "Claude Code #1",
        nicknameSlug: "claude-code-1",
        nameHistory: [
          { nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" },
        ],
      },
    ],
    fsdByLeaderSessionId: {},
    statusMessages: {},
  });
}

function seedActiveLeader(tier: FsdLeaderState["tier"]) {
  useCollaboratorStore.setState((s) => ({
    fsdByLeaderSessionId: {
      ...s.fsdByLeaderSessionId,
      [SESSION]: {
        leaderSessionId: SESSION,
        leaderHandle: HANDLE,
        tier,
        activeRunId: null,
        sessionNonce: "abc12345",
        runNonce: null,
        strikeCount: 0,
        emissionMode: "prompt_lines",
        tasks: [],
        status: null,
        turn: 0,
      },
    },
  }));
}

describe("FsdToggle — Auto-Pilot switch", () => {
  beforeEach(() => {
    seedAgent();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({
      session_nonce: "abc12345",
      emission_mode: "prompt_lines",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("OFF state renders 'Auto-Pilot OFF' with no x1/x2/x3 controls", () => {
    render(<FsdToggle leaderSessionId={SESSION} leaderHandle={HANDLE} />);

    const toggle = screen.getByRole("switch", { name: "Auto-Pilot toggle" });
    expect(toggle).toHaveTextContent("Auto-Pilot OFF");
    expect(toggle).toHaveAttribute("aria-checked", "false");

    // Phase 1 hides multi-tier picker; no x1/x2/x3 buttons should appear.
    expect(screen.queryByText(/x1/i)).toBeNull();
    expect(screen.queryByText(/x2/i)).toBeNull();
    expect(screen.queryByText(/x3/i)).toBeNull();
    // Old "Pilot" segment vocabulary is gone — no separate "Off"/"Pilot" buttons.
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("click OFF → ON invokes fsd_set_tier with tier=1 and updates store to 'pilot'", async () => {
    render(<FsdToggle leaderSessionId={SESSION} leaderHandle={HANDLE} />);

    const toggle = screen.getByRole("switch", { name: "Auto-Pilot toggle" });
    fireEvent.click(toggle);

    // Wait for the async fsd_set_tier to resolve.
    await vi.waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("fsd_set_tier", {
        leaderSessionId: SESSION,
        leaderHandle: HANDLE,
        tier: 1,
      });
    });

    // Store reflects the wire identifier "pilot" — UI rename is label-only.
    const stored = useCollaboratorStore.getState().fsdByLeaderSessionId[SESSION];
    expect(stored?.tier).toBe("pilot");
  });

  it("seeded ON state renders 'Auto-Pilot ON' with aria-checked=true", () => {
    seedActiveLeader("pilot");
    render(<FsdToggle leaderSessionId={SESSION} leaderHandle={HANDLE} />);

    const toggle = screen.getByRole("switch", { name: "Auto-Pilot toggle" });
    expect(toggle).toHaveTextContent("Auto-Pilot ON");
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("click ON → OFF invokes fsd_set_tier with tier=0 and updates store to 'off'", async () => {
    seedActiveLeader("pilot");
    render(<FsdToggle leaderSessionId={SESSION} leaderHandle={HANDLE} />);

    const toggle = screen.getByRole("switch", { name: "Auto-Pilot toggle" });
    fireEvent.click(toggle);

    await vi.waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("fsd_set_tier", {
        leaderSessionId: SESSION,
        leaderHandle: HANDLE,
        tier: 0,
      });
    });

    // setFsdTier deletes the leader entry on `tier === "off"` (collaboratorStore.ts:1342-1347)
    // — the absent-key state is the canonical "off" representation.
    const stored = useCollaboratorStore.getState().fsdByLeaderSessionId[SESSION];
    expect(stored).toBeUndefined();
  });

  it("disabled prop disables the toggle (no IPC, no state change)", () => {
    render(<FsdToggle leaderSessionId={SESSION} leaderHandle={HANDLE} disabled />);

    const toggle = screen.getByRole("switch", { name: "Auto-Pilot toggle" });
    expect(toggle).toBeDisabled();

    fireEvent.click(toggle);
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });
});
