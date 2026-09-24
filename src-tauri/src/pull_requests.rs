//! Pull requests linked to workstreams.
//!
//! The relationship is many-to-many on purpose: one workstream often carries
//! several PRs (a stacked change, or a fix plus its revert), and one PR is
//! frequently relevant to several workstreams (the branch that produced it, and
//! the workstream reviewing it).
//!
//! Only the *link* lives here. Nothing in this module talks to Azure DevOps —
//! the URL is parsed so the link can be displayed and deduplicated, not so it
//! can be fetched.

use serde::{Deserialize, Serialize};

/// A pull request URL broken into its parts.
///
/// Parsed at write time rather than display time so a typo is rejected when the
/// agent can still fix it, and so a list can show `repo#1234` instead of a
/// ninety-character URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestRef {
    pub organization: String,
    pub project: String,
    pub repository: String,
    pub number: u64,
    /// The URL as given, so a link always round-trips to what the user opened.
    pub url: String,
}

impl PullRequestRef {
    /// Short human label: `repo#1234`.
    pub fn label(&self) -> String {
        format!("{}#{}", self.repository, self.number)
    }

    /// Identity for deduplication.
    ///
    /// Derived from the parsed parts rather than the raw URL, so the two Azure
    /// DevOps host shapes and any query string or casing difference all collapse
    /// to one link instead of silently creating a second.
    pub fn identity(&self) -> String {
        format!(
            "{}/{}/{}#{}",
            self.organization.to_lowercase(),
            self.project.to_lowercase(),
            self.repository.to_lowercase(),
            self.number
        )
    }
}

/// Parses an Azure DevOps pull request URL.
///
/// Accepts both host shapes Azure DevOps still serves:
///
/// ```text
/// https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>
/// https://<org>.visualstudio.com/<project>/_git/<repo>/pullrequest/<id>
/// ```
///
/// Percent-encoded segments are decoded, because project names containing
/// spaces are ordinary and arrive as `My%20Project`.
pub fn parse_pull_request_url(url: &str) -> Result<PullRequestRef, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("The pull request URL is empty".to_string());
    }
    let (scheme, rest) = trimmed
        .split_once("://")
        .ok_or_else(|| format!("Not a URL: {trimmed}"))?;
    if !matches!(scheme, "http" | "https") {
        return Err(format!("Unsupported URL scheme: {scheme}"));
    }
    // Drop any query or fragment before splitting: ADO appends `?_a=overview`
    // when you copy from the browser, and it is not part of the identity.
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let (host, path) = rest
        .split_once('/')
        .ok_or_else(|| format!("The URL has no path: {trimmed}"))?;

    let segments: Vec<String> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(percent_decode)
        .collect();

    let git_at = segments
        .iter()
        .position(|segment| segment == "_git")
        .ok_or_else(|| {
            format!("Not an Azure DevOps pull request URL (no `_git` segment): {trimmed}")
        })?;
    if git_at == 0 {
        return Err(format!("The URL has no project before `_git`: {trimmed}"));
    }
    let repository = segments
        .get(git_at + 1)
        .filter(|segment| !segment.is_empty())
        .ok_or_else(|| format!("The URL has no repository after `_git`: {trimmed}"))?
        .clone();
    let project = segments[git_at - 1].clone();

    // `pullrequest` and `pullRequest` are both in the wild.
    let number_at = segments
        .iter()
        .position(|segment| segment.eq_ignore_ascii_case("pullrequest"))
        .ok_or_else(|| format!("The URL is not a pull request: {trimmed}"))?;
    let number: u64 = segments
        .get(number_at + 1)
        .ok_or_else(|| format!("The pull request URL has no id: {trimmed}"))?
        .parse()
        .map_err(|_| format!("The pull request id is not a number: {trimmed}"))?;

    // `dev.azure.com/<org>/…` carries the organisation in the path; the legacy
    // `<org>.visualstudio.com` shape carries it in the host.
    let organization = if git_at >= 2 {
        segments[..git_at - 1].join("/")
    } else {
        host.split('.')
            .next()
            .filter(|org| !org.is_empty())
            .ok_or_else(|| format!("Could not determine the organisation from: {trimmed}"))?
            .to_string()
    };

    Ok(PullRequestRef {
        organization,
        project,
        repository,
        number,
        url: trimmed.to_string(),
    })
}

