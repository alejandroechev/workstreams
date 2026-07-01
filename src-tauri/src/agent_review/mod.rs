// @test-skip: module wiring only; logic + tests live in anchor.rs
//! Local Agent Review (ADR 013) — reviewer↔agent loop.
//!
//! `anchor` is the pure, unit-tested trackability engine (spike-proven).
//! Backend commands (create/submit-round/list/reply/resolve/complete) and the
//! git IO + re-anchor sweep will be added on top in later phases.

// TODO(review-backend): remove this once the backend consumes the anchor
// engine. Until then the pure functions are exercised only by their unit tests
// + the .dev/anchor-probe, so the crate build would otherwise warn dead_code.
#![allow(dead_code)]

pub mod anchor;
