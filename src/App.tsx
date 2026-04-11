import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { DrawingBoard } from "./components/canvas/DrawingBoard";
import { Toolbar } from "./components/canvas/Toolbar";
import { TerminalTabs } from "./components/terminal/TerminalTabs";
import { useCanvasIntegration } from "./components/canvas/CanvasIntegration";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useCanvasStore } from "./stores/canvasStore";

export default function App() {
  const { sendToTerminal } = useCanvasIntegration();
  const drawerOpen = useCanvasStore((s) => s.drawerOpen);
  useKeyboardShortcuts();

  return (
    <div className="flex h-screen w-screen bg-surface overflow-hidden">
      {drawerOpen ? (
        <PanelGroup direction="horizontal" className="flex-1">
          {/* Canvas panel — resizable */}
          <Panel defaultSize={35} minSize={20} maxSize={60}>
            <div className="flex h-full">
              <Toolbar onSendToTerminal={sendToTerminal} />
              <div className="flex-1 h-full min-w-0">
                <DrawingBoard />
              </div>
            </div>
          </Panel>

          <PanelResizeHandle className="w-1 bg-surface-lighter hover:bg-accent transition-colors cursor-col-resize" />

          {/* Terminal panel */}
          <Panel defaultSize={65} minSize={30}>
            <TerminalTabs />
          </Panel>
        </PanelGroup>
      ) : (
        <div className="flex-1 h-full">
          <TerminalTabs />
        </div>
      )}
    </div>
  );
}
