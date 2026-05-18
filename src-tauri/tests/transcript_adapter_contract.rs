// Test-only fixture: TranscriptAdapter contract extensibility proof.
//
// Per K3 (cumulative reviewer fold): this fixture exists to satisfy the
// SUCCESS CRITERION "adding a transcript adapter for an existing registered
// tool requires zero changes outside the new adapters/<tool>.rs file."
//
// "Aider" is used here because it is NOT in `ToolId` / `TOOL_CONFIGS` and
// will not be in v1 production — the file's mere ability to implement the
// trait without touching anything else in `transcripts/` is the proof.
//
// CI grep mandated by Q2:
//   git grep -l -i aider -- 'src-tauri/src/**' 'src/**'  ⇒ MUST output 0 lines
//
// The fixture lives at `src-tauri/tests/transcript_adapter_contract.rs`,
// which is intentionally outside the `src/**` glob so the grep excludes it
// by path.

use canvas_terminal_lib::{
    ContentBlockTable, DiscoveryError, NormalizeContext, NormalizedTurn, RawTurn,
    TranscriptAdapter, TranscriptHandle,
};

const FIXTURE_ADAPTER_VERSION: &str = "0.0.0-fixture";

const FIXTURE_INCLUSION_TABLE: ContentBlockTable = ContentBlockTable {
    include: &["text"],
    exclude: &["thinking", "tool_use", "tool_result", "system"],
};

struct FixtureAdapter;

impl TranscriptAdapter for FixtureAdapter {
    fn tool_id(&self) -> &'static str {
        "aider"
    }

    fn adapter_version(&self) -> &'static str {
        FIXTURE_ADAPTER_VERSION
    }

    fn discover_session(
        &self,
        _agent_handle: &str,
        _pid: i32,
        _spawned_at_unix_ms: i64,
    ) -> Result<TranscriptHandle, DiscoveryError> {
        Err(DiscoveryError::NoMatchingFd)
    }

    fn inclusion_table(&self) -> &ContentBlockTable {
        &FIXTURE_INCLUSION_TABLE
    }

    fn parse_native_lines(&self, _bytes: &[u8]) -> (Vec<RawTurn>, usize) {
        (Vec::new(), 0)
    }

    fn normalize(&self, _raw: RawTurn, _ctx: NormalizeContext<'_>) -> Option<NormalizedTurn> {
        None
    }
}

#[test]
fn fixture_implements_trait() {
    let adapter: &dyn TranscriptAdapter = &FixtureAdapter;
    // Mere construction + dyn-coercion is the contract proof. The body
    // bounds the trait's object-safety and confirms a fourth adapter can
    // exist without touching anything in `src-tauri/src/commands/transcripts/`.
    assert_eq!(adapter.tool_id(), "aider");
    assert_eq!(adapter.adapter_version(), FIXTURE_ADAPTER_VERSION);
}
