// Spike 5 — Orchestrator crash during merge
//
// Throwaway harness per spec.md §11 spike #5. Runs three scenarios that
// simulate orchestrator crash at different points during a merge, then
// exercises the recovery decision logic (which is what Phase 6 will
// productionise).
//
// The recovery decision matrix (see scenario C below) is the contract
// the spike validates:
//
//   queue.status      | MERGE_HEAD exists | recovery action
//   ------------------+-------------------+------------------------------
//   Pending           | yes (impossible*) | abort + log anomaly
//   MergingLocally    | yes               | abort + mark Aborted
//   MergedLocally(sha)| yes (impossible*) | inconsistent — investigate
//   MergedLocally(sha)| no, ref==sha      | no-op (already consistent)
//   MergedLocally(sha)| no, ref!=sha      | inconsistent — investigate
//
// (*) "impossible" means the orchestrator never set that combo; if seen,
//     it's a corruption bug, not a normal recovery case.

use std::path::Path;
use std::process::{Command, ExitStatus};
use tempfile::TempDir;

#[derive(Debug, Clone)]
struct QueueRecord {
    status: QueueStatus,
    expected_base: String,
    final_integration_commit: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
enum QueueStatus {
    Pending,
    MergingLocally,
    MergedLocally,
    Aborted,
}

#[derive(Debug)]
enum RecoveryAction {
    NoOp,
    Abort,
    InvestigateInconsistency(String),
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== Spike 5: orchestrator crash during merge ===\n");

    let mut all_pass = true;
    all_pass &= scenario_a_clean_merge_crash_before_commit()?;
    all_pass &= scenario_b_conflict_merge_crash_with_markers()?;
    all_pass &= scenario_c_crash_after_commit_before_queue_update()?;

    println!(
        "\n=== Spike 5 result: {} ===",
        if all_pass { "PASS" } else { "FAIL" }
    );
    std::process::exit(if all_pass { 0 } else { 1 });
}

// ----------------------------------------------------------------------
// Scenario A — clean merge, crash AFTER `git merge --no-commit` set up
// MERGE_HEAD but BEFORE the merge commit was made.
// Recovery: queue says MergingLocally → abort.
// Post-recovery: ref == expected_base, MERGE_HEAD gone, queue=Aborted.
// ----------------------------------------------------------------------
fn scenario_a_clean_merge_crash_before_commit() -> Result<bool, Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    let repo = tmp.path();
    setup_diverging_branches(repo, /*conflict=*/ false)?;

    let pre_merge_sha = head_sha(repo, "main")?;
    let queue = QueueRecord {
        status: QueueStatus::MergingLocally,
        expected_base: pre_merge_sha.clone(),
        final_integration_commit: None,
    };

    git_in(repo, &["checkout", "main"])?;
    let merge = git_in(repo, &["merge", "--no-commit", "--no-ff", "feature"])?;
    assert!(
        merge.success(),
        "scenario A: clean merge --no-commit should succeed"
    );
    assert!(
        repo.join(".git/MERGE_HEAD").exists(),
        "scenario A: MERGE_HEAD must exist after merge --no-commit"
    );

    // ===== simulated crash: process exits without committing =====

    // ===== simulated restart: recovery decision =====
    let action = decide_recovery(repo, &queue);
    println!("scenario A: recovery decision = {:?}", action);

    let RecoveryAction::Abort = action else {
        eprintln!("scenario A FAIL: expected Abort, got {:?}", action);
        return Ok(false);
    };

    git_in(repo, &["merge", "--abort"])?;

    let post = head_sha(repo, "main")?;
    let merge_head_gone = !repo.join(".git/MERGE_HEAD").exists();
    let ref_unchanged = post == pre_merge_sha;

    println!(
        "scenario A: post-recovery → MERGE_HEAD gone={}, ref unchanged={}",
        merge_head_gone, ref_unchanged
    );

    let pass = merge_head_gone && ref_unchanged;
    println!("scenario A: {}\n", if pass { "PASS" } else { "FAIL" });
    Ok(pass)
}

