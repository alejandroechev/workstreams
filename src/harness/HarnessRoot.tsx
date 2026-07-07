// @test-skip: dev/E2E-only harness scaffolding; interactivity covered by the Playwright harness + e2e/tests/comment-interactivity.spec.ts, not jsdom.
import type { FC } from "react";

import { harnessCases } from "./cases";

/**
 * Dev/E2E-only harness root. Reads `?harness=<caseId>` from the URL and mounts
 * that single case full-viewport; with no (or an unknown) id it renders an
 * index of available cases. Never imported by the production `main.tsx` path
 * (guarded behind `import.meta.env.VITE_E2E` / `DEV` + a dynamic import).
 */
export const HarnessRoot: FC = () => {
  const id = new URLSearchParams(window.location.search).get("harness");
  const found = id ? harnessCases[id] : undefined;

  if (found) {
    const { Component } = found;
    return <Component />;
  }

  return (
    <div
      data-testid="harness-index"
      style={{
        position: "fixed",
        inset: 0,
        background: "#1e1e2e",
        color: "#cdd6f4",
        fontFamily: "system-ui, sans-serif",
        padding: 24,
      }}
    >
      <h1 style={{ fontSize: 18 }}>UI harness cases</h1>
      {id && <p style={{ color: "#f38ba8" }}>Unknown case: {id}</p>}
      <ul>
        {Object.entries(harnessCases).map(([key, c]) => (
          <li key={key} style={{ margin: "6px 0" }}>
            <a data-testid={`harness-link-${key}`} href={`?harness=${key}`} style={{ color: "#89b4fa" }}>
              {key}
            </a>
            {" — "}
            {c.title}
          </li>
        ))}
      </ul>
    </div>
  );
};
