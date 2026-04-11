import { useTerminal } from "./useTerminal";
import { useTerminalStore } from "../../stores/terminalStore";
import "@xterm/xterm/css/xterm.css";

interface TerminalPaneProps {
  sessionId: string;
}

export function TerminalPane({ sessionId }: TerminalPaneProps) {
  const { termRef } = useTerminal(sessionId);
  const setActivePaneSession = useTerminalStore((s) => s.setActivePaneSession);

  return (
    <div
      ref={termRef}
      className="w-full h-full bg-surface"
      style={{ minHeight: 50 }}
      onMouseDown={() => setActivePaneSession(sessionId)}
    />
  );
}
