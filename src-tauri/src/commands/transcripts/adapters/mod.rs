// Per-tool transcript adapters.
//
// Production adapter set per K3 (cumulative reviewer fold): three concrete
// adapters here, and an Aider TEST-ONLY fixture at
// `src-tauri/tests/transcript_adapter_contract.rs`. Aider does NOT ship as
// a production adapter — it would contradict the X3 narrowing
// ("transcript adapters for EXISTING registered tools only"; Aider is
// not in `ToolId`/`TOOL_CONFIGS`).

pub mod claude_code;
pub mod codex;
pub mod gemini;
