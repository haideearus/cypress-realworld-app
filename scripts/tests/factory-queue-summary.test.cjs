const assert = require("node:assert/strict");
const test = require("node:test");
const { queueSummary } = require("../factory/queue-summary.cjs");

const state = (tickets, grants = {}) => ({ tickets, grants, audit: [] });

test("blocked queue shows the saved attempt and delayed retry without exposing feedback", () => {
  const text = queueSummary(
    state(
      {
        109: {
          origin: "factory",
          status: "blocked",
          coding: 1,
          reviews: 0,
          retries: 0,
          delayedRetry: { grantId: "old-grant", notBefore: "2026-11-20T10:30:00.000Z" },
          feedback: "A private diagnostic",
        },
        110: { origin: "factory", status: "reviewed", coding: 1, reviews: 1, retries: 0 },
      },
      { a: { ticket: 109, runId: "44423456789", at: "2026-11-20T10:00:00.000Z" } }
    ),
    { priorityRetry: true }
  );
  assert.match(text, /issues\/109/);
  assert.match(text, /actions\/runs\/44423456789/);
  assert.match(text, /2026-11-20T10:30:00.000Z/);
  assert.match(text, /1 coding \/ 0 review \/ 0 retries/);
  assert.doesNotMatch(text, /private diagnostic|issues\/110/);
});

test("blocked published and dependency tickets direct operators to their existing PR and evidence", () => {
  const text = queueSummary(
    state({
      124: { origin: "factory", status: "blocked", pr: 126, ci: { runId: 44424998888 } },
      137: { origin: "dependency", dependency: {}, status: "blocked", pr: 137 },
    }),
    { priorityRetry: true }
  );
  assert.match(text, /issues\/124/);
  assert.match(text, /pull\/126/);
  assert.match(text, /actions\/runs\/44424998888/);
  assert.match(text, /exact PR commit/);
  assert.match(text, /pull\/137/);
  assert.doesNotMatch(text, /issues\/137/);
});

test("blocked ticket without a recovery receipt never displays an automatic retry as scheduled", () => {
  const text = queueSummary(
    state({
      109: { origin: "factory", status: "blocked", coding: 1 },
    }),
    { priorityRetry: true }
  );
  assert.match(text, /No automatic retry is scheduled/);
  assert.match(text, /inspect the failed stage/);
});
