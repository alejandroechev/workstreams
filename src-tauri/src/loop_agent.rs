use async_trait::async_trait;
use github_copilot_sdk::handler::ApproveAllHandler;
use github_copilot_sdk::session::Session;
use github_copilot_sdk::subscription::RecvErrorKind;
use github_copilot_sdk::{Client, ClientOptions, MessageOptions, SessionConfig};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Orchestrator,
    Worker,
    Evaluator,
}

impl std::fmt::Display for AgentRole {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::Orchestrator => "orchestrator",
            Self::Worker => "worker",
            Self::Evaluator => "evaluator",
        };
        formatter.write_str(value)
    }
}

#[derive(Debug, Clone)]
pub struct AgentRequest {
    pub role: AgentRole,
    pub prompt: String,
    pub working_directory: PathBuf,
    pub model: Option<String>,
    pub timeout: Duration,
    pub keep_session: bool,
    pub excluded_tools: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentRuntimeEvent {
    pub event_type: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentResponse {
    pub session_id: String,
    pub content: String,
}

#[async_trait]
pub trait LoopAgentRuntime: Send + Sync {
    async fn start(
        &self,
        request: AgentRequest,
        events: mpsc::UnboundedSender<AgentRuntimeEvent>,
    ) -> Result<AgentResponse, String>;

    async fn revise(
        &self,
        session_id: &str,
        prompt: &str,
        timeout: Duration,
        events: mpsc::UnboundedSender<AgentRuntimeEvent>,
    ) -> Result<AgentResponse, String>;

    async fn abort_all(&self) -> Result<(), String>;

    async fn disconnect(&self, session_id: &str) -> Result<(), String>;

    async fn shutdown(&self) -> Result<(), String>;
}

pub struct SdkAgentRuntime {
    client: Client,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    cancelled: AtomicBool,
}

impl SdkAgentRuntime {
    pub async fn connect() -> Result<Self, String> {
        let client = Client::start(ClientOptions::default())
            .await
            .map_err(|error| format!("Failed to start Copilot SDK runtime: {error}"))?;
        Ok(Self {
            client,
            sessions: Mutex::new(HashMap::new()),
            cancelled: AtomicBool::new(false),
        })
    }

    async fn send(
        session: Arc<Session>,
        prompt: &str,
        timeout: Duration,
        events: mpsc::UnboundedSender<AgentRuntimeEvent>,
    ) -> Result<AgentResponse, String> {
        let mut subscription = session.subscribe();
        let event_sender = events.clone();
        let last_assistant_id = Arc::new(Mutex::new(None::<String>));
        let forwarded_assistant_id = Arc::clone(&last_assistant_id);
        let event_task = tokio::spawn(async move {
            loop {
                match subscription.recv().await {
                    Ok(event) => {
                        if event.event_type == "assistant.message" {
                            *forwarded_assistant_id.lock().await = Some(event.id.to_string());
                        }
                        if event_sender
                            .send(AgentRuntimeEvent {
                                event_type: event.event_type,
                                data: event.data,
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) => match error.kind() {
                        RecvErrorKind::Lagged(lagged) => {
                            if event_sender
                                .send(AgentRuntimeEvent {
                                    event_type: "events.lagged".to_string(),
                                    data: serde_json::json!({
                                        "skipped": lagged.skipped(),
                                    }),
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                        RecvErrorKind::Closed => break,
                        _ => break,
                    },
                }
            }
        });

        let response = session
            .send_and_wait(MessageOptions::new(prompt).with_wait_timeout(timeout))
            .await
            .map_err(|error| format!("Copilot session failed: {error}"));
        event_task.abort();
        let _ = event_task.await;

        let event = response?.ok_or_else(|| {
            "Copilot session became idle without an assistant response".to_string()
        })?;
        let content = event
            .data
            .get("content")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Copilot assistant response did not contain text content".to_string())?
            .to_string();
        let final_was_forwarded = last_assistant_id
            .lock()
            .await
            .as_deref()
            .is_some_and(|id| id == event.id.as_str());
        if !final_was_forwarded {
            let _ = events.send(AgentRuntimeEvent {
                event_type: event.event_type,
                data: event.data,
            });
        }
        Ok(AgentResponse {
            session_id: session.id().to_string(),
            content,
        })
    }
}

#[async_trait]
impl LoopAgentRuntime for SdkAgentRuntime {
    async fn start(
        &self,
        request: AgentRequest,
        events: mpsc::UnboundedSender<AgentRuntimeEvent>,
    ) -> Result<AgentResponse, String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("Copilot runtime was cancelled".to_string());
        }
        let mut config = SessionConfig::default();
        config.model = request.model;
        config.working_directory = Some(request.working_directory);
        config.streaming = Some(true);
        if !request.excluded_tools.is_empty() {
            config.excluded_tools = Some(request.excluded_tools);
        }
        config = config.with_permission_handler(Arc::new(ApproveAllHandler));
        let session = Arc::new(
            self.client
                .create_session(config)
                .await
                .map_err(|error| format!("Failed to create Copilot session: {error}"))?,
        );
        if self.cancelled.load(Ordering::Acquire) {
            let _ = session.abort().await;
            let _ = session.disconnect().await;
            return Err("Copilot runtime was cancelled during session creation".to_string());
        }
        let session_id = session.id().to_string();
        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), Arc::clone(&session));
        if self.cancelled.load(Ordering::Acquire) {
            self.sessions.lock().await.remove(&session_id);
            let _ = session.abort().await;
            let _ = session.disconnect().await;
            return Err("Copilot runtime was cancelled during session registration".to_string());
        }
        let _ = events.send(AgentRuntimeEvent {
            event_type: "session.started".to_string(),
            data: serde_json::json!({
                "session_id": session_id.clone(),
                "role": request.role,
            }),
        });

        let result = Self::send(
            Arc::clone(&session),
            &request.prompt,
            request.timeout,
            events,
        )
        .await;
        if !request.keep_session || result.is_err() {
            self.sessions.lock().await.remove(&session_id);
            let disconnect_result = session
                .disconnect()
                .await
                .map_err(|error| format!("Failed to disconnect Copilot session: {error}"));
            if result.is_ok() {
                disconnect_result?;
            }
        }
        result
    }

    async fn revise(
        &self,
        session_id: &str,
        prompt: &str,
        timeout: Duration,
        events: mpsc::UnboundedSender<AgentRuntimeEvent>,
    ) -> Result<AgentResponse, String> {
        let session = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("Copilot session not retained: {session_id}"))?;
        Self::send(session, prompt, timeout, events).await
    }

    async fn abort_all(&self) -> Result<(), String> {
        self.cancelled.store(true, Ordering::Release);
        let sessions = self
            .sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut errors = Vec::new();
        for session in sessions {
            if let Err(error) = session.abort().await {
                errors.push(error.to_string());
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Failed to abort Copilot sessions: {}",
                errors.join("; ")
            ))
        }
    }

    async fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .await
            .remove(session_id)
            .ok_or_else(|| format!("Copilot session not retained: {session_id}"))?;
        session
            .disconnect()
            .await
            .map_err(|error| format!("Failed to disconnect Copilot session: {error}"))
    }

