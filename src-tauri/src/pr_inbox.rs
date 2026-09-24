use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct AdoRepo {
    organization: String,
    project: String,
    repository: String,
}

impl AdoRepo {
    pub fn parse(remote: &str) -> Result<Self, String> {
        let remote = remote.trim();
        let ssh = remote
            .strip_prefix("git@ssh.dev.azure.com:v3/")
            .or_else(|| remote.strip_prefix("ssh://git@ssh.dev.azure.com/v3/"));
        let parts: Vec<String>;
        if let Some(path) = ssh {
            parts = path
                .split('/')
                .map(crate::pull_requests::percent_decode)
                .collect();
        } else {
            let url =
                reqwest::Url::parse(remote).map_err(|_| "A valid ADO clone URL is required")?;
            if url.scheme() != "https"
                || url.port().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("Use an HTTPS or SSH Azure DevOps clone URL".into());
            }
            let path: Vec<_> = url
                .path()
                .trim_end_matches('/')
                .trim_start_matches('/')
                .split('/')
                .map(crate::pull_requests::percent_decode)
                .collect();
            let host = url.host_str().unwrap_or("");
            parts = if host == "dev.azure.com" && path.len() == 4 && path[2] == "_git" {
                vec![path[0].clone(), path[1].clone(), path[3].clone()]
            } else if let Some(org) = host.strip_suffix(".visualstudio.com") {
                if org.contains('.') || path.len() != 3 || path[1] != "_git" {
                    return Err("Unsupported Azure DevOps clone URL".into());
                }
                vec![org.into(), path[0].clone(), path[2].clone()]
            } else {
                return Err(
                    "PR notifications currently support Azure DevOps repositories only".into(),
                );
            };
        }
        if parts.len() != 3
            || parts.iter().any(|s| {
                s.is_empty()
                    || s == "."
                    || s == ".."
                    || s.contains(['/', '\\'])
                    || s.chars().any(char::is_control)
            })
        {
            return Err("Invalid Azure DevOps organization, project, or repository".into());
        }
        Ok(Self {
            organization: parts[0].clone(),
            project: parts[1].clone(),
            repository: parts[2].clone(),
        })
    }

    pub(super) fn url(&self, segments: &[&str]) -> reqwest::Url {
        let mut url = reqwest::Url::parse("https://dev.azure.com/").expect("constant URL");
        url.path_segments_mut()
            .expect("HTTPS base")
            .pop_if_empty()
            .push(&self.organization)
            .extend(segments.iter().copied());
        url
    }

    pub fn web_url(&self, id: u64) -> String {
        self.url(&[
            &self.project,
            "_git",
            &self.repository,
            "pullrequest",
            &id.to_string(),
        ])
        .to_string()
    }
}

#[derive(Clone, Debug)]
pub struct Target {
    pub project_id: String,
    pub remote: String,
    revision: i64,
}

