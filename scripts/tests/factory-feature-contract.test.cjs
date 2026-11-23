const test = require("node:test");
const assert = require("node:assert/strict");
const feature = require("../factory/feature-contract.cjs");

const head = "a".repeat(40);
const proposal = {
  size: "minor",
  title: "Describe the amount range reset",
  problem: "The amount range form offers a Clear button without identifying what it resets.",
  benefit:
    "A screen reader user can find and reset the amount range while keeping the date filter.",
  evidence: {
    kind: "source",
    path: "src/components/TransactionListAmountRangeFilter.tsx",
    quote: 'data-test="transaction-list-filter-amount-clear-button"',
  },
  steps: [
    {
      title: "Describe the amount range reset",
      scope: "Give the current reset action an accessible name that identifies the amount range.",
      acceptance: [
        "With both filters selected, activating Clear amount range removes only the amount restriction.",
      ],
    },
  ],
};

test("the weekly limit follows Bucharest Monday across the DST change", () => {
  assert.equal(feature.weekKey(new Date("2026-10-25T21:59:59Z")), "2026-10-19");
  assert.equal(feature.weekKey(new Date("2026-10-25T22:00:00Z")), "2026-10-26");
  assert.equal(feature.weekKey(new Date("2026-08-16T21:00:00Z")), "2026-08-17");
});

test("proposals require bounded acceptance and protected product evidence", () => {
  assert.equal(feature.validateProposal(proposal), proposal);
  assert.throws(
    () =>
      feature.validateProposal({
        ...proposal,
        evidence: { ...proposal.evidence, path: ".github/workflows/main.yml" },
      }),
    /evidence/i
  );
  assert.throws(
    () =>
      feature.validateProposal({ ...proposal, steps: [{ ...proposal.steps[0], acceptance: [] }] }),
    /acceptance/i
  );
  assert.throws(() => feature.validateProposal({ ...proposal, command: "arbitrary" }), /proposal/i);
});

test("a single major can have several uniquely titled reviewable slices", () => {
  const stage = {
    ...proposal.steps[0],
    title: "Show the remaining date range",
  };
  const major = { ...proposal, size: "major", steps: [proposal.steps[0], stage] };
  assert.equal(feature.validatePlan([major]).length, 1);
  assert.throws(
    () => feature.validatePlan([major, { ...major, title: "Another major idea" }]),
    /weekly/i
  );
  assert.throws(() => feature.validatePlan([major, proposal]), /duplicate/i);
  assert.throws(() => feature.validateProposal({ ...major, steps: [stage, stage] }), /duplicate/i);
});

test("a receipt binds the bot identity, issue number, criteria and immutable proposal", () => {
  const key = feature.proposalKey(proposal);
  const row = {
    proposal,
    week: "2026-11-23",
    producer: { mode: "pilot", head, runId: "2" },
    parent: null,
    stages: [{ phase: "ready", issue: 3 }],
  };
  const receipt = feature.receiptFor(key, row, 0);
  const issue = {
    ...feature.issueFields(key, row, 0),
    number: 3,
    state: "open",
    labels: [{ name: "factory-ready" }],
    user: { login: "github-actions[bot]", type: "Bot", id: 41898282 },
  };
  assert.equal(feature.issueMatches(issue, key, row, 0, true), true);
  assert.equal(feature.issueMatches({ ...issue, number: 4 }, key, row, 0, true), false);
  assert.equal(
    feature.issueMatches({ ...issue, user: { ...issue.user, id: 9 } }, key, row, 0, true),
    false
  );
  assert.equal(
    feature.issueMatches({ ...issue, body: issue.body + "\nChanged" }, key, row, 0, true),
    false
  );
  assert.equal(receipt.issue, 3);
  assert.equal(receipt.key, key);
});

module.exports = { proposal };
