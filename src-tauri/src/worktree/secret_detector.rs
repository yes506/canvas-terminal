// Worktree subsystem — secret detector (Phase 5 D17, spec §4.3)
//
// Per spec §4.3 the dirty-preservation classifier MUST treat any file
// matching the explicit secret patterns below as **category 4** —
// preservation refused, lease enters `PreserveFailed` so the human can
// resolve before any artifact is written. The previous best-effort
// substring detector (`AKIA` + GitHub prefixes) was honestly documented
// as such; this module replaces it with the spec patterns. False
// negatives are still possible but the explicit shapes catch the
// industry-standard token formats.
//
// Patterns (per spec §4.3):
//   - AWS access key id:    AKIA[0-9A-Z]{16}
//   - AWS secret access:    [A-Za-z0-9/+=]{40} adjacent to "aws_secret"
//                           or "AWS_SECRET" context
//   - GitHub PAT family:    gh[poshur]_[A-Za-z0-9]{36}
//   - Slack tokens:         xox[abprs]-[0-9A-Za-z-]{10,}
//   - PEM private keys:     -----BEGIN [A-Z ]*PRIVATE KEY-----
//   - Generic bearer:       Bearer\s+[A-Za-z0-9._-]{20,}
//
// **Honest scope**: this remains a heuristic. Files in unfamiliar
// formats, encrypted content, custom token shapes, or rotated/scrubbed
// keys can still slip through. Production teams should layer a
// dedicated scanner (truffleHog, gitleaks) alongside this gate.

use regex::Regex;
use std::sync::OnceLock;

struct DetectorPatterns {
    aws_access_key: Regex,
    aws_secret_pair: Regex,
    github_pat: Regex,
    slack_token: Regex,
    pem_private_key: Regex,
    bearer_token: Regex,
    /// F11 — JWT three-part header.payload.signature shape
    /// (`eyJ...` base64-url) per spec §4.3. Catches bare JWTs even
    /// when not preceded by "Bearer ".
    jwt: Regex,
}

fn patterns() -> &'static DetectorPatterns {
    static P: OnceLock<DetectorPatterns> = OnceLock::new();
    P.get_or_init(|| DetectorPatterns {
        aws_access_key: Regex::new(r"AKIA[0-9A-Z]{16}").expect("aws_access_key regex"),
        // AWS secret keys are 40 chars of base64; we look for the
        // contextual pair to reduce false positives.
        aws_secret_pair: Regex::new(
            r#"(?i)aws[_-]?secret[_-]?(access[_-]?)?key["'\s:=]{1,8}[A-Za-z0-9/+=]{40}"#,
        )
        .expect("aws_secret_pair regex"),
        github_pat: Regex::new(r"gh[poshur]_[A-Za-z0-9]{36}").expect("github_pat regex"),
        slack_token: Regex::new(r"xox[abprs]-[0-9A-Za-z-]{10,}").expect("slack_token regex"),
        pem_private_key: Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")
            .expect("pem_private_key regex"),
        // Bearer tokens — many false positives in test fixtures, so
        // require >= 30 chars to filter out short demo strings.
        bearer_token: Regex::new(r"(?i)Bearer\s+[A-Za-z0-9._-]{30,}")
            .expect("bearer_token regex"),
        // JWT shape: eyJ<base64>.eyJ<base64>.<base64>. The first two
        // segments are header + payload (always start with `eyJ` =
        // `{"` base64-encoded). Each segment >= 10 chars to avoid
        // matching truncated test fixtures.
        jwt: Regex::new(
            r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
        )
        .expect("jwt regex"),
    })
}

/// Returns true if `content` matches any spec §4.3 secret pattern.
/// Used by the drainer's `classify_work` to flag category-4 files.
pub fn looks_like_secret(content: &str) -> bool {
    let p = patterns();
    p.aws_access_key.is_match(content)
        || p.aws_secret_pair.is_match(content)
        || p.github_pat.is_match(content)
        || p.slack_token.is_match(content)
        || p.pem_private_key.is_match(content)
        || p.bearer_token.is_match(content)
        || p.jwt.is_match(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_aws_access_key_id() {
        assert!(looks_like_secret("AKIAIOSFODNN7EXAMPLE"));
        assert!(looks_like_secret(
            "config:\n  key = AKIAIOSFODNN7EXAMPLE\n"
        ));
        // Wrong shape (lowercase, too short) — should NOT match
        assert!(!looks_like_secret("AKIAabc"));
        assert!(!looks_like_secret("akia0123456789012345"));
    }

    #[test]
    fn detects_aws_secret_pair() {
        assert!(looks_like_secret(
            "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
        ));
        assert!(looks_like_secret(
            r#"AWS_SECRET_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY""#
        ));
        // 40-char base64 alone (no context) — should NOT match
        assert!(!looks_like_secret(
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
        ));
    }

    #[test]
    fn detects_github_pat_family() {
        assert!(looks_like_secret(
            "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
        assert!(looks_like_secret(
            "gho_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        ));
        assert!(looks_like_secret(
            "ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        ));
        // Too short (< 36 chars) — should NOT match
        assert!(!looks_like_secret("ghp_short"));
    }

    #[test]
    fn detects_slack_tokens() {
        // Synthetic placeholders shaped to match the regex but
        // obviously not real tokens (avoids GitHub secret-scanning
        // false-positive on commit).
        assert!(looks_like_secret(
            "xoxb-PLACEHOLDER-EXAMPLE-NOT-A-REAL-TOKEN"
        ));
        assert!(looks_like_secret(
            "xoxp-EXAMPLE-FAKE-PLACEHOLDER-VALUE"
        ));
        // Wrong family letter — should NOT match
        assert!(!looks_like_secret("xoxz-EXAMPLE-FAKE-VALUE"));
    }

    #[test]
    fn detects_pem_private_keys() {
        assert!(looks_like_secret(
            "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"
        ));
        assert!(looks_like_secret(
            "-----BEGIN OPENSSH PRIVATE KEY-----"
        ));
        assert!(looks_like_secret("-----BEGIN PRIVATE KEY-----"));
        // Public key — should NOT match
        assert!(!looks_like_secret(
            "-----BEGIN PUBLIC KEY-----\nMIIB..."
        ));
    }

    #[test]
    fn detects_long_bearer_tokens() {
        assert!(looks_like_secret(
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE2MDAwMDAwMDB9.signature_here"
        ));
        // Too short — should NOT match
        assert!(!looks_like_secret("Bearer abc123"));
    }

    #[test]
    fn detects_bare_jwt() {
        // F11 — JWT pattern catches bare three-segment tokens not
        // preceded by "Bearer ".
        assert!(looks_like_secret(
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIiwiaWF0IjoxNjAwMDAwMDAwfQ.signature_more_than_ten_chars"
        ));
        // Too short payload — should NOT match
        assert!(!looks_like_secret("eyJabc.eyJxyz.sig"));
    }

    #[test]
    fn ignores_clean_source_code() {
        assert!(!looks_like_secret(
            "fn main() {\n    println!(\"hello, world\");\n}\n"
        ));
        assert!(!looks_like_secret(
            "// AKIA is a prefix, but this comment alone shouldn't match\n"
        ));
        assert!(!looks_like_secret(""));
    }
}
