export type PaneNode = PaneLeaf | PaneSplit;

export interface PaneLeaf {
  type: "leaf";
  sessionId: string;
}

export interface PaneSplit {
  type: "split";
  direction: "horizontal" | "vertical";
  children: [PaneNode, PaneNode];
}

export interface Tab {
  id: string;
  title: string;
  paneTree: PaneNode;
  activePaneSessionId: string;
  maximizedPaneSessionId: string | null;
}

export interface ClosedTab {
  tab: Tab;
  closedAt: number;
}
