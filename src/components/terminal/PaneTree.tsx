import { Component, type ReactNode } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import type { PaneNode, PaneLeaf } from "../../types/terminal";
import { TerminalPane } from "./TerminalPane";
import { CollaboratorPane } from "../collaborator/CollaboratorPane";
import { useTerminalStore } from "../../stores/terminalStore";

// ---------------------------------------------------------------------------
// Error boundary — prevents a crash in a pane from blanking the entire app
// ---------------------------------------------------------------------------

interface EBProps {
  children: ReactNode;
  fallbackLabel: string;
  /** When this value changes the error state is automatically cleared. */
  resetKey?: string;
}
interface EBState {
  error: Error | null;
  prevResetKey?: string;
}

class PaneErrorBoundary extends Component<EBProps, EBState> {
  state: EBState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: EBProps, state: EBState): Partial<EBState> | null {
    // Clear error when the tree structure changes (resetKey changes).
    if (props.resetKey !== undefined && props.resetKey !== state.prevResetKey) {
      return { error: null, prevResetKey: props.resetKey };
    }
    return null;
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-text-dim text-xs font-mono gap-2 p-4">
          <p className="text-red-400 font-bold">{this.props.fallbackLabel} crashed</p>
          <p className="text-red-300 max-w-xs text-center break-all">
            {this.state.error.message}
          </p>
          <button
            className="mt-2 px-3 py-1 rounded border border-surface-lighter hover:bg-surface-lighter text-text transition-colors"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------

interface PaneTreeProps {
  node: PaneNode;
}

function findLeaf(node: PaneNode, sessionId: string): PaneLeaf | null {
  if (node.type === "leaf") return node.sessionId === sessionId ? node : null;
  return findLeaf(node.children[0], sessionId) || findLeaf(node.children[1], sessionId);
}

/** Build a stable fingerprint from the pane tree shape. Used as PanelGroup id. */
function treeFingerprint(node: PaneNode): string {
  if (node.type === "leaf") return node.sessionId;
  return `${node.direction}-${treeFingerprint(node.children[0])}-${treeFingerprint(node.children[1])}`;
}

function renderLeaf(leaf: PaneLeaf) {
  if (leaf.kind === "collaborator") {
    return (
      <PaneErrorBoundary key={leaf.sessionId} fallbackLabel="Collaborator">
        <CollaboratorPane paneSessionId={leaf.sessionId} />
      </PaneErrorBoundary>
    );
  }
  return <TerminalPane sessionId={leaf.sessionId} />;
}

export function PaneTree({ node }: PaneTreeProps) {
  const maximizedId = useTerminalStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab?.maximizedPaneSessionId ?? null;
  });

  // If a pane is maximized, only render that pane
  if (maximizedId) {
    const leaf = findLeaf(node, maximizedId);
    if (leaf) return renderLeaf(leaf);
    return <TerminalPane sessionId={maximizedId} />;
  }

  return (
    <PaneErrorBoundary fallbackLabel="Pane layout" resetKey={treeFingerprint(node)}>
      <PaneNode_ node={node} />
    </PaneErrorBoundary>
  );
}

function PaneNode_({ node }: PaneTreeProps) {
  if (node.type === "leaf") {
    return renderLeaf(node);
  }

  const direction = node.direction === "horizontal" ? "vertical" : "horizontal";

  return (
    <PanelGroup direction={direction}>
      <Panel defaultSize={50} minSize={10}>
        <PaneNode_ node={node.children[0]} />
      </Panel>
      <PanelResizeHandle
        className={
          direction === "horizontal"
            ? "w-1 bg-surface-lighter hover:bg-accent transition-colors cursor-col-resize"
            : "h-1 bg-surface-lighter hover:bg-accent transition-colors cursor-row-resize"
        }
      />
      <Panel defaultSize={50} minSize={10}>
        <PaneNode_ node={node.children[1]} />
      </Panel>
    </PanelGroup>
  );
}
