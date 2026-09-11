import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveEodRunnerCodeRevision } from "../src/eod-runner-revision";

const approved = "a".repeat(40), laterMain = "b".repeat(40);
describe("approved production runner revision", () => {
  it("retains the approved actual code when an unrelated main commit triggers daily jobs", () => {
    expect(resolveEodRunnerCodeRevision({ actualRevision: approved, productionRevision: approved,
      codeRevision: approved, githubSha: laterMain })).toBe(approved);
  });
  it("preserves unpinned main checkout fallback while refusing a falsely claimed execution SHA", () => {
    expect(resolveEodRunnerCodeRevision({ actualRevision: laterMain, githubSha: laterMain })).toBe(laterMain);
    for (const value of [
      { actualRevision: laterMain, productionRevision: approved, githubSha: laterMain },
      { actualRevision: approved, productionRevision: approved, codeRevision: laterMain },
      { actualRevision: approved, productionRevision: "main" },
      { actualRevision: approved, githubSha: laterMain },
    ]) expect(() => resolveEodRunnerCodeRevision(value)).toThrow("code-revision-mismatch");
  });
  it.each(["eod-market-data.yml", "eod-monitor.yml"])("pins %s checkout and declared revision to the same approved environment value", (name) => {
    const workflow = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
    expect(workflow).toContain("ref: ${{ vars.EOD_PRODUCTION_CODE_REVISION || github.sha }}");
    expect(workflow).toContain("EOD_CODE_REVISION: ${{ vars.EOD_PRODUCTION_CODE_REVISION || github.sha }}");
    expect(workflow).toContain("EOD_PRODUCTION_CODE_REVISION: ${{ vars.EOD_PRODUCTION_CODE_REVISION }}");
  });
});
