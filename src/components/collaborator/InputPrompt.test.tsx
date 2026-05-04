import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { InputPrompt } from "./InputPrompt";
import { CollabSessionContext } from "./CollabSessionContext";
import { useCollaboratorStore, _resetWriteStateForTests } from "../../stores/collaboratorStore";
import { useTerminalStore } from "../../stores/terminalStore";
import type { SpawnedAgent } from "../../types/collaborator";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

const SESSION = "input-prompt-test";

function resetStores() {
  useTerminalStore.setState({
    unreadByCollabSession: {},
    tabs: [],
    activeTabId: null,
  });
  useCollaboratorStore.setState({
    agents: [],
    tasksBySession: {},
    statusMessages: {},
    logEntriesBySession: {},
    recentOutcomesBySession: {},
    contextSentByAgent: {},
    fsdByLeaderSessionId: {},
    fsdProtocolPendingByAgent: {},
    pendingInputs: {},
    pendingMessagesByAgent: {},
  });
  _resetWriteStateForTests();
  vi.mocked(invoke).mockClear();
}

function spawn(tool: SpawnedAgent["tool"], sessionId: string) {
  useCollaboratorStore.getState().addAgent({
    sessionId,
    tool,
    status: "running",
    collabSessionId: SESSION,
  });
}

function renderPrompt() {
  return render(
    <CollabSessionContext.Provider value={SESSION}>
      <InputPrompt />
    </CollabSessionContext.Provider>,
  );
}

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  cleanup();
});

describe("InputPrompt target selector", () => {
  it("opens the selector with a single inline @agent preselected instead of sending immediately", async () => {
    spawn("claude_code", "pty-claude");
    spawn("codex_cli", "pty-codex");
    vi.mocked(invoke).mockClear();
    renderPrompt();

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Check the current fix @claude1." } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(await screen.findByText(/Send to:/)).toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith(
      "inject_into_pty",
      expect.anything(),
    );

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "inject_into_pty",
        expect.objectContaining({ sessionId: "pty-claude" }),
      );
    });
  });
});
