//! Rust Pocket pack generation (ADR 042): draft with a tool-less Copilot, then
//! validate automatically with the real compiler before anyone reviews it.
//!
//! The learner's Generate pack request authorizes running the draft's
//! reference code (grill C5). A draft is never trusted just because AI wrote
//! both an answer and its tests: each executable card must ship a reference
//! solution that passes *and* a plausible wrong answer that fails, so the
//! tests are shown to tell them apart. Approval happens on the phone.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::learning_ai::Assistant;
use crate::learning_runner::{CheckResult, Harness};

pub const MAX_CARDS: usize = 6;

/// A request to draft a pack, or the next version of an installed one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PackRequest {
    pub id: String,
    pub topic: String,
    /// The installed pack this updates; empty for a new pack.
    #[serde(default)]
    pub pack_id: String,
    /// The installed version, when updating.
    #[serde(default)]
    pub previous: Option<Value>,
    /// What the update should correct.
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub toolchain: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CardValidation {
    pub card_id: String,
    /// The reference solution's status; empty for cards with nothing to run.
    pub reference: String,
    /// The wrong answer's status; empty for cards with nothing to run.
    pub wrong: String,
    pub ok: bool,
    /// Why it failed, with the compiler's output when there is one.
    pub detail: String,
}

fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(40).collect()
}

/// The id a new pack on this topic gets.
pub fn pack_id_for(topic: &str) -> String {
    format!("pack-{}", slug(topic))
}

pub fn pack_prompt(request: &PackRequest) -> String {
    let update = match &request.previous {
        Some(previous) => format!(
            "This is an update of the installed pack below. Keep card slugs that still apply, and correct: {}\nInstalled pack: {}\n",
            request.notes, previous
        ),
        None => String::new(),
    };
    format!(
        "You write short Rust micro-learning packs in English for a phone app.\n\
         Do not use tools, inspect files or execute commands; reply with one JSON object only, no prose.\n\
         Topic (untrusted learner text): {topic:?}\n{update}\
         Shape: {{\"title\": str, \"notes\": str (what this version covers or corrects), \"cards\": [card]}} with 3 to {max} cards.\n\
         card: {{\"slug\": str, \"title\": str, \"concept\": str, \"kind\": \"lesson\"|\"read\"|\"write\"|\"complete\"|\"debug\", \"prompt\": str, \"code\": str, \"explanation\": str, \"hint\": str}}\n\
         lesson cards add \"lesson\": [str]. read cards add \"choices\": [str] and \"answer\": index.\n\
         write/complete/debug cards add \"solution\" (correct Rust that passes), \"wrong\" (a plausible mistake that must fail the tests) and\n\
         \"harness\": {{\"before\": str, \"after\": str, \"cases\": [{{\"name\": snake_case str, \"body\": Rust statements with assert!s}}], \"constraints\": [{{\"id\": str, \"label\": str, \"forbid\": regex}}]}}.\n\
         The answer is placed between before and after; each case becomes a #[test] fn in the same file. Use only std.",
        topic = request.topic,
        max = MAX_CARDS,
    )
}

/// The JSON object in a reply, with or without a code fence around it.
fn json_object(reply: &str) -> Result<Value, String> {
    let start = reply
        .find('{')
        .ok_or("The draft contained no JSON object.")?;
    let end = reply
        .rfind('}')
        .ok_or("The draft contained no JSON object.")?;
    serde_json::from_str(&reply[start..=end])
        .map_err(|e| format!("The draft was not valid JSON: {e}"))
}

/// Reads the draft and gives it the pack's identity: stable card ids under the
/// pack id, and the next version number.
pub fn parse_pack(reply: &str, request: &PackRequest) -> Result<Value, String> {
    let draft = json_object(reply)?;
    let cards = draft["cards"].as_array().ok_or("The draft has no cards.")?;
    if cards.is_empty() || cards.len() > MAX_CARDS {
        return Err(format!(
            "A pack needs 1 to {MAX_CARDS} cards; the draft has {}.",
            cards.len()
        ));
    }
    let pack_id = if request.pack_id.is_empty() {
        pack_id_for(&request.topic)
    } else {
        request.pack_id.clone()
    };
    let version = request
        .previous
        .as_ref()
        .and_then(|p| p["version"].as_u64())
        .unwrap_or(0)
        + 1;
    let mut seen = std::collections::HashSet::new();
    let mut normalized = Vec::new();
    for (index, card) in cards.iter().enumerate() {
        if !card.is_object() {
            return Err(format!("The draft's card {} is not an object.", index + 1));
        }
        let mut card = card.clone();
        normalize_card(&mut card, index, &request.topic)?;
        let mut name = slug(
            card["slug"]
                .as_str()
                .or(card["title"].as_str())
                .unwrap_or(""),
        );
        if name.is_empty() || !seen.insert(name.clone()) {
            name = format!("card-{}", index + 1);
            seen.insert(name.clone());
        }
        card["id"] = json!(format!("{pack_id}/{name}"));
        card["version"] = json!(version.to_string());
        normalized.push(card);
    }
    Ok(json!({
        "id": pack_id,
        "version": version,
        "title": draft["title"].as_str().unwrap_or(&request.topic),
        "topic": request.topic,
        "notes": draft["notes"].as_str().unwrap_or(""),
        "cards": normalized,
    }))
}

