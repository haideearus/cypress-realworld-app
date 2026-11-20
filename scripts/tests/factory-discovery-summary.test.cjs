const test = require("node:test");
const assert = require("node:assert/strict");
const functional = require("../factory/discovery-functional.cjs");
const { digest } = require("../factory/discovery-contract.cjs");

function isolatedResult(code, log = code === 1 ? "not ok 1 - approved functional scenario" : "") {
  return {
    code,
    networkIsolated: true,
    exitState: code === 0 ? null : { status: "exited", exitCode: code, oomKilled: code === 137 },
    log,
    logHash: digest(log),
  };
}
const { explorationSummary, intakeSummary } = require("../factory/discovery-summary.cjs");

test("exploration reports executed input cases and replay decisions without echoing model text", () => {
  const charter = "functional-feed";
  const oracle = {
    kind: "feed-pagination",
    route: "/transactions/public",
    authenticated: true,
    query: { page: 2, limit: 5 },
  };
  const finding = {
    oracle,
    test: "marker-do-not-echo.api.test.cjs",
    mode: "api",
    title: "[model link](https://example.invalid/)",
    summary: "\n# fabricated",
  };
  const result = explorationSummary({
    charter,
    bundle: {
      batches: [
        {
          number: 1,
          test: functional.proposal(charter, oracle),
          result: isolatedResult(1, "not ok 1 - approved functional scenario\nmarker-do-not-echo"),
        },
        {
          number: 2,
          test: functional.proposal(charter, { ...oracle, query: { page: 3, limit: 4 } }),
          result: isolatedResult(0),
        },
      ],
      report: { checked: ["marker-do-not-echo"], skipped: ["marker-do-not-echo"] },
    },
    assessment: {
      findings: [{ finding, status: "held", reason: "nonreproducing-or-flaky" }],
    },
  });
  assert.match(result, /page 2, limit 5.*exited unsuccessfully/i);
  assert.match(result, /page 3, limit 4.*passed/i);
  assert.match(result, /Skipped coverage[\s\S]*directory search[\s\S]*2 unused/i);
  assert.match(result, /held.*did not reproduce the failure consistently/i);
  assert.doesNotMatch(result, /marker-do-not-echo|example\.invalid|fabricated/);
});

test("directory exploration describes the executed search without publishing its literal input", () => {
  const charter = "functional-directory";
  const oracle = {
    kind: "unexpected-server-error",
    route: "/users/search",
    authenticated: true,
    query: { q: "Synthetic Query" },
  };
  const result = explorationSummary({
    charter,
    bundle: {
      batches: [
        {
          number: 1,
          test: functional.proposal(charter, oracle),
          result: isolatedResult(0),
        },
      ],
    },
    assessment: { findings: [] },
  });
  assert.match(result, /directory search.*15-character.*passed/i);
  assert.match(result, /no findings/i);
  assert.doesNotMatch(result, /Synthetic Query/);
});

test("finding intake links only issue numbers from retained publication and displays coding readiness", () => {
  const row = {
    candidate: {
      oracle: { kind: "feed-pagination", query: { page: 2, limit: 5 } },
      title: "[click](https://example.invalid)",
    },
    status: "published",
    publication: { issue: 92, html_url: "https://example.invalid/issue" },
    intake: { outcome: "ready" },
  };
  const result = intakeSummary("ready", {
    sourceRun: "574",
    findings: [
      { row },
      { row: { ...row, status: "held-quota", publication: null, intake: null } },
      { row, duplicate: true },
    ],
  });
  assert.match(result, /\/actions\/runs\/574/);
  assert.match(
    result,
    /ready for coding.*\[#92\]\(https:\/\/github\.com\/haideearus\/cypress-realworld-app\/issues\/92\)/i
  );
  assert.match(result, /held.*quota/i);
  assert.match(result, /duplicate/i);
  assert.doesNotMatch(result, /example\.invalid/);
});

test("the intake replay summary identifies which source scenario was rerun", () => {
  const result = intakeSummary("ready", {
    sourceRun: "574",
    replayed: { oracle: { kind: "feed-pagination", query: { page: 2, limit: 5 } } },
  });
  assert.match(result, /Current-main replay[\s\S]*page 2, limit 5/i);
  assert.match(result, /Skipped coverage[\s\S]*other source scenarios/i);
});

test("repeated and timed-out cases cannot make shallow exploration look complete", () => {
  const charter = "functional-feed";
  const batch = (page, code) => ({
    test: functional.proposal(charter, {
      kind: "feed-pagination",
      route: "/transactions/public",
      authenticated: true,
      query: { page, limit: 5 },
    }),
    result: isolatedResult(code),
  });
  const summary = (batches) =>
    explorationSummary({
      charter,
      bundle: { batches },
      assessment: { findings: [] },
    });
  assert.match(summary([batch(1, 0), batch(1, 0), batch(2, 124)]), /1 distinct case.*partial/i);
  assert.match(summary([batch(1, 0), batch(2, 1), batch(3, 0)]), /3 distinct cases.*target met/i);
  assert.match(summary([batch(1, 0), batch(2, 125), batch(3, 137)]), /1 distinct case.*partial/i);
  const earlyExit = { ...batch(2, 1), result: isolatedResult(1, "runner could not start test") };
  assert.match(summary([batch(1, 0), earlyExit]), /1 distinct case.*partial/i);
});