#[derive(Clone, Debug)]
pub struct ReviewPr {
    pub id: u64,
    pub title: String,
    pub author: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InboxItem {
    pub id: String,
    pub project_id: String,
    pub repo_name: String,
    pub pr_id: u64,
    pub title: String,
    pub author: String,
    pub url: String,
    pub is_read: bool,
    pub discovered_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RepoStatus {
    pub project_id: String,
    pub repo_name: String,
    pub enabled: bool,
    pub last_checked: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InboxSnapshot {
    pub items: Vec<InboxItem>,
    pub repos: Vec<RepoStatus>,
}

pub fn configure(db: &Connection, project_id: &str, enabled: bool) -> Result<(), String> {
    let remote: Option<String> = db
        .query_row(
            "SELECT git_remote FROM projects WHERE id=?1",
            [project_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("Cannot configure repo: {e}"))?;
    if enabled {
        AdoRepo::parse(remote.as_deref().ok_or("Repository has no remote URL")?)?;
    }
    db.execute("INSERT INTO pr_inbox_config(project_id,enabled) VALUES (?1,?2)
        ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled, revision=revision+1, error=NULL",
        params![project_id, enabled]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn targets(db: &Connection) -> Result<Vec<Target>, String> {
    let mut stmt = db
        .prepare(
            "SELECT p.id, COALESCE(p.git_remote,''), c.revision FROM projects p
        JOIN pr_inbox_config c ON c.project_id=p.id WHERE c.enabled=1 ORDER BY p.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Target {
                project_id: r.get(0)?,
                remote: r.get(1)?,
                revision: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn still_current(db: &Connection, target: &Target) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects p JOIN pr_inbox_config c ON c.project_id=p.id
        WHERE p.id=?1 AND c.enabled=1 AND c.revision=?2 AND COALESCE(p.git_remote,'')=?3)",
        params![target.project_id, target.revision, target.remote],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn apply_snapshot(
    db: &mut Connection,
    target: &Target,
    identity: &str,
    prs: &[ReviewPr],
) -> Result<(), String> {
    if identity.trim().is_empty() {
        return Err("ADO did not identify the acting user".into());
    }
    let repo = AdoRepo::parse(&target.remote)?;
    let source = repo.web_url(0).to_lowercase();
    let identity = identity.to_lowercase();
    let tx = db.transaction().map_err(|e| e.to_string())?;
    if !still_current(&tx, target)? {
        return Ok(());
    }
    let baseline: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pr_inbox_baselines
        WHERE project_id=?1 AND source=?2 AND identity=?3)",
            params![target.project_id, source, identity],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    for pr in prs {
        tx.execute(
            "INSERT INTO pr_inbox_seen
            (id,project_id,source,identity,pr_id,title,author,url,notified,discovered_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            ON CONFLICT(project_id,source,identity,pr_id) DO NOTHING",
            params![
                uuid::Uuid::new_v4().to_string(),
                target.project_id,
                source,
                identity,
                pr.id,
                pr.title,
                pr.author,
                repo.web_url(pr.id),
                baseline
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT INTO pr_inbox_baselines(project_id,source,identity) VALUES (?1,?2,?3)
        ON CONFLICT DO NOTHING",
        params![target.project_id, source, identity],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE pr_inbox_config SET current_identity=?2,current_source=?3,
        last_checked=strftime('%Y-%m-%dT%H:%M:%SZ','now'),error=NULL WHERE project_id=?1",
        params![target.project_id, identity, source],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn record_error(db: &Connection, target: &Target, error: &str) -> Result<(), String> {
    if still_current(db, target)? {
        db.execute(
            "UPDATE pr_inbox_config SET error=?2 WHERE project_id=?1",
            params![target.project_id, error],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn set_read(db: &Connection, id: &str, is_read: bool) -> Result<(), String> {
    let changed = db
        .execute(
            "UPDATE pr_inbox_seen SET is_read=?2 WHERE id=?1 AND notified=1",
            params![id, is_read],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Notification not found".into());
    }
    Ok(())
}

pub fn snapshot(db: &Connection) -> Result<InboxSnapshot, String> {
    let mut stmt = db.prepare("SELECT s.id,s.project_id,p.name,s.pr_id,s.title,s.author,s.url,s.is_read,s.discovered_at
        FROM pr_inbox_seen s JOIN projects p ON p.id=s.project_id
        JOIN pr_inbox_config c ON c.project_id=p.id
        WHERE s.notified=1 AND s.identity=c.current_identity AND s.source=c.current_source
        ORDER BY s.discovered_at DESC,s.pr_id DESC").map_err(|e| e.to_string())?;
    let items = stmt
        .query_map([], |r| {
            Ok(InboxItem {
                id: r.get(0)?,
                project_id: r.get(1)?,
                repo_name: r.get(2)?,
                pr_id: r.get(3)?,
                title: r.get(4)?,
                author: r.get(5)?,
                url: r.get(6)?,
                is_read: r.get(7)?,
                discovered_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT p.id,p.name,c.enabled,c.last_checked,c.error
        FROM pr_inbox_config c JOIN projects p ON p.id=c.project_id ORDER BY p.name",
        )
        .map_err(|e| e.to_string())?;
    let repos = stmt
        .query_map([], |r| {
            Ok(RepoStatus {
                project_id: r.get(0)?,
                repo_name: r.get(1)?,
                enabled: r.get(2)?,
                last_checked: r.get(3)?,
                error: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(InboxSnapshot { items, repos })
}

trait JsonTransport {
    fn get(&self, url: reqwest::Url) -> Result<serde_json::Value, String>;
}

struct AdoTransport {
    client: reqwest::blocking::Client,
    token: String,
}

impl AdoTransport {
    fn connect() -> Result<Self, String> {
        Ok(Self {
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Could not initialize the ADO connection")?,
            token: azure_token()?,
        })
    }
}

impl JsonTransport for AdoTransport {
    fn get(&self, url: reqwest::Url) -> Result<serde_json::Value, String> {
        use std::io::Read;
        let response = self
            .client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .map_err(|_| "ADO connection failed or timed out. Check your network and VPN.")?;
        let status = response.status();
        if matches!(status.as_u16(), 401 | 403) {
            return Err(
                "ADO access denied. Run az login for the account with access to this repo.".into(),
            );
        }
        if !status.is_success() {
            return Err(format!(
                "ADO returned HTTP {}. Check repository access and retry.",
                status.as_u16()
            ));
        }
        // Bound the response and never include provider bodies or credentials in errors.
        let mut bytes = Vec::new();
        response
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read the ADO response")?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("ADO response exceeded the size limit; sync was not applied".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "ADO returned an invalid JSON response".into())
    }
}

fn azure_token() -> Result<String, String> {
    read_azure_token(
        &mut azure_cli_command(cfg!(windows)),
        std::time::Duration::from_secs(30),
    )
}

fn azure_cli_command(windows: bool) -> std::process::Command {
    let mut command = if windows {
        let mut cmd = crate::hidden_command("cmd.exe");
        // Azure CLI ships an az.cmd launcher. Only fixed arguments enter the shell.
        cmd.args(["/D", "/C", "az"]);
        cmd
    } else {
        crate::hidden_command("az")
    };
    command.args([
        "account",
        "get-access-token",
        "--resource",
        "499b84ac-1321-427f-aa17-267ca6975798",
        "--output",
        "json",
    ]);
    command
}

fn read_azure_token(
    command: &mut std::process::Command,
    timeout: std::time::Duration,
) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let guidance =
        "Azure CLI authentication failed. Install az and run az login for your ADO account.";
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| guidance)?;
    let stdout = child.stdout.take().ok_or(guidance)?;
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(65537).read_to_end(&mut bytes).map(|_| bytes);
        let _ = send.send(result);
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(guidance.into());
                }
                break;
            }
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "Azure CLI timed out or could not be read. Run az login and try again.".into(),
                );
            }
        }
    }
    let bytes = receive
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| guidance)?
        .map_err(|_| guidance)?;
    if bytes.len() > 65536 {
        return Err(guidance.into());
    }
    let payload: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| guidance)?;
    payload
        .get("accessToken")
        .and_then(|v| v.as_str())
        .filter(|token| !token.is_empty() && !token.chars().any(char::is_whitespace))
        .map(str::to_owned)
        .ok_or_else(|| guidance.into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireReviewer {
    id: String,
    #[serde(default)]
    is_container: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireAuthor {
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePr {
    pull_request_id: u64,
    title: String,
    created_by: WireAuthor,
    status: String,
    #[serde(default)]
    is_draft: bool,
    reviewers: Vec<WireReviewer>,
}

fn fetch_reviews(
    http: &dyn JsonTransport,
    repo: &AdoRepo,
) -> Result<(String, Vec<ReviewPr>), String> {
    let mut identity_url = repo.url(&["_apis", "connectionData"]);
    identity_url
        .query_pairs_mut()
        .append_pair("api-version", "7.1-preview.1");
    let connection = http.get(identity_url)?;
    let identity = connection
        .pointer("/authenticatedUser/id")
        .and_then(|v| v.as_str())
        .filter(|id| !id.trim().is_empty())
        .ok_or("ADO did not identify the authenticated user")?
        .to_owned();
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    let mut skip = 0;
    for _ in 0..100 {
        let mut url = repo.url(&[
            &repo.project,
            "_apis",
            "git",
            "repositories",
            &repo.repository,
            "pullrequests",
        ]);
        url.query_pairs_mut()
            .append_pair("api-version", "7.1")
            .append_pair("searchCriteria.status", "active")
            .append_pair("searchCriteria.reviewerId", &identity)
            .append_pair("$top", "100")
            .append_pair("$skip", &skip.to_string());
        let page = http.get(url)?;
        let values = page
            .get("value")
            .and_then(|v| v.as_array())
            .ok_or("ADO returned an invalid PR page")?;
        if values.is_empty() {
            return Ok((identity, result));
        }
        skip += values.len();
        for value in values {
            let pr: WirePr = serde_json::from_value(value.clone())
                .map_err(|_| "ADO returned an invalid PR entry")?;
            if !seen.insert(pr.pull_request_id) {
                return Err("ADO pagination changed during sync; retrying on the next poll".into());
            }
            if pr.status == "active"
                && !pr.is_draft
                && pr
                    .reviewers
                    .iter()
                    .any(|r| !r.is_container && r.id.eq_ignore_ascii_case(&identity))
            {
                result.push(ReviewPr {
                    id: pr.pull_request_id,
                    title: pr.title,
                    author: pr.created_by.display_name,
                });
            }
        }
    }
    Err("ADO pagination limit reached; no partial sync was applied".into())
}

/// Owns the poller's lifetime. Network and Azure CLI work never holds the DB lock.
pub struct InboxPoller {
    stop: std::sync::mpsc::Sender<()>,
}

impl InboxPoller {
    pub fn start(db: std::sync::Arc<std::sync::Mutex<Connection>>) -> Self {
        Self::start_with(
            db,
            AdoTransport::connect,
            std::time::Duration::from_secs(120),
            std::time::Duration::from_secs(2),
        )
    }

    fn start_with<F, T>(
        db: std::sync::Arc<std::sync::Mutex<Connection>>,
        mut connect: F,
        poll_interval: std::time::Duration,
        check_interval: std::time::Duration,
    ) -> Self
    where
        F: FnMut() -> Result<T, String> + Send + 'static,
        T: JsonTransport,
    {
        let (stop, stopped) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            use std::time::Instant;
            let mut last = Instant::now() - poll_interval;
            let mut previous = Vec::new();
            loop {
                let selected = db
                    .lock()
                    .map_err(|e| e.to_string())
                    .and_then(|db| targets(&db));
                match selected {
                    Ok(selected) => {
                        let fingerprint: Vec<_> = selected
                            .iter()
                            .map(|t| (t.project_id.clone(), t.remote.clone(), t.revision))
                            .collect();
                        if !selected.is_empty()
                            && (fingerprint != previous || last.elapsed() >= poll_interval)
                        {
                            let transport = connect();
                            for target in &selected {
                                if stopped.try_recv() != Err(std::sync::mpsc::TryRecvError::Empty) {
                                    return;
                                }
                                let result =
                                    transport.as_ref().map_err(Clone::clone).and_then(|http| {
                                        AdoRepo::parse(&target.remote)
                                            .and_then(|repo| fetch_reviews(http, &repo))
                                    });
                                let saved =
                                    db.lock().map_err(|e| e.to_string()).and_then(|mut db| {
                                        match result {
                                            Ok((identity, prs)) => {
                                                apply_snapshot(&mut db, target, &identity, &prs)
                                            }
                                            Err(error) => record_error(&db, target, &error),
                                        }
                                    });
                                if let Err(error) = saved {
                                    eprintln!("[pr-inbox] Could not save poll: {error}");
                                }
                            }
                            last = Instant::now();
                        }
                        previous = fingerprint;
                    }
                    Err(error) => eprintln!("[pr-inbox] Could not read configuration: {error}"),
                }
                if stopped.recv_timeout(check_interval)
                    != Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                {
                    break;
                }
            }
        });
        Self { stop }
    }
}

impl Drop for InboxPoller {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inbox_azure_cli_command_supports_windows_cmd_launchers() {
        let windows = azure_cli_command(true);
        assert_eq!(windows.get_program(), "cmd.exe");
        let args: Vec<_> = windows.get_args().map(|s| s.to_str().unwrap()).collect();
        assert_eq!(&args[..3], &["/D", "/C", "az"]);
        assert_eq!(
            &args[3..],
            &[
                "account",
                "get-access-token",
                "--resource",
                "499b84ac-1321-427f-aa17-267ca6975798",
                "--output",
                "json"
            ]
        );
        let unix = azure_cli_command(false);
        assert_eq!(unix.get_program(), "az");
        assert_eq!(unix.get_args().next().unwrap(), "account");
    }

    #[test]
    fn inbox_worker_polls_only_opted_in_repos_without_locking_db_during_network() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};
        struct UnlockedTransport(Arc<Mutex<Connection>>);
        impl JsonTransport for UnlockedTransport {
            fn get(&self, url: reqwest::Url) -> Result<serde_json::Value, String> {
                assert!(
                    self.0.try_lock().is_ok(),
                    "DB must be available during HTTP work"
                );
                if url.path().ends_with("connectionData") {
                    Ok(json!({"authenticatedUser":{"id":"me"}}))
                } else {
                    Ok(json!({"value":[]}))
                }
            }
        }
        let db = Arc::new(Mutex::new(db()));
        let connects = Arc::new(AtomicUsize::new(0));
        let factory_db = Arc::clone(&db);
        let factory_connects = Arc::clone(&connects);
        let poller = InboxPoller::start_with(
            Arc::clone(&db),
            move || {
                factory_connects.fetch_add(1, Ordering::SeqCst);
                Ok(UnlockedTransport(Arc::clone(&factory_db)))
            },
            Duration::from_millis(100),
            Duration::from_millis(5),
        );
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(
            connects.load(Ordering::SeqCst),
            0,
            "no credentials requested without opt-in"
        );
        configure(&db.lock().unwrap(), "p", true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while connects.load(Ordering::SeqCst) < 2 {
            assert!(Instant::now() < deadline, "periodic poll did not run");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(snapshot(&db.lock().unwrap()).unwrap().repos[0]
            .last_checked
            .is_some());
        configure(&db.lock().unwrap(), "p", false).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        let count = connects.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(130));
        assert_eq!(connects.load(Ordering::SeqCst), count);
        drop(poller);
        std::thread::sleep(Duration::from_millis(30));
        configure(&db.lock().unwrap(), "p", true).unwrap();
        std::thread::sleep(Duration::from_millis(130));
        assert_eq!(
            connects.load(Ordering::SeqCst),
            count,
            "dropping app worker stops polls"
        );
    }

    #[test]
    #[ignore = "Read-only live ADO check; requires az login and PR_INBOX_LIVE_REMOTE"]
    fn inbox_live_provider_reads_authenticated_assignments() {
        let remote = std::env::var("PR_INBOX_LIVE_REMOTE").expect("explicit ADO clone URL");
        let repo = AdoRepo::parse(&remote).unwrap();
        let transport = AdoTransport::connect().unwrap();
        let (identity, prs) = fetch_reviews(&transport, &repo).unwrap();
        assert!(!identity.is_empty());
        println!(
            "Live ADO identity resolved; {} direct ready assignments retrieved",
            prs.len()
        );
    }

    struct FakeTransport {
        responses:
            std::cell::RefCell<std::collections::VecDeque<Result<serde_json::Value, String>>>,
        urls: std::cell::RefCell<Vec<reqwest::Url>>,
    }

    impl JsonTransport for FakeTransport {
        fn get(&self, url: reqwest::Url) -> Result<serde_json::Value, String> {
            self.urls.borrow_mut().push(url);
            self.responses
                .borrow_mut()
                .pop_front()
                .expect("unexpected request")
        }
    }

    fn transport(pages: Vec<Result<serde_json::Value, String>>) -> FakeTransport {
        FakeTransport {
            responses: std::cell::RefCell::new(pages.into()),
            urls: Default::default(),
        }
    }

    fn wire_pr(id: u64, reviewer: &str, draft: bool, group: bool) -> serde_json::Value {
        json!({"pullRequestId":id,"title":"Title","createdBy":{"displayName":"Author"},
            "status":"active","isDraft":draft,"reviewers":[{"id":reviewer,"isContainer":group}]})
    }

    #[test]
    fn inbox_provider_pages_and_filters_direct_ready_assignments() {
        let http = transport(vec![
            Ok(json!({"authenticatedUser":{"id":"me"}})),
            Ok(json!({"value":[wire_pr(1,"me",false,false),wire_pr(2,"me",true,false)]})),
            Ok(
                json!({"value":[wire_pr(3,"me",false,true),wire_pr(4,"other",false,false),wire_pr(5,"ME",false,false)]}),
            ),
            Ok(json!({"value":[]})),
        ]);
        let (identity, prs) = fetch_reviews(
            &http,
            &AdoRepo::parse("https://dev.azure.com/org/proj/_git/repo").unwrap(),
        )
        .unwrap();
        assert_eq!(identity, "me");
        assert_eq!(prs.iter().map(|p| p.id).collect::<Vec<_>>(), vec![1, 5]);
        let urls = http.urls.borrow();
        assert!(urls[1]
            .query()
            .unwrap()
            .contains("searchCriteria.reviewerId=me"));
        assert!(urls[2].query().unwrap().contains("%24skip=2"));
        assert!(urls[3].query().unwrap().contains("%24skip=5"));
    }

    #[test]
    fn inbox_provider_never_accepts_failed_or_malformed_partial_snapshots() {
        let repo = AdoRepo::parse("https://dev.azure.com/org/proj/_git/repo").unwrap();
        for last in [
            Err("Connection failed".into()),
            Ok(json!({"unexpected":[]})),
            Ok(json!({"value":[wire_pr(1,"me",false,false)]})),
        ] {
            let http = transport(vec![
                Ok(json!({"authenticatedUser":{"id":"me"}})),
                Ok(json!({"value":[wire_pr(1,"me",false,false)]})),
                last,
            ]);
            assert!(fetch_reviews(&http, &repo).is_err());
        }
        let http = transport(vec![Ok(json!({"authenticatedUser":{"id":""}}))]);
        assert!(fetch_reviews(&http, &repo).is_err());
    }

    #[test]
    fn inbox_failed_poll_does_not_establish_baseline_and_drafts_can_become_ready() {
        let mut db = db();
        configure(&db, "p", true).unwrap();
        let target = targets(&db).unwrap().remove(0);
        record_error(&db, &target, "Run az login").unwrap();
        assert_eq!(
            snapshot(&db).unwrap().repos[0].error.as_deref(),
            Some("Run az login")
        );
        apply_snapshot(&mut db, &target, "me", &[pr(1)]).unwrap();
        assert!(snapshot(&db).unwrap().items.is_empty());
        // The provider omits draft PR 2 until ready.
        apply_snapshot(&mut db, &target, "me", &[pr(1), pr(2)]).unwrap();
        let state = snapshot(&db).unwrap();
        assert_eq!(state.items[0].pr_id, 2);
        assert!(state.repos[0].error.is_none());
        assert!(state.repos[0].last_checked.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn inbox_token_command_is_bounded_and_never_returns_raw_credentials_in_errors() {
        use std::process::Command;
        use std::time::Duration;
        let mut valid = Command::new("sh");
        valid.args(["-c", "printf '{\"accessToken\":\"test-token\"}'"]);
        assert_eq!(
            read_azure_token(&mut valid, Duration::from_secs(1)).unwrap(),
            "test-token"
        );
        for script in [
            "printf 'SECRET malformed output'",
            "printf 'SECRET stderr' >&2; exit 1",
            "printf '{\"accessToken\":\"\"}'",
        ] {
            let mut command = Command::new("sh");
            command.args(["-c", script]);
            let error = read_azure_token(&mut command, Duration::from_secs(1)).unwrap_err();
            assert!(error.contains("az login"));
            assert!(!error.contains("SECRET"));
        }
        let mut slow = Command::new("sh");
        slow.args(["-c", "exec sleep 2"]);
        assert!(read_azure_token(&mut slow, Duration::from_millis(20))
            .unwrap_err()
            .contains("timed out"));
    }

    #[test]
    fn inbox_http_transport_sends_bearer_and_refuses_redirects_and_auth_errors() {
        use std::io::{Read, Write};
        for (status, body) in [
            ("200 OK", "{\"value\":[]}"),
            ("302 Found", "SECRET"),
            ("401 Unauthorized", "SECRET"),
            ("200 OK", "SECRET"),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buffer = [0; 4096];
                let len = stream.read(&mut buffer).unwrap();
                let request = String::from_utf8_lossy(&buffer[..len]).to_ascii_lowercase();
                assert!(request.contains("authorization: bearer test-token"));
                write!(stream,"HTTP/1.1 {status}\r\nContent-Length: {}\r\nLocation: https://example.invalid/\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            });
            let http = AdoTransport {
                client: reqwest::blocking::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(std::time::Duration::from_secs(2))
                    .build()
                    .unwrap(),
                token: "test-token".into(),
            };
            let result = http.get(reqwest::Url::parse(&url).unwrap());
            if body == "{\"value\":[]}" {
                assert!(result.is_ok());
            } else {
                let error = result.unwrap_err();
                assert!(!error.contains("SECRET"));
                if status.starts_with("401") {
                    assert!(error.contains("az login"));
                }
                if status.starts_with("302") {
                    assert!(error.contains("302"));
                }
            }
            server.join().unwrap();
        }
    }

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::db::init_db(&db).unwrap();
        db.execute("INSERT INTO projects (id,name,directory,git_remote,color,created_at,updated_at)
            VALUES ('p','Repo','/repo','https://dev.azure.com/org/project/_git/repo','#fff','t','t')", []).unwrap();
        db
    }

    fn pr(id: u64) -> ReviewPr {
        ReviewPr {
            id,
            title: format!("PR {id}"),
            author: "Author".into(),
        }
    }

    #[test]
    fn inbox_baselines_silently_then_deduplicates_and_preserves_read_state() {
        let mut db = db();
        configure(&db, "p", true).unwrap();
        let target = targets(&db).unwrap().remove(0);
        apply_snapshot(&mut db, &target, "me", &[pr(1)]).unwrap();
        assert!(snapshot(&db).unwrap().items.is_empty());
        apply_snapshot(&mut db, &target, "me", &[pr(1), pr(2)]).unwrap();
        let item = snapshot(&db).unwrap().items.remove(0);
        assert_eq!(item.pr_id, 2);
        assert!(!item.is_read);
        set_read(&db, &item.id, true).unwrap();
        apply_snapshot(&mut db, &target, "me", &[]).unwrap();
        apply_snapshot(&mut db, &target, "me", &[pr(2)]).unwrap();
        let items = snapshot(&db).unwrap().items;
        assert_eq!(items.len(), 1);
        assert!(items[0].is_read);
        set_read(&db, &item.id, false).unwrap();
        assert!(!snapshot(&db).unwrap().items[0].is_read);
    }

    #[test]
    fn inbox_disabled_or_changed_configuration_rejects_in_flight_results() {
        let mut db = db();
        assert!(targets(&db).unwrap().is_empty());
        configure(&db, "p", true).unwrap();
        let old = targets(&db).unwrap().remove(0);
        configure(&db, "p", false).unwrap();
        configure(&db, "p", true).unwrap();
        apply_snapshot(&mut db, &old, "me", &[]).unwrap();
        let current = targets(&db).unwrap().remove(0);
        apply_snapshot(&mut db, &current, "me", &[pr(1)]).unwrap();
        assert!(
            snapshot(&db).unwrap().items.is_empty(),
            "stale result must not establish baseline"
        );
    }

    #[test]
    fn inbox_identity_changes_start_a_silent_separate_baseline() {
        let mut db = db();
        configure(&db, "p", true).unwrap();
        let target = targets(&db).unwrap().remove(0);
        apply_snapshot(&mut db, &target, "me", &[]).unwrap();
        apply_snapshot(&mut db, &target, "me", &[pr(1)]).unwrap();
        apply_snapshot(&mut db, &target, "other", &[pr(2)]).unwrap();
        assert!(snapshot(&db).unwrap().items.is_empty());
        apply_snapshot(&mut db, &target, "other", &[pr(2), pr(3)]).unwrap();
        assert_eq!(snapshot(&db).unwrap().items[0].pr_id, 3);
    }

    #[test]
    fn inbox_configuration_rejects_unknown_or_non_ado_repositories() {
        let db = db();
        assert!(configure(&db, "missing", true).is_err());
        db.execute(
            "UPDATE projects SET git_remote='https://github.com/org/repo'",
            [],
        )
        .unwrap();
        assert!(configure(&db, "p", true).is_err());
        assert!(targets(&db).unwrap().is_empty());
    }

    #[test]
    fn inbox_remote_parser_accepts_ado_clone_formats_only() {
        for remote in [
            "https://user@dev.azure.com/org/project/_git/repo",
            "https://org.visualstudio.com/project/_git/repo",
            "git@ssh.dev.azure.com:v3/org/project/repo",
            "ssh://git@ssh.dev.azure.com/v3/org/project/repo",
        ] {
            let repo = AdoRepo::parse(remote).unwrap();
            assert_eq!(
                repo.web_url(42),
                "https://dev.azure.com/org/project/_git/repo/pullrequest/42"
            );
        }
        for remote in [
            "https://github.com/org/project/_git/repo",
            "https://dev.azure.com.evil.example/org/project/_git/repo",
            "http://dev.azure.com/org/project/_git/repo",
            "https://dev.azure.com/org/project/_git/repo/extra",
        ] {
            assert!(AdoRepo::parse(remote).is_err(), "{remote}");
        }
    }
}