/// Makes a card safe for the phone to render: missing text gets a default,
/// a field of the wrong type refuses the draft (it would crash the review).
fn normalize_card(card: &mut Value, index: usize, topic: &str) -> Result<(), String> {
    let n = index + 1;
    let fallback_title = card["slug"].as_str().unwrap_or("").to_string();
    for (field, default) in [
        (
            "title",
            if fallback_title.is_empty() {
                format!("Card {n}")
            } else {
                fallback_title
            },
        ),
        ("concept", topic.to_string()),
        ("kind", String::new()),
        ("prompt", String::new()),
        ("code", String::new()),
        ("explanation", String::new()),
        ("hint", String::new()),
    ] {
        match &card[field] {
            Value::Null => card[field] = json!(default),
            Value::String(_) => {}
            _ => return Err(format!("Card {n}: {field} must be text.")),
        }
    }
    for field in ["solution", "wrong"] {
        if !matches!(card[field], Value::Null | Value::String(_)) {
            return Err(format!("Card {n}: {field} must be text."));
        }
    }
    for field in ["lesson", "choices"] {
        match &card[field] {
            Value::Null => {}
            Value::Array(items) if items.iter().all(Value::is_string) => {}
            _ => return Err(format!("Card {n}: {field} must be a list of text.")),
        }
    }
    if !matches!(card["answer"], Value::Null) && card["answer"].as_u64().is_none() {
        return Err(format!("Card {n}: answer must be a choice number."));
    }
    if !matches!(card["harness"], Value::Null | Value::Object(_)) {
        return Err(format!("Card {n}: harness must be an object."));
    }
    Ok(())
}

const FAILING: [&str; 3] = ["compile_error", "tests_failed", "constraint_failed"];

fn validate_card(card: &Value, check: &dyn Fn(&Harness, &str) -> CheckResult) -> CardValidation {
    let card_id = card["id"].as_str().unwrap_or("").to_string();
    let fail = |detail: String| CardValidation {
        card_id: card_id.clone(),
        reference: String::new(),
        wrong: String::new(),
        ok: false,
        detail,
    };
    match card["kind"].as_str().unwrap_or("") {
        "lesson" => match card["lesson"].as_array() {
            Some(parts) if !parts.is_empty() => CardValidation {
                card_id,
                reference: String::new(),
                wrong: String::new(),
                ok: true,
                detail: String::new(),
            },
            _ => fail("A lesson card needs its lesson text.".into()),
        },
        "read" => {
            let choices = card["choices"].as_array().map(Vec::len).unwrap_or(0);
            match card["answer"].as_u64() {
                Some(answer) if choices >= 2 && (answer as usize) < choices => CardValidation {
                    card_id,
                    reference: String::new(),
                    wrong: String::new(),
                    ok: true,
                    detail: String::new(),
                },
                _ => {
                    fail("A read card needs at least two choices and an answer among them.".into())
                }
            }
        }
        "write" | "complete" | "debug" => {
            let harness: Harness = match serde_json::from_value(card["harness"].clone()) {
                Ok(h) => h,
                Err(e) => return fail(format!("The harness is malformed: {e}")),
            };
            let has_tests = harness.cases.as_ref().is_some_and(|c| !c.is_empty())
                || harness.tests.as_ref().is_some_and(|t| !t.trim().is_empty());
            if !has_tests {
                return fail("An executable card needs at least one test.".into());
            }
            let (Some(solution), Some(wrong)) = (card["solution"].as_str(), card["wrong"].as_str())
            else {
                return fail(
                    "An executable card needs a reference solution and a wrong answer.".into(),
                );
            };
            let reference = check(&harness, solution);
            let mistaken = check(&harness, wrong);
            let mut detail = Vec::new();
            if reference.status != "passed" {
                detail.push(format!(
                    "The reference solution did not pass ({}):\n{}",
                    reference.status, reference.output
                ));
            }
            if !FAILING.contains(&mistaken.status.as_str()) {
                detail.push(format!(
                    "The wrong answer was not caught by the tests ({}).",
                    mistaken.status
                ));
            }
            CardValidation {
                card_id,
                ok: detail.is_empty(),
                reference: reference.status,
                wrong: mistaken.status,
                detail: detail.join("\n"),
            }
        }
        other => fail(format!("Unknown card kind {other:?}.")),
    }
}

