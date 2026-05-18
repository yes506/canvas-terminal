// Shared low-level filesystem-safety primitives.
//
// Per planner deltas M7 + U3: both `commands/memory.rs` (existing relative-path
// gate) and `commands/transcripts/fs_gate.rs` (new absolute-root gate) consume
// these primitives so the two hardening surfaces cannot drift.

use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum FsSafetyError {
    Symlink(PathBuf),
    Canonicalize(std::io::Error),
    EscapedRoot { root: PathBuf, resolved: PathBuf },
}

pub fn canonicalize_no_symlinks(path: &Path) -> Result<PathBuf, FsSafetyError> {
    if !path.is_absolute() {
        return Err(FsSafetyError::Canonicalize(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "canonicalize_no_symlinks requires an absolute path",
        )));
    }
    let canonical = std::fs::canonicalize(path).map_err(FsSafetyError::Canonicalize)?;
    reject_symlink_in_walk(&canonical)?;
    Ok(canonical)
}

pub fn add_private_alias(path: &Path) -> Vec<PathBuf> {
    let mut out = vec![path.to_path_buf()];
    if cfg!(target_os = "macos") {
        let s = path.to_string_lossy();
        for prefix in ["/etc", "/tmp", "/var"] {
            if s == prefix || s.starts_with(&format!("{prefix}/")) {
                let mut p = PathBuf::from("/private");
                p.push(s.trim_start_matches('/'));
                out.push(p);
                break;
            }
        }
    }
    out
}

pub fn reject_symlink_in_walk(path: &Path) -> Result<(), FsSafetyError> {
    if !path.is_absolute() {
        return Err(FsSafetyError::Canonicalize(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "reject_symlink_in_walk requires an absolute path",
        )));
    }
    let mut accum = PathBuf::from("/");
    for component in path.components() {
        match component {
            std::path::Component::RootDir | std::path::Component::Prefix(_) => continue,
            std::path::Component::CurDir | std::path::Component::ParentDir => {
                return Err(FsSafetyError::Symlink(accum));
            }
            std::path::Component::Normal(name) => {
                accum.push(name);
                match std::fs::symlink_metadata(&accum) {
                    Ok(md) if md.file_type().is_symlink() => {
                        return Err(FsSafetyError::Symlink(accum));
                    }
                    Ok(_) => {}
                    Err(e) => return Err(FsSafetyError::Canonicalize(e)),
                }
            }
        }
    }
    Ok(())
}
