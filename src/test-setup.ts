// @test-skip: vitest setup file — runs once per test process, no logic to test
import { configure } from "@testing-library/dom";

// Default asyncUtilTimeout (1s) is too tight for tests that wait on
// lazy-loaded Monaco editors and other dynamic imports under coverage
// instrumentation. Bumping to 5s removes the timing-related flakiness
// without changing test semantics.
configure({ asyncUtilTimeout: 5000 });