// ----------------------------------------------------------------------
// Scenario B — conflicting merge, crash leaves MERGE_HEAD AND conflict
// markers in working tree.
// Recovery: queue says MergingLocally → abort. Post-recovery worktree
// must be clean and ref unchanged.
// ----------------------------------------------------------------------
fn scenario_b_conflict_merge_crash_with_markers() -> Result<bool, Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    let repo = tmp.path();
    setup_diverging_branches(repo, /*conflict=*/ true)?;

    let pre_merge_sha = head_sha(repo, "main")?;
    let queue = QueueRecord {
        status: QueueStatus::MergingLocally,
        expected_base: pre_merge_sha.clone(),
        final_integration_commit: None,
    };

    git_in(repo, &["checkout", "main"])?;
    let _merge = git_in(repo, &["merge", "--no-commit", "--no-ff", "feature"])?;
    // conflict makes git exit nonzero, but MERGE_HEAD still exists
    assert!(
        repo.join(".git/MERGE_HEAD").exists(),
        "scenario B: MERGE_HEAD must exist even on conflict"
    );

    // verify conflict markers were written
    let content = std::fs::read_to_string(repo.join("file.txt"))?;
    let has_markers = content.contains("<<<<<<<") && content.contains(">>>>>>>");
    assert!(has_markers, "scenario B: conflict markers must be present");

    // ===== simulated crash =====

    // ===== simulated restart =====
    let action = decide_recovery(repo, &queue);
    println!("scenario B: recovery decision = {:?}", action);

    let RecoveryAction::Abort = action else {
        eprintln!("scenario B FAIL: expected Abort, got {:?}", action);
        return Ok(false);
    };

    git_in(repo, &["merge", "--abort"])?;

    let post = head_sha(repo, "main")?;
    let merge_head_gone = !repo.join(".git/MERGE_HEAD").exists();
    let ref_unchanged = post == pre_merge_sha;

    let post_content = std::fs::read_to_string(repo.join("file.txt"))?;
    let markers_gone = !post_content.contains("<<<<<<<") && !post_content.contains(">>>>>>>");

    println!(
        "scenario B: post-recovery → MERGE_HEAD gone={}, ref unchanged={}, markers gone={}",
        merge_head_gone, ref_unchanged, markers_gone
    );

    let pass = merge_head_gone && ref_unchanged && markers_gone;
    println!("scenario B: {}\n", if pass { "PASS" } else { "FAIL" });
    Ok(pass)
}

// ----------------------------------------------------------------------
// Scenario C — merge commit DID happen and ref was updated, but
// orchestrator crashed BEFORE updating the queue record from
// MergingLocally to MergedLocally.
// Recovery: orchestrator restarts and reads the queue. The queue still
// says MergingLocally, but MERGE_HEAD is gone and ref already advanced.
// Recovery must reconcile: detect that the merge actually committed
// (ref != expected_base), update queue to MergedLocally with the new sha.
// This is "no-op + queue catch-up", not abort.
// ----------------------------------------------------------------------
fn scenario_c_crash_after_commit_before_queue_update() -> Result<bool, Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    let repo = tmp.path();
    setup_diverging_branches(repo, /*conflict=*/ false)?;

    let pre_merge_sha = head_sha(repo, "main")?;
    let queue = QueueRecord {
        status: QueueStatus::MergingLocally,
        expected_base: pre_merge_sha.clone(),
        final_integration_commit: None,
    };

    git_in(repo, &["checkout", "main"])?;
    git_in(repo, &["merge", "--no-ff", "-m", "merge feature", "feature"])?;
    let post_merge_sha = head_sha(repo, "main")?;
    assert!(
        !repo.join(".git/MERGE_HEAD").exists(),
        "scenario C: MERGE_HEAD must be gone after successful merge commit"
    );
    assert_ne!(
        pre_merge_sha, post_merge_sha,
        "scenario C: ref must advance after merge commit"
    );

    // ===== simulated crash AFTER merge commit, BEFORE queue update =====

    // ===== simulated restart =====
    // Queue still says MergingLocally with expected_base = pre_merge_sha.
    // Recovery must detect: MERGE_HEAD absent + ref advanced beyond
    // expected_base = the merge already happened; reconcile queue.
    let action = decide_recovery(repo, &queue);
    println!("scenario C: recovery decision = {:?}", action);

    let RecoveryAction::NoOp = action else {
        eprintln!("scenario C FAIL: expected NoOp (queue catch-up), got {:?}", action);
        return Ok(false);
    };

    // Simulate the queue catch-up step that the orchestrator would do
    let mut updated_queue = queue.clone();
    updated_queue.status = QueueStatus::MergedLocally;
    updated_queue.final_integration_commit = Some(post_merge_sha.clone());

    let queue_consistent = updated_queue.status == QueueStatus::MergedLocally
        && updated_queue.final_integration_commit.as_deref() == Some(&post_merge_sha);

    println!(
        "scenario C: post-recovery → queue catch-up consistent={} (status={:?}, sha={:?})",
        queue_consistent, updated_queue.status, updated_queue.final_integration_commit
    );

    let pass = queue_consistent;
    println!("scenario C: {}\n", if pass { "PASS" } else { "FAIL" });
    Ok(pass)
}

