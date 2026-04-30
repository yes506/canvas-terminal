import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AtMention, filterMentionEntries } from "./AtMention";
import { CollabSessionContext } from "./CollabSessionContext";
import { useCollaboratorStore } from "../../stores/collaboratorStore";
import { TOOL_CONFIGS, type SpawnedAgent } from "../../types/collaborator";

// The per-tool ordinal counter lives in a module-level Map keyed by
// `${collabSessionId}:${tool}` and is not cleared by zustand's setState. Use a
// unique pane id per test to keep ordinals fresh (claude1, claude2, …) without
// reaching into the store's private reset hooks.
let __paneCounter = 0;
function freshPanes(): { paneA: string; paneB: string } {
  __paneCounter += 1;
  return {
    paneA: `pane-A-${__paneCounter}`,
    paneB: `pane-B-${__paneCounter}`,
  };
}

function resetStore() {
  useCollaboratorStore.setState({
    agents: [],
    tasksBySession: {},
    statusMessages: {},
    logEntriesBySession: {},
    recentOutcomesBySession: {},
    contextSentByAgent: {},
    pendingMessagesByAgent: {},
  });
}

function spawn(
  collabSessionId: string,
  tool: SpawnedAgent["tool"],
  sessionId: string,
) {
  useCollaboratorStore.getState().addAgent({
    sessionId,
    tool,
    status: "running",
    collabSessionId,
  });
}

function renderDropdown(paneId: string, query: string) {
  return render(
    <CollabSessionContext.Provider value={paneId}>
      <AtMention query={query} selectedIndex={0} onSelect={() => {}} />
    </CollabSessionContext.Provider>,
  );
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  cleanup();
});

describe("filterMentionEntries", () => {
  it("filters agents by nickname slug prefix (case-insensitive)", () => {
    const { paneA } = freshPanes();
    spawn(paneA, "claude_code", "s1"); // claude1
    spawn(paneA, "claude_code", "s2"); // claude2
    useCollaboratorStore.getState().renameAgent("s2", "Bug Hunter");
    const agents = useCollaboratorStore
      .getState()
      .agents.filter((a) => a.collabSessionId === paneA);

    const lower = filterMentionEntries("bug", agents);
    const upper = filterMentionEntries("BUG", agents);
    expect(
      lower.find((e) => e.kind === "agent" && e.handle === "claude2"),
    ).toBeTruthy();
    expect(
      upper.find((e) => e.kind === "agent" && e.handle === "claude2"),
    ).toBeTruthy();
  });

  it("preserves handle-prefix matching after rename (claude prefix still finds renamed agent)", () => {
    const { paneA } = freshPanes();
    spawn(paneA, "claude_code", "s1"); // claude1
    spawn(paneA, "claude_code", "s2"); // claude2
    useCollaboratorStore.getState().renameAgent("s2", "Bug Hunter");
    const agents = useCollaboratorStore
      .getState()
      .agents.filter((a) => a.collabSessionId === paneA);

    const entries = filterMentionEntries("claude", agents);
    const handles = entries
      .filter((e): e is Extract<typeof e, { kind: "agent" }> => e.kind === "agent")
      .map((e) => e.handle);
    // Both claude1 (still named "Claude Code #1") and claude2 (renamed to
    // "Bug Hunter") must surface — handle prefix is a stable mention path
    // even after rename.
    expect(handles).toEqual(expect.arrayContaining(["claude1", "claude2"]));
  });

  it("appears once per agent even if multiple axes match (structural via Array.filter)", () => {
    const { paneA } = freshPanes();
    spawn(paneA, "claude_code", "s1"); // handle claude1, slug claude-code-1
    const agents = useCollaboratorStore
      .getState()
      .agents.filter((a) => a.collabSessionId === paneA);
    // Query "claude" matches both handle and nicknameSlug — still one entry.
    const entries = filterMentionEntries("claude", agents);
    const agentRows = entries.filter((e) => e.kind === "agent");
    expect(agentRows.length).toBe(1);
  });

  it("appends 'all' when query is empty or 'all'.startsWith(query)", () => {
    const { paneA } = freshPanes();
    spawn(paneA, "claude_code", "s1");
    const agents = useCollaboratorStore.getState().agents;

    expect(filterMentionEntries("", agents).some((e) => e.kind === "all")).toBe(true);
    expect(filterMentionEntries("a", agents).some((e) => e.kind === "all")).toBe(true);
    expect(filterMentionEntries("al", agents).some((e) => e.kind === "all")).toBe(true);
    expect(filterMentionEntries("xy", agents).some((e) => e.kind === "all")).toBe(false);
  });

  it("sorts agents by ordinal then tool.localeCompare (matches InputPrompt selector)", () => {
    const { paneA } = freshPanes();
    // Spawn order: codex1, claude1, claude2.
    // Insertion order would be codex1, claude1, claude2.
    // Ordinal-then-tool sort: claude_code wins the ordinal=1 tie via localeCompare,
    // so the expected order is claude1, codex1, claude2.
    spawn(paneA, "codex_cli", "sCodex"); // codex1, ordinal 1
    spawn(paneA, "claude_code", "sC1"); // claude1, ordinal 1
    spawn(paneA, "claude_code", "sC2"); // claude2, ordinal 2
    const agents = useCollaboratorStore
      .getState()
      .agents.filter((a) => a.collabSessionId === paneA);

    // Derive expected programmatically from the algorithm — never hand-typed.
    const expected = [...agents]
      .sort((a, b) => a.ordinal - b.ordinal || a.tool.localeCompare(b.tool))
      .map((a) => a.handle);
    expect(expected).toEqual(["claude1", "codex1", "claude2"]); // sanity check on the algorithm

    const entries = filterMentionEntries("", agents);
    const agentHandles = entries
      .filter((e): e is Extract<typeof e, { kind: "agent" }> => e.kind === "agent")
      .map((e) => e.handle);
    expect(agentHandles).toEqual(expected);
  });
});

