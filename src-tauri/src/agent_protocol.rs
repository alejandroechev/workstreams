//! Wire types shared by the agent transport and the command registry.
//!
//! Separate from `agent_socket` because the transport is Unix-only while the
//! registry is not: leaving these next to the socket made the registry fail to
//! compile on Windows, which is a worse outcome than the platform simply
//! lacking the channel.

use serde::{Deserialize, Serialize};

/// One command an agent asks the app to run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRequest {
    pub cmd: String,
    #[serde(default)]
    pub params: serde_json::Value,
    /// Proof of identity the app issued when it spawned this session.
    ///
    /// Separate from `params` so a command can never be written that accepts an
    /// identity as an argument — the only identity available is the one the app
    /// handed out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

/// A failure an agent can act on.
///
/// `hint` is not decoration. An agent that receives only "invalid argument"
/// tends to rewrite its arguments at random; one that is told what to do
/// instead repairs the call. Every error carries one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentError {
    pub code: String,
    pub message: String,
    pub hint: String,
}

impl AgentError {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        hint: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            hint: hint.into(),
        }
    }
}

/// The app's answer to one request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl AgentResponse {
    pub fn ok(data: serde_json::Value) -> Self {
        Self {
            ok: true,
            data: Some(data),
            code: None,
            message: None,
            hint: None,
        }
    }

    pub fn failed(error: AgentError) -> Self {
        Self {
            ok: false,
            data: None,
            code: Some(error.code),
            message: Some(error.message),
            hint: Some(error.hint),
        }
    }
}

/// Encodes a request as one newline-terminated frame.
///
/// `serde_json` escapes embedded newlines, so a payload containing one cannot
/// split the frame. That is what lets the wire format stay newline-delimited
/// instead of length-prefixed.
pub fn encode_request(request: &AgentRequest) -> String {
    let body = serde_json::to_string(request).unwrap_or_else(|_| "{}".to_string());
    format!("{body}\n")
}

pub fn decode_request(line: &str) -> Result<AgentRequest, AgentError> {
    serde_json::from_str(line.trim()).map_err(|error| {
        AgentError::new(
            "BAD_REQUEST",
            format!("Could not parse the request: {error}"),
            "Send one JSON object per line, shaped {\"cmd\": \"...\", \"params\": {}}",
        )
    })
}

pub fn encode_response(response: &AgentResponse) -> String {
    let body = serde_json::to_string(response).unwrap_or_else(|_| {
        r#"{"ok":false,"code":"ENCODE_FAILED","message":"Could not encode the response","hint":"Report this as a bug"}"#
            .to_string()
    });
    format!("{body}\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_round_trips_as_one_json_line() {
        let encoded = encode_request(&AgentRequest {
            cmd: "ws.create".to_string(),
            params: serde_json::json!({ "name": "alpha" }),
            token: None,
        });
        assert!(encoded.ends_with('\n'), "requests must be newline-framed");
        assert_eq!(encoded.matches('\n').count(), 1, "exactly one frame");

        let decoded = decode_request(&encoded).expect("decode");
        assert_eq!(decoded.cmd, "ws.create");
        assert_eq!(decoded.params["name"], "alpha");
    }

    /// A malformed request must produce a structured error the agent can act
    /// on, not a dropped connection it has to guess about.
    #[test]
    fn a_malformed_request_becomes_a_structured_error() {
        let error = decode_request("{not json").expect_err("should not parse");
        assert_eq!(error.code, "BAD_REQUEST");
        assert!(!error.hint.is_empty(), "an agent needs a repair hint");
    }

    #[test]
    fn responses_carry_a_code_and_hint_on_failure_and_neither_on_success() {
        let ok = encode_response(&AgentResponse::ok(serde_json::json!({ "id": "ws-1" })));
        let parsed: serde_json::Value = serde_json::from_str(ok.trim()).expect("parse");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"]["id"], "ws-1");
        assert!(parsed.get("code").is_none());

        let failed = encode_response(&AgentResponse::failed(AgentError::new(
            "WORKTREE_EXISTS",
            "That branch already has a worktree",
            "Pass a different branch, or attach to the existing workstream",
        )));
        let parsed: serde_json::Value = serde_json::from_str(failed.trim()).expect("parse");
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["code"], "WORKTREE_EXISTS");
        assert!(parsed["hint"].as_str().is_some_and(|hint| !hint.is_empty()));
    }

    /// The spike sent 512 KiB on one line intact, so no length-prefix framing is
    /// needed — but a payload containing a newline would silently split the
    /// frame, so encoding must escape it.
    #[test]
    fn a_large_payload_with_newlines_stays_one_frame() {
        let body = format!("{}\n{}", "y".repeat(256 * 1024), "z".repeat(256 * 1024));
        let encoded = encode_request(&AgentRequest {
            cmd: "ws.create".to_string(),
            params: serde_json::json!({ "blob": body }),
            token: None,
        });
        assert_eq!(
            encoded.matches('\n').count(),
            1,
            "an embedded newline must not split the frame"
        );
        let decoded = decode_request(&encoded).expect("decode");
        assert_eq!(decoded.params["blob"], body);
    }
}
