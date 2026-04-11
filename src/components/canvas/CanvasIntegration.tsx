import { useCallback } from "react";
import { serializeCanvas } from "../../lib/serializer";
import { invoke } from "@tauri-apps/api/core";
import { useTerminalStore, selectActiveSessionId } from "../../stores/terminalStore";
import { useCanvasStore } from "../../stores/canvasStore";

export function useCanvasIntegration() {
  const activeSessionId = useTerminalStore(selectActiveSessionId);
  const fabricCanvas = useCanvasStore((s) => s.fabricCanvas);

  const sendToTerminal = useCallback(async () => {
    if (!fabricCanvas || !activeSessionId) return;

    const prompt = serializeCanvas(fabricCanvas);
    if (!prompt.trim() || prompt === "I have a diagram with the following elements:\n\n") {
      return;
    }

    // Write the serialized drawing directly to the active terminal's stdin
    await invoke("write_to_pty", {
      sessionId: activeSessionId,
      data: prompt,
    });
  }, [fabricCanvas, activeSessionId]);

  return { sendToTerminal };
}