describe("AtMention component", () => {
  it("onSelect callback receives the handle, not the slug (locks Option A at the AtMention boundary)", () => {
    const { paneA } = freshPanes();
    spawn(paneA, "claude_code", "s1");
    spawn(paneA, "claude_code", "s2");
    useCollaboratorStore.getState().renameAgent("s2", "Bug Hunter");

    let received: string | null = null;
    render(
      <CollabSessionContext.Provider value={paneA}>
        <AtMention
          query="bug"
          selectedIndex={0}
          onSelect={(name) => (received = name)}
        />
      </CollabSessionContext.Provider>,
    );

    // Click the only matching row
    const button = screen.getByRole("button");
    fireEvent.mouseDown(button);
    expect(received).toBe("claude2");
    expect(received).not.toBe("bug-hunter");
  });

  it("color class is sourced from TOOL_CONFIGS, stable after rename, exercises multi-token slug", () => {
    const { paneA } = freshPanes();
    spawn(paneA, "codex_cli", "sCodex"); // codex1
    // "Code Helper" → slug "code-helper" — multi-token slug exercising the
    // nicknameSlug filter axis (vs. the handle axis used for "codex" prefix).
    useCollaboratorStore.getState().renameAgent("sCodex", "Code Helper");

    renderDropdown(paneA, "code");

    const expected = TOOL_CONFIGS.find((c) => c.id === "codex_cli")!.colorClass;
    const primary = screen.getByText("Code Helper");
    expect(primary.className).toContain(expected);
  });

  it("is scoped to the active CollabSessionContext (no cross-pane pollination)", () => {
    const { paneA, paneB } = freshPanes();
    spawn(paneA, "claude_code", "sA");
    useCollaboratorStore.getState().renameAgent("sA", "Bug Hunter");
    spawn(paneB, "claude_code", "sB");
    useCollaboratorStore.getState().renameAgent("sB", "Bug Hunter");

    renderDropdown(paneA, "bug");
    expect(screen.getAllByRole("button").length).toBe(1);
    cleanup();

    renderDropdown(paneB, "bug");
    expect(screen.getAllByRole("button").length).toBe(1);
  });

  it("'all' row appears with 'Broadcast to all' label and text-accent color", () => {
    const { paneA } = freshPanes();
    spawn(paneA, "claude_code", "s1");
    renderDropdown(paneA, "");

    expect(screen.getByText("Broadcast to all")).toBeInTheDocument();
    const allPrimary = screen.getByText("@all");
    expect(allPrimary.className).toContain("text-accent");
  });

  it("includes exited agents in the dropdown (preserves recall pattern)", () => {
    const { paneA } = freshPanes();
    spawn(paneA, "claude_code", "s1");
    spawn(paneA, "claude_code", "s2");
    // Mark claude2 as exited directly in the store
    useCollaboratorStore.setState((s) => ({
      agents: s.agents.map((a) =>
        a.sessionId === "s2" ? { ...a, status: "exited" } : a,
      ),
    }));

    const agents = useCollaboratorStore
      .getState()
      .agents.filter((a) => a.collabSessionId === paneA);
    const entries = filterMentionEntries("claude", agents);
    const handles = entries
      .filter((e): e is Extract<typeof e, { kind: "agent" }> => e.kind === "agent")
      .map((e) => e.handle);
    expect(handles).toEqual(expect.arrayContaining(["claude1", "claude2"]));
  });
});