    async fn shutdown(&self) -> Result<(), String> {
        let sessions = {
            let mut sessions = self.sessions.lock().await;
            sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>()
        };
        for session in sessions {
            session
                .disconnect()
                .await
                .map_err(|error| format!("Failed to disconnect Copilot session: {error}"))?;
        }
        self.client
            .stop()
            .await
            .map_err(|error| format!("Failed to stop Copilot SDK runtime: {error}"))
    }
}

#[derive(Debug, Clone)]
pub struct ScriptedAgentResponse {
    pub role: AgentRole,
    pub session_id: String,
    pub content: String,
    pub events: Vec<AgentRuntimeEvent>,
}

pub struct ScriptedAgentRuntime {
    responses: Mutex<VecDeque<ScriptedAgentResponse>>,
    retained_sessions: Mutex<HashSet<String>>,
}

impl ScriptedAgentRuntime {
    pub fn new(responses: Vec<ScriptedAgentResponse>) -> Self {
        Self {
            responses: Mutex::new(responses.into()),
            retained_sessions: Mutex::new(HashSet::new()),
        }
    }

    async fn take_response(&self, role: AgentRole) -> Result<ScriptedAgentResponse, String> {
        let response = self
            .responses
            .lock()
            .await
            .pop_front()
            .ok_or_else(|| format!("No scripted {role} response remains"))?;
        if response.role != role {
            return Err(format!(
                "Scripted response role mismatch: expected {role}, got {}",
                response.role
            ));
        }
        Ok(response)
    }

    fn publish_events(
        response: &ScriptedAgentResponse,
        events: &mpsc::UnboundedSender<AgentRuntimeEvent>,
    ) {
        for event in &response.events {
            let _ = events.send(event.clone());
        }
    }
}

#[async_trait]
impl LoopAgentRuntime for ScriptedAgentRuntime {
    async fn start(
        &self,
        request: AgentRequest,
        events: mpsc::UnboundedSender<AgentRuntimeEvent>,
    ) -> Result<AgentResponse, String> {
        let response = self.take_response(request.role).await?;
        let _ = events.send(AgentRuntimeEvent {
            event_type: "session.started".to_string(),
            data: serde_json::json!({
                "session_id": response.session_id.clone(),
                "role": request.role,
            }),
        });
        Self::publish_events(&response, &events);
        if request.keep_session {
            self.retained_sessions
                .lock()
                .await
                .insert(response.session_id.clone());
        }
        Ok(AgentResponse {
            session_id: response.session_id,
            content: response.content,
        })
    }

    async fn revise(
        &self,
        session_id: &str,
        _prompt: &str,
        _timeout: Duration,
        events: mpsc::UnboundedSender<AgentRuntimeEvent>,
    ) -> Result<AgentResponse, String> {
        if !self.retained_sessions.lock().await.contains(session_id) {
            return Err(format!("Scripted session not retained: {session_id}"));
        }
        let response = self.take_response(AgentRole::Worker).await?;
        if response.session_id != session_id {
            return Err(format!(
                "Scripted revision session mismatch: expected {session_id}, got {}",
                response.session_id
            ));
        }
        Self::publish_events(&response, &events);
        Ok(AgentResponse {
            session_id: response.session_id,
            content: response.content,
        })
    }