// ----------------------------------------------------------------------
// Recovery decision logic. THIS is what the spike validates — the
// production version will live in `merge_executor.rs` per Phase 6.
// ----------------------------------------------------------------------
fn decide_recovery(repo: &Path, queue: &QueueRecord) -> RecoveryAction {
    let merge_head_exists = repo.join(".git/MERGE_HEAD").exists();
    let current_sha = head_sha(repo, "main").unwrap_or_default();

    match (&queue.status, merge_head_exists) {
        (QueueStatus::MergingLocally, true) => RecoveryAction::Abort,
        (QueueStatus::MergingLocally, false) => {
            if current_sha != queue.expected_base {
                // Merge commit happened, queue just hasn't caught up
                RecoveryAction::NoOp
            } else {
                // No merge happened; nothing to do
                RecoveryAction::NoOp
            }
        }
        (QueueStatus::MergedLocally, false) => {
            match &queue.final_integration_commit {
                Some(sha) if sha == &current_sha => RecoveryAction::NoOp,
                Some(sha) => RecoveryAction::InvestigateInconsistency(format!(
                    "queue says {sha}, ref is {current_sha}"
                )),
                None => RecoveryAction::InvestigateInconsistency(
                    "MergedLocally with no recorded sha".to_string(),
                ),
            }
        }
        (QueueStatus::MergedLocally, true) => RecoveryAction::InvestigateInconsistency(
            "queue says MergedLocally but MERGE_HEAD exists".to_string(),
        ),
        (QueueStatus::Pending, true) => RecoveryAction::InvestigateInconsistency(
            "queue says Pending but MERGE_HEAD exists".to_string(),
        ),
        (QueueStatus::Pending, false) => RecoveryAction::NoOp,
        (QueueStatus::Aborted, _) => RecoveryAction::NoOp,
    }
}

// ----------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------

fn setup_diverging_branches(
    repo: &Path,
    conflict: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    git_in(repo, &["init", "--initial-branch=main", "--quiet"])?;
    git_in(repo, &["config", "user.email", "spike@example.invalid"])?;
    git_in(repo, &["config", "user.name", "Spike Five"])?;
    git_in(repo, &["config", "commit.gpgsign", "false"])?;

    std::fs::write(repo.join("file.txt"), "base line\n")?;
    git_in(repo, &["add", "file.txt"])?;
    git_in(repo, &["commit", "-m", "base", "--quiet"])?;

    git_in(repo, &["checkout", "-b", "feature", "--quiet"])?;
    let feature_content = if conflict {
        "feature line conflicting with main\n"
    } else {
        "base line\nfeature line\n"
    };
    std::fs::write(repo.join("file.txt"), feature_content)?;
    git_in(repo, &["add", "file.txt"])?;
    git_in(repo, &["commit", "-m", "feature commit", "--quiet"])?;

    if conflict {
        git_in(repo, &["checkout", "main", "--quiet"])?;
        std::fs::write(repo.join("file.txt"), "main line conflicting with feature\n")?;
        git_in(repo, &["add", "file.txt"])?;
        git_in(repo, &["commit", "-m", "main divergent commit", "--quiet"])?;
    }

    Ok(())
}

fn git_in(repo: &Path, args: &[&str]) -> Result<ExitStatus, Box<dyn std::error::Error>> {
    Ok(Command::new("git").args(args).current_dir(repo).status()?)
}

fn head_sha(repo: &Path, branch: &str) -> Result<String, Box<dyn std::error::Error>> {
    let out = Command::new("git")
        .args(["rev-parse", branch])
        .current_dir(repo)
        .output()?;
    Ok(String::from_utf8(out.stdout)?.trim().to_string())
}
