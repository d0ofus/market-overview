import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

test("overview charts remain visible when usable history is behind the expected session", () => {
  const groupPanel = source("../components/group-panel.tsx");
  assert.doesNotMatch(groupPanel, /HistoryFreshnessBadge/);
  assert.doesNotMatch(groupPanel, /hasHistoricalMetrics/);
  assert.match(groupPanel, /row\.sparkline\?\.length/);
  assert.match(groupPanel, /row\.relativeStrength30dVsSpy\?\.length/);
});

test("ticker freshness uses compact accessible icon tooltips", () => {
  const groupPanel = source("../components/group-panel.tsx");
  assert.doesNotMatch(groupPanel, /QuoteFreshnessBadge/);
  assert.match(groupPanel, /<OverviewFreshnessIndicators row=\{row\} \/>\s*<button/);
  assert.match(groupPanel, /className=\{`inline-flex h-5 w-5/);
  assert.match(groupPanel, /className=\{`h-3 w-3/);
  assert.match(groupPanel, /role="tooltip"/);
  assert.match(groupPanel, /aria-describedby=\{position \? tooltipId : undefined\}/);
  assert.match(groupPanel, /createPortal\(/);
});

test("overview diagnostics use one disclosure that is collapsed initially", () => {
  const disclosure = source("../components/overview-freshness-disclosure.tsx");
  const page = source("../app/page.tsx");
  assert.match(disclosure, /defaultOpen=\{false\}/);
  assert.match(disclosure, /QuoteFreshnessAudit/);
  assert.match(page, /OverviewFreshnessDisclosure/);
  assert.doesNotMatch(page, /OverviewFreshnessBanner/);
});

test("floating navigation remains horizontally scrollable without a visible scrollbar", () => {
  const navigation = source("../components/floating-section-nav.tsx");
  const styles = source("../app/globals.css");
  assert.match(navigation, /scrollbar-none[^\"]*overflow-x-auto/);
  assert.match(styles, /\.scrollbar-none/);
  assert.match(styles, /scrollbar-width:\s*none/);
  assert.match(styles, /::-webkit-scrollbar/);
});

test("commentary keeps provider failures out of the default report panel", () => {
  const commentary = source("../components/market-commentary-panel.tsx");
  assert.doesNotMatch(commentary, /activeStatus === "failed" && \(/);
  assert.doesNotMatch(commentary, /activeWarning && activeStatus !== "failed"/);
  assert.match(commentary, /Latest refresh attempt/);
  assert.match(commentary, /queueRefreshPageData\("market-commentary"\)/);
  assert.match(commentary, /Waiting for Overview publication/);
});

test("Fed countdown has a hydration-stable placeholder and explicit timestamp timezone", () => {
  const fedFunds = source("../components/fed-funds-rate-panel.tsx");
  assert.match(fedFunds, /useState<number \| null>\(null\)/);
  assert.match(fedFunds, /if \(!nextMeeting\?\.meetingIso \|\| now == null\) return "--"/);
  assert.match(fedFunds, /setNow\(Date\.now\(\)\)/);
  assert.match(fedFunds, /timeZone: "UTC"/);
  assert.doesNotMatch(fedFunds, /suppressHydrationWarning/);
});

test("FOMC commentary shows the official rate decision and only claims cited Brave context", () => {
  const fedFunds = source("../components/fed-funds-rate-panel.tsx");
  assert.match(fedFunds, /Decision:/);
  assert.match(fedFunds, /group\.rateDecision/);
  assert.match(fedFunds, /groupFomcCommentaryItems\(items, 2\)/);
  assert.match(fedFunds, /Official FOMC statement/);
  assert.match(fedFunds, /Official press conference transcript/);
  assert.match(fedFunds, /Official opening statement/);
  assert.match(fedFunds, /citations\.some\(\(source\) => source\.usedFor === "context" \|\| source\.usedFor === "fallback"\)/);
});
