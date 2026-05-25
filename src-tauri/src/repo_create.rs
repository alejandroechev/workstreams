//! Repo creation: scaffold + git init + optional GitHub remote.
//!
//! Separated from `lib.rs` so it can be unit-tested with an in-memory
//! `RemoteRepoProvider` (per AGENTS.md "in-memory stubs for external
//! integrations").

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(test)]
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRepoResult {
    pub directory: String,
    pub git_remote: Option<String>,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRepoOptions {
    pub parent: String,
    pub name: String,
    pub default_branch: String,
    pub create_readme: bool,
    pub create_gitignore: bool,
    pub initial_commit: bool,
    pub create_github_remote: bool,
    pub github_owner: Option<String>,
    pub github_visibility: Option<String>, // "public" | "private"
}

/// External "create remote repo" boundary. Replaced with an in-memory
/// stub in tests.
pub trait RemoteRepoProvider: Send + Sync {
    /// Create the remote repository and return its clone URL.
    fn create_repo(
        &self,
        owner: &str,
        name: &str,
        visibility: &str,
        local_dir: &Path,
    ) -> Result<String, String>;
}

/// Production impl: shells out to the `gh` CLI.
pub struct GhCliRemoteProvider;

impl RemoteRepoProvider for GhCliRemoteProvider {
    fn create_repo(
        &self,
        owner: &str,
        name: &str,
        visibility: &str,
        local_dir: &Path,
    ) -> Result<String, String> {
        // Verify auth first; surface a clear error instead of a generic gh failure.
        let status = Command::new("gh")
            .args(["auth", "status"])
            .output()
            .map_err(|e| format!("gh CLI not available: {e}"))?;
        if !status.status.success() {
            return Err(format!(
                "gh is not authenticated. Run `gh auth login` first.\n{}",
                String::from_utf8_lossy(&status.stderr)
            ));
        }

        let vis_flag = match visibility {
            "public" => "--public",
            _ => "--private",
        };
        let repo_arg = format!("{owner}/{name}");
        let out = Command::new("gh")
            .current_dir(local_dir)
            .args([
                "repo", "create", &repo_arg, vis_flag, "--source", ".", "--push",
            ])
            .output()
            .map_err(|e| format!("failed to invoke gh: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "gh repo create failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }

        // Read the resulting origin URL from local config (most reliable).
        let url_out = Command::new("git")
            .current_dir(local_dir)
            .args(["remote", "get-url", "origin"])
            .output()
            .map_err(|e| format!("git remote get-url failed: {e}"))?;
        if !url_out.status.success() {
            return Err("gh succeeded but origin remote is missing".to_string());
        }
        Ok(String::from_utf8_lossy(&url_out.stdout).trim().to_string())
    }
}

/// In-memory stub for tests/offline dev. Records calls and returns a
/// deterministic URL without touching the network.
#[cfg(test)]
pub type InMemoryRemoteCalls = std::sync::Mutex<Vec<(String, String, String, PathBuf)>>;

#[cfg(test)]
pub struct InMemoryRemoteProvider {
    pub calls: Arc<InMemoryRemoteCalls>,
}

#[cfg(test)]
impl InMemoryRemoteProvider {
    pub fn new() -> Self {
        Self {
            calls: Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }
}

#[cfg(test)]
impl RemoteRepoProvider for InMemoryRemoteProvider {
    fn create_repo(
        &self,
        owner: &str,
        name: &str,
        visibility: &str,
        local_dir: &Path,
    ) -> Result<String, String> {
        self.calls.lock().unwrap().push((
            owner.to_string(),
            name.to_string(),
            visibility.to_string(),
            local_dir.to_path_buf(),
        ));
        Ok(format!("https://github.com/{owner}/{name}.git"))
    }
}

const DEFAULT_GITIGNORE: &str = "# Node\nnode_modules/\nnpm-debug.log*\n.pnpm-debug.log*\ndist/\nbuild/\n\n# Rust\ntarget/\nCargo.lock.bak\n\n# OS\n.DS_Store\nThumbs.db\n\n# Editor\n.vscode/\n.idea/\n*.swp\n*.swo\n\n# Env\n.env\n.env.local\n";

/// Validate the repo name (folder-name-safe, no path tricks).
pub fn validate_repo_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Repo name cannot be empty".into());
    }
    if trimmed.starts_with('.') {
        return Err("Repo name cannot start with '.'".into());
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed.contains('*')
        || trimmed.contains('?')
        || trimmed.contains('"')
        || trimmed.contains('<')
        || trimmed.contains('>')
        || trimmed.contains('|')
    {
        return Err("Repo name contains invalid characters".into());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("Invalid repo name".into());
    }
    Ok(())
}

fn git_has_identity() -> bool {
    let email = Command::new("git")
        .args(["config", "--global", "user.email"])
        .output()
        .ok()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false);
    let name = Command::new("git")
        .args(["config", "--global", "user.name"])
        .output()
        .ok()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false);
    email && name
}