/// Decodes `%XX` escapes. Hand-rolled to avoid a dependency for one function.
pub(crate) fn percent_decode(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_modern_dev_azure_shape() {
        let parsed = parse_pull_request_url(
            "https://dev.azure.com/1esgitops/agency/_git/agency/pullrequest/25563",
        )
        .expect("parse");
        assert_eq!(parsed.organization, "1esgitops");
        assert_eq!(parsed.project, "agency");
        assert_eq!(parsed.repository, "agency");
        assert_eq!(parsed.number, 25563);
        assert_eq!(parsed.label(), "agency#25563");
    }

    #[test]
    fn parses_the_legacy_visualstudio_shape() {
        let parsed = parse_pull_request_url(
            "https://skype.visualstudio.com/SCC/_git/media_components/pullrequest/812",
        )
        .expect("parse");
        // The organisation lives in the host for this shape, not the path.
        assert_eq!(parsed.organization, "skype");
        assert_eq!(parsed.project, "SCC");
        assert_eq!(parsed.repository, "media_components");
        assert_eq!(parsed.number, 812);
    }

    /// Project names with spaces are ordinary and arrive percent-encoded.
    #[test]
    fn decodes_percent_encoded_segments() {
        let parsed = parse_pull_request_url(
            "https://dev.azure.com/org/My%20Project/_git/my%20repo/pullrequest/7",
        )
        .expect("parse");
        assert_eq!(parsed.project, "My Project");
        assert_eq!(parsed.repository, "my repo");
    }

    #[test]
    fn accepts_the_camel_case_spelling_azure_also_serves() {
        let parsed =
            parse_pull_request_url("https://dev.azure.com/org/proj/_git/repo/pullRequest/12")
                .expect("parse");
        assert_eq!(parsed.number, 12);
    }

    /// Copying from the browser appends a query string; it is not identity.
    #[test]
    fn ignores_a_query_string_or_fragment() {
        let with_query = parse_pull_request_url(
            "https://dev.azure.com/org/proj/_git/repo/pullrequest/9?_a=overview",
        )
        .expect("parse");
        assert_eq!(with_query.number, 9);
        let plain =
            parse_pull_request_url("https://dev.azure.com/org/proj/_git/repo/pullrequest/9")
                .expect("parse");
        assert_eq!(with_query.identity(), plain.identity());
    }

    /// Identity ignores case and host shape, so the same PR pasted two ways
    /// links once rather than twice.
    #[test]
    fn identity_collapses_casing_differences() {
        let lower =
            parse_pull_request_url("https://dev.azure.com/org/proj/_git/repo/pullrequest/5")
                .expect("parse");
        let upper =
            parse_pull_request_url("https://dev.azure.com/Org/Proj/_git/Repo/pullrequest/5")
                .expect("parse");
        assert_eq!(lower.identity(), upper.identity());
        // The stored URL still round-trips to exactly what was given.
        assert_ne!(lower.url, upper.url);
    }

    #[test]
    fn rejects_urls_that_are_not_pull_requests() {
        for bad in [
            "",
            "not a url",
            "ftp://dev.azure.com/org/proj/_git/repo/pullrequest/1",
            "https://dev.azure.com/org/proj/_git/repo",
            "https://dev.azure.com/org/proj/pullrequest/1",
            "https://dev.azure.com/_git/repo/pullrequest/1",
            "https://dev.azure.com/org/proj/_git/repo/pullrequest/not-a-number",
            "https://github.com/owner/repo/pull/1",
        ] {
            assert!(
                parse_pull_request_url(bad).is_err(),
                "should have rejected: {bad:?}"
            );
        }
    }

    /// The error names the problem, because an agent reads it to repair the call.
    #[test]
    fn errors_explain_what_was_wrong() {
        let error =
            parse_pull_request_url("https://github.com/owner/repo/pull/1").expect_err("not ADO");
        assert!(error.contains("_git"), "unhelpful error: {error}");
    }
}