    async fn abort_all(&self) -> Result<(), String> {
        Ok(())
    }

    async fn disconnect(&self, session_id: &str) -> Result<(), String> {
        if self.retained_sessions.lock().await.remove(session_id) {
            Ok(())
        } else {
            Err(format!("Scripted session not retained: {session_id}"))
        }
    }

    async fn shutdown(&self) -> Result<(), String> {
        self.retained_sessions.lock().await.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scripted_runtime_returns_role_response_and_streams_events() {
        let runtime = ScriptedAgentRuntime::new(vec![ScriptedAgentResponse {
            role: AgentRole::Orchestrator,
            session_id: "session-1".to_string(),
            content: r#"{"tasks":[]}"#.to_string(),
            events: vec![AgentRuntimeEvent {
                event_type: "assistant.message".to_string(),
                data: serde_json::json!({ "content": "{\"tasks\":[]}" }),
            }],
        }]);
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();

        let response = runtime
            .start(
                AgentRequest {
                    role: AgentRole::Orchestrator,
                    prompt: "discover work".to_string(),
                    working_directory: "/tmp/repo".into(),
                    model: None,
                    timeout: std::time::Duration::from_secs(30),
                    keep_session: false,
                    excluded_tools: Vec::new(),
                },
                event_tx,
            )
            .await
            .expect("scripted response");

        assert_eq!(response.session_id, "session-1");
        assert_eq!(response.content, r#"{"tasks":[]}"#);
        assert_eq!(
            event_rx.recv().await.expect("session event").event_type,
            "session.started"
        );
        assert_eq!(
            event_rx.recv().await.expect("streamed event").event_type,
            "assistant.message"
        );
    }

    #[tokio::test]
    async fn scripted_runtime_rejects_a_response_for_the_wrong_role() {
        let runtime = ScriptedAgentRuntime::new(vec![ScriptedAgentResponse {
            role: AgentRole::Worker,
            session_id: "session-1".to_string(),
            content: "done".to_string(),
            events: vec![],
        }]);
        let (event_tx, _event_rx) = tokio::sync::mpsc::unbounded_channel();

        let error = runtime
            .start(
                AgentRequest {
                    role: AgentRole::Evaluator,
                    prompt: "evaluate".to_string(),
                    working_directory: "/tmp/repo".into(),
                    model: None,
                    timeout: std::time::Duration::from_secs(30),
                    keep_session: false,
                    excluded_tools: Vec::new(),
                },
                event_tx,
            )
            .await
            .expect_err("role mismatch must fail");

        assert!(error.contains("expected evaluator"));
    }

    #[tokio::test]
    async fn revising_an_unknown_scripted_session_is_an_error() {
        let runtime = ScriptedAgentRuntime::new(vec![]);
        let (event_tx, _event_rx) = tokio::sync::mpsc::unbounded_channel();

        let error = runtime
            .revise(
                "missing",
                "try again",
                std::time::Duration::from_secs(30),
                event_tx,
            )
            .await
            .expect_err("unknown session must fail");

        assert!(error.contains("missing"));
    }

    #[tokio::test]
    #[ignore = "requires authenticated GitHub Copilot access"]
    async fn sdk_runtime_smoke_starts_streams_and_shuts_down() {
        let runtime = SdkAgentRuntime::connect()
            .await
            .expect("start bundled Copilot SDK runtime");
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
        let response = runtime
            .start(
                AgentRequest {
                    role: AgentRole::Worker,
                    prompt: "Reply with exactly {\"status\":\"LOOP_SDK_OK\"} and nothing else."
                        .to_string(),
                    working_directory: std::env::current_dir().expect("current directory"),
                    model: None,
                    timeout: std::time::Duration::from_secs(120),
                    keep_session: true,
                    excluded_tools: Vec::new(),
                },
                event_tx.clone(),
            )
            .await
            .expect("run Copilot SDK session");

        let value: serde_json::Value =
            serde_json::from_str(response.content.trim()).expect("structured JSON response");
        assert_eq!(value["status"], "LOOP_SDK_OK");
        assert!(
            event_rx.try_recv().is_ok(),
            "the runtime should stream at least one session event"
        );
        let revised = runtime
            .revise(
                &response.session_id,
                "Reply with exactly LOOP_SDK_REVISED and nothing else.",
                std::time::Duration::from_secs(120),
                event_tx,
            )
            .await
            .expect("revise retained SDK session");
        assert_eq!(revised.content.trim(), "LOOP_SDK_REVISED");
        runtime
            .abort_all()
            .await
            .expect("abort retained idle session");
        runtime
            .disconnect(&response.session_id)
            .await
            .expect("disconnect retained session");
        runtime.shutdown().await.expect("stop SDK runtime");
    }
}