/// Core create-repo logic. Tests inject the provider; the tauri command
/// uses `GhCliRemoteProvider`.
pub fn create_git_repo_with(
    opts: &CreateRepoOptions,
    provider: &dyn RemoteRepoProvider,
) -> Result<CreateRepoResult, String> {
    validate_repo_name(&opts.name)?;

    let parent = PathBuf::from(&opts.parent);
    if !parent.exists() {
        return Err(format!("Parent directory does not exist: {}", opts.parent));
    }
    let target = parent.join(opts.name.trim());
    if target.exists() {
        return Err(format!(
            "Target directory already exists: {}",
            target.display()
        ));
    }
    std::fs::create_dir_all(&target).map_err(|e| format!("create_dir_all failed: {e}"))?;

    if opts.create_readme {
        let body = format!("# {}\n", opts.name.trim());
        std::fs::write(target.join("README.md"), body)
            .map_err(|e| format!("write README.md failed: {e}"))?;
    }
    if opts.create_gitignore {
        std::fs::write(target.join(".gitignore"), DEFAULT_GITIGNORE)
            .map_err(|e| format!("write .gitignore failed: {e}"))?;
    }

    let branch = if opts.default_branch.trim().is_empty() {
        "master".to_string()
    } else {
        opts.default_branch.trim().to_string()
    };

    // git init -b <branch>, falling back to init + symbolic-ref for old git.
    let init_with_b = Command::new("git")
        .current_dir(&target)
        .args(["init", "-b", &branch])
        .output();
    let init_ok = matches!(&init_with_b, Ok(o) if o.status.success());
    if !init_ok {
        let init = Command::new("git")
            .current_dir(&target)
            .args(["init"])
            .output()
            .map_err(|e| format!("git init failed: {e}"))?;
        if !init.status.success() {
            return Err(format!(
                "git init failed: {}",
                String::from_utf8_lossy(&init.stderr)
            ));
        }
        let sref = Command::new("git")
            .current_dir(&target)
            .args(["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")])
            .output()
            .map_err(|e| format!("git symbolic-ref failed: {e}"))?;
        if !sref.status.success() {
            return Err(format!(
                "git symbolic-ref failed: {}",
                String::from_utf8_lossy(&sref.stderr)
            ));
        }
    }

    if opts.initial_commit {
        let add = Command::new("git")
            .current_dir(&target)
            .args(["add", "-A"])
            .output()
            .map_err(|e| format!("git add failed: {e}"))?;
        if !add.status.success() {
            return Err(format!(
                "git add failed: {}",
                String::from_utf8_lossy(&add.stderr)
            ));
        }
        let mut commit_cmd = Command::new("git");
        commit_cmd.current_dir(&target);
        if !git_has_identity() {
            commit_cmd.args([
                "-c",
                "user.email=workstreams@local",
                "-c",
                "user.name=Workstreams",
            ]);
        }
        commit_cmd.args(["commit", "--allow-empty", "-m", "Initial commit"]);
        let commit = commit_cmd
            .output()
            .map_err(|e| format!("git commit failed: {e}"))?;
        if !commit.status.success() {
            return Err(format!(
                "git commit failed: {}",
                String::from_utf8_lossy(&commit.stderr)
            ));
        }
    }

    let mut remote_url: Option<String> = None;
    if opts.create_github_remote {
        let owner = opts
            .github_owner
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "GitHub owner is required when creating a remote".to_string())?;
        let visibility = opts.github_visibility.as_deref().unwrap_or("private");
        let url = provider.create_repo(owner, opts.name.trim(), visibility, &target)?;
        remote_url = Some(url);
    }

    Ok(CreateRepoResult {
        directory: target.to_string_lossy().to_string(),
        git_remote: remote_url,
        branch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_parent(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "ws-repo-create-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn base_opts(parent: &Path, name: &str) -> CreateRepoOptions {
        CreateRepoOptions {
            parent: parent.to_string_lossy().to_string(),
            name: name.to_string(),
            default_branch: "master".into(),
            create_readme: true,
            create_gitignore: true,
            initial_commit: true,
            create_github_remote: false,
            github_owner: None,
            github_visibility: None,
        }
    }

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn validates_empty_name() {
        assert!(validate_repo_name("").is_err());
        assert!(validate_repo_name("   ").is_err());
    }

    #[test]
    fn validates_path_separators() {
        assert!(validate_repo_name("a/b").is_err());
        assert!(validate_repo_name("a\\b").is_err());
        assert!(validate_repo_name("..").is_err());
        assert!(validate_repo_name(".hidden").is_err());
    }

    #[test]
    fn validates_good_names() {
        assert!(validate_repo_name("workstreams").is_ok());
        assert!(validate_repo_name("my-repo_2").is_ok());
    }

    #[test]
    fn scaffolds_readme_and_gitignore_and_inits_git() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let parent = temp_parent("scaffold");
        let opts = base_opts(&parent, "my-repo");
        let provider = InMemoryRemoteProvider::new();
        let r = create_git_repo_with(&opts, &provider).expect("create");
        let dir = PathBuf::from(&r.directory);
        assert!(dir.join("README.md").exists());
        assert!(dir.join(".gitignore").exists());
        assert!(dir.join(".git").exists());
        assert_eq!(r.branch, "master");
        assert!(r.git_remote.is_none());
        let readme = std::fs::read_to_string(dir.join("README.md")).unwrap();
        assert!(readme.contains("# my-repo"));
        std::fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn respects_main_branch() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let parent = temp_parent("main-branch");
        let mut opts = base_opts(&parent, "r");
        opts.default_branch = "main".into();
        opts.initial_commit = false;
        opts.create_readme = false;
        opts.create_gitignore = false;
        let provider = InMemoryRemoteProvider::new();
        let r = create_git_repo_with(&opts, &provider).expect("create");
        assert_eq!(r.branch, "main");
        // HEAD should point to refs/heads/main
        let head =
            std::fs::read_to_string(PathBuf::from(&r.directory).join(".git").join("HEAD")).unwrap();
        assert!(head.contains("refs/heads/main"), "HEAD was: {head}");
        std::fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn fails_when_target_already_exists() {
        let parent = temp_parent("exists");
        std::fs::create_dir_all(parent.join("dup")).unwrap();
        let opts = base_opts(&parent, "dup");
        let provider = InMemoryRemoteProvider::new();
        let err = create_git_repo_with(&opts, &provider).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        std::fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn fails_when_parent_missing() {
        let opts = CreateRepoOptions {
            parent: "Z:/definitely/does/not/exist/ws-test".into(),
            name: "x".into(),
            default_branch: "master".into(),
            create_readme: false,
            create_gitignore: false,
            initial_commit: false,
            create_github_remote: false,
            github_owner: None,
            github_visibility: None,
        };
        let provider = InMemoryRemoteProvider::new();
        let err = create_git_repo_with(&opts, &provider).unwrap_err();
        assert!(err.contains("Parent directory"), "got: {err}");
    }

    #[test]
    fn rejects_invalid_name_before_creating_anything() {
        let parent = temp_parent("bad-name");
        let mut opts = base_opts(&parent, "..");
        opts.initial_commit = false;
        let provider = InMemoryRemoteProvider::new();
        let err = create_git_repo_with(&opts, &provider).unwrap_err();
        assert!(
            err.contains("Invalid") || err.contains("invalid") || err.contains("cannot"),
            "got: {err}"
        );
        std::fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn calls_remote_provider_when_requested() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let parent = temp_parent("remote");
        let mut opts = base_opts(&parent, "remote-repo");
        opts.create_github_remote = true;
        opts.github_owner = Some("alejandroechev".into());
        opts.github_visibility = Some("private".into());
        let provider = InMemoryRemoteProvider::new();
        let r = create_git_repo_with(&opts, &provider).expect("create");
        assert_eq!(
            r.git_remote.as_deref(),
            Some("https://github.com/alejandroechev/remote-repo.git")
        );
        let calls = provider.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "alejandroechev");
        assert_eq!(calls[0].1, "remote-repo");
        assert_eq!(calls[0].2, "private");
        std::fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn does_not_call_remote_when_disabled() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let parent = temp_parent("no-remote");
        let opts = base_opts(&parent, "no-remote-repo");
        let provider = InMemoryRemoteProvider::new();
        let r = create_git_repo_with(&opts, &provider).expect("create");
        assert!(r.git_remote.is_none());
        assert!(provider.calls.lock().unwrap().is_empty());
        std::fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn remote_requires_owner() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let parent = temp_parent("no-owner");
        let mut opts = base_opts(&parent, "needs-owner");
        opts.create_github_remote = true;
        opts.github_owner = None;
        let provider = InMemoryRemoteProvider::new();
        let err = create_git_repo_with(&opts, &provider).unwrap_err();
        assert!(err.contains("owner"), "got: {err}");
        std::fs::remove_dir_all(&parent).ok();
    }
}