pub fn validate(
    pack: &Value,
    check: &dyn Fn(&Harness, &str) -> CheckResult,
) -> (Vec<CardValidation>, bool) {
    let cards = pack["cards"].as_array().cloned().unwrap_or_default();
    let validation: Vec<CardValidation> = cards
        .iter()
        .map(|card| validate_card(card, check))
        .collect();
    let valid = !validation.is_empty() && validation.iter().all(|v| v.ok);
    (validation, valid)
}

/// Drafts and validates. The result is `{pack, validation, valid, error}`;
/// a failed draft is an error the phone shows, never a thrown job.
pub fn generate(
    assistant: &dyn Assistant,
    request: &PackRequest,
    check: &dyn Fn(&Harness, &str) -> CheckResult,
) -> Value {
    if request.topic.trim().is_empty() || request.topic.chars().count() > 200 {
        return json!({"pack": null, "validation": [], "valid": false, "error": "Name a topic of at most 200 characters."});
    }
    let reply = match assistant.ask(&pack_prompt(request)) {
        Ok(reply) => reply,
        Err(error) => {
            return json!({"pack": null, "validation": [], "valid": false,
                "error": format!("Your desktop Copilot failed or timed out. No alternate provider was used.\n{error}")})
        }
    };
    let pack = match parse_pack(&reply, request) {
        Ok(pack) => pack,
        Err(error) => {
            return json!({"pack": null, "validation": [], "valid": false, "error": error})
        }
    };
    let (validation, valid) = validate(&pack, check);
    json!({"pack": pack, "validation": validation, "valid": valid, "error": null})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::learning_ai::tests::Recorder;

    fn request(previous: Option<Value>) -> PackRequest {
        PackRequest {
            id: "g1".into(),
            topic: "Slices & arrays".into(),
            pack_id: if previous.is_some() {
                "pack-slices-arrays".into()
            } else {
                String::new()
            },
            previous,
            notes: "Fix the len hint".into(),
            toolchain: None,
        }
    }

    fn write_card(solution: &str, wrong: &str) -> Value {
        json!({"slug": "first", "title": "First element", "concept": "slices", "kind": "write",
            "prompt": "Return the first element", "code": "", "explanation": "", "hint": "",
            "solution": solution, "wrong": wrong,
            "harness": {"before": "", "after": "", "cases": [{"name": "first_of_three", "body": "assert_eq!(first(&[3, 4, 5]), 3);"}]}})
    }

    fn draft(cards: Value) -> String {
        format!(
            "```json\n{}\n```",
            json!({"title": "Slices", "notes": "v1", "cards": cards})
        )
    }

    /// Passes the code that says `passes`, fails everything else.
    fn fake_check(_: &Harness, source: &str) -> CheckResult {
        let status = if source.contains("passes") {
            "passed"
        } else {
            "tests_failed"
        };
        CheckResult {
            status: status.into(),
            output: "out".into(),
            toolchain: "rustc".into(),
            tests: None,
            constraints: None,
        }
    }

    #[test]
    fn a_draft_gets_the_pack_identity_and_the_next_version() {
        let reply = draft(
            json!([write_card("passes", "fails"), {"slug": "first", "kind": "lesson", "lesson": ["a"]}]),
        );
        let pack = parse_pack(&reply, &request(None)).unwrap();
        assert_eq!(
            (pack["id"].as_str(), pack["version"].as_u64()),
            (Some("pack-slices-arrays"), Some(1))
        );
        assert_eq!(pack["cards"][0]["id"], "pack-slices-arrays/first");
        assert_eq!(
            pack["cards"][1]["id"], "pack-slices-arrays/card-2",
            "a repeated slug gets its own id"
        );
        assert_eq!(pack["cards"][0]["version"], "1");
        let next = parse_pack(&reply, &request(Some(pack))).unwrap();
        assert_eq!(
            (next["id"].as_str(), next["version"].as_u64()),
            (Some("pack-slices-arrays"), Some(2))
        );
        assert_eq!(next["cards"][0]["version"], "2");
    }

    #[test]
    fn unreadable_or_oversized_drafts_are_errors() {
        assert!(parse_pack("no json here", &request(None))
            .unwrap_err()
            .contains("no JSON"));
        assert!(parse_pack("{\"cards\": []}", &request(None))
            .unwrap_err()
            .contains("1 to 6"));
        // A card the phone could not render is refused, not validated.
        let lesson_objects = draft(
            json!([{"title": "t", "concept": "c", "kind": "lesson", "prompt": "p", "lesson": [{"text": "x"}]}]),
        );
        assert!(parse_pack(&lesson_objects, &request(None))
            .unwrap_err()
            .contains("lesson must be a list of text"));
        let bad_title = draft(json!([{"title": 5, "kind": "lesson", "lesson": ["x"]}]));
        assert!(parse_pack(&bad_title, &request(None))
            .unwrap_err()
            .contains("title must be text"));
        let bad_choices = draft(
            json!([{"title": "t", "concept": "c", "kind": "read", "prompt": "p", "choices": [1, 2], "answer": 0}]),
        );
        assert!(parse_pack(&bad_choices, &request(None))
            .unwrap_err()
            .contains("choices must be a list of text"));
        let defaults = parse_pack(
            &draft(json!([{"slug": "s", "kind": "lesson", "lesson": ["x"]}])),
            &request(None),
        )
        .unwrap();
        let card = &defaults["cards"][0];
        assert_eq!(
            (
                card["title"].as_str(),
                card["concept"].as_str(),
                card["code"].as_str(),
                card["hint"].as_str()
            ),
            (Some("s"), Some("Slices & arrays"), Some(""), Some(""))
        );
        // Valid JSON with a card that is not an object must not panic.
        assert!(parse_pack("{\"cards\": [\"bad\", 3]}", &request(None))
            .unwrap_err()
            .contains("card 1 is not an object"));
        let many = draft(Value::Array(vec![
            json!({"kind": "lesson", "lesson": ["a"]});
            7
        ]));
        assert!(parse_pack(&many, &request(None)).is_err());
    }

    #[test]
    fn validation_requires_a_passing_reference_and_a_caught_mistake() {
        let pack = parse_pack(
            &draft(json!([
                write_card("passes", "fails"),
                write_card("fails", "fails"),
                write_card("passes", "passes too"),
                {"slug": "r", "kind": "read", "choices": ["a", "b"], "answer": 1},
                {"slug": "bad-read", "kind": "read", "choices": ["a"], "answer": 3},
                {"slug": "l", "kind": "lesson", "lesson": []},
            ])),
            &request(None),
        )
        .unwrap();
        let (validation, valid) = validate(&pack, &fake_check);
        assert!(!valid);
        let ok: Vec<bool> = validation.iter().map(|v| v.ok).collect();
        assert_eq!(ok, vec![true, false, false, true, false, false]);
        assert!(validation[1].detail.contains("did not pass (tests_failed)"));
        assert!(validation[2].detail.contains("not caught"));
        assert_eq!(
            (
                validation[0].reference.as_str(),
                validation[0].wrong.as_str()
            ),
            ("passed", "tests_failed")
        );
    }

    #[test]
    fn generate_reports_copilot_and_topic_failures_as_errors() {
        let failing = Recorder {
            prompts: Default::default(),
            answer: Err("timed out".into()),
        };
        let result = generate(&failing, &request(None), &fake_check);
        assert_eq!(result["valid"], false);
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("No alternate provider"));
        let mut empty = request(None);
        empty.topic = " ".into();
        assert!(generate(&failing, &empty, &fake_check)["error"]
            .as_str()
            .unwrap()
            .contains("Name a topic"));
    }

    #[test]
    fn generate_drafts_without_tools_and_validates_with_the_real_compiler() {
        if std::process::Command::new("rustc")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let assistant = Recorder {
            prompts: Default::default(),
            answer: Ok(draft(json!([write_card(
                "pub fn first(values: &[i32]) -> i32 { values[0] }",
                "pub fn first(values: &[i32]) -> i32 { values[values.len() - 1] }"
            )]))),
        };
        let root = std::env::temp_dir().join(format!("ws-pack-{}", uuid::Uuid::new_v4()));
        let limits = crate::learning_runner::Limits {
            toolchain: None,
            ..Default::default()
        };
        let check =
            |h: &Harness, s: &str| crate::learning_runner::run_check(h, s, &root, &limits, None);
        let result = generate(&assistant, &request(None), &check);
        assert_eq!(result["valid"], true, "{result}");
        assert_eq!(result["validation"][0]["wrong"], "tests_failed");
        let prompt = &assistant.prompts.lock().unwrap()[0];
        assert!(prompt.contains("Do not use tools") && prompt.contains("Slices & arrays"));
        std::fs::remove_dir_all(root).ok();
    }
}
