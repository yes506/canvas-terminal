import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import type { PaneNode, PaneLeaf } from "../../types/terminal";
import { TerminalPane } from "./TerminalPane";
import { CollaboratorPane } from "../collaborator/CollaboratorPane";
import { useTerminalStore } from "../../stores/terminalStore";

interface PaneTreeProps {
  node: PaneNode;
}

function findLeaf(node: PaneNode, sessionId: string): PaneLeaf | null {
  if (node.type === "leaf") return node.sessionId === sessionId ? node : null;
  return findLeaf(node.children[0], sessionId) || findLeaf(node.children[1], sessionId);
}

function renderLeaf(leaf: PaneLeaf) {
  if (leaf.kind === "collaborator") {
    return <CollaboratorPane />;
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

  return <PaneNode_ node={node} />;
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
