import { expect, test } from "./fixtures";

test.use({
  demoSeed: {
    projects: [
      { name: "Atlas", directory: "/demo/atlas", color: "#89b4fa" },
    ],
    workstreams: [
      {
        name: "Synthetic planning",
        directory: "/demo/atlas/worktrees/synthetic-planning",
        project: "Atlas",
      },
    ],
  },
});

test("records synthetic state through visible controls", async ({ demo }) => {
  const row = demo.page.getByText("Synthetic planning", { exact: true });
  await demo.settled(row);
  await demo.showChapter("Deterministic demo harness", {
    description: "Synthetic data, real controls",
    duration: 600,
  });

  const toggle = demo.page.locator('[data-testid="ws-section-toggle-idle"]');
  await toggle.click();
  await expect(row).toBeHidden();
  await toggle.click();
  await demo.settled(row);
});
