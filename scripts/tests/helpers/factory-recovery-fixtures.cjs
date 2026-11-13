const seed = {
  version: 1,
  repository: "haideearus/cypress-realworld-app",
  days: {
    "2026-11-12": [11],
  },
  tickets: {
    11: {
      coding: 2,
      origin: "factory",
      reviews: 0,
      retries: 1,
      head: "4f0eb6eca04cd603a5401439d0fdcd83d8c2c4d5",
      status: "blocked",
      pr: null,
      approval: null,
      criteriaHash: "d295d714446efad9eaa6b3bd3c0c25706756dcc2d26160a191f0253438279387",
      feedback: "Agent, publication, or CI infrastructure failed; no automatic model retry",
    },
  },
  grants: {
    "503b7bc1-d82f-4bd2-84e8-fae30886f23a": {
      id: "503b7bc1-d82f-4bd2-84e8-fae30886f23a",
      ticket: 11,
      phase: "code",
      slot: "cycle1",
      runId: "43203237182",
      runAttempt: 1,
      head: "4f0eb6eca04cd603a5401439d0fdcd83d8c2c4d5",
      status: "finished",
      at: "2026-11-12T10:46:10.463Z",
      outcome: "blocked",
    },
    "2b3030da-263c-432e-9069-3f38d0778248": {
      id: "2b3030da-263c-432e-9069-3f38d0778248",
      ticket: 11,
      phase: "code",
      slot: "cycle1",
      runId: "43391969547",
      runAttempt: 1,
      head: "4f0eb6eca04cd603a5401439d0fdcd83d8c2c4d5",
      status: "finished",
      at: "2026-11-13T08:17:03.723Z",
      outcome: "blocked",
    },
  },
  active: null,
  audit: [],
};
const issue = {
  number: 11,
  title: "Fix public transaction feed pagination skipping transactions",
  body: "## Problem\n\nThe public transaction feed skips transactions between pages and reports inconsistent page counts.\n\nThis is the first small application bug for the controlled factory test.\n\n## Confirmed reproduction\n\nBaseline commit: 4f0eb6eca04cd603a5401439d0fdcd83d8c2c4d5\n\nThe existing /transactions/public handler was exercised locally with synthetic, in-memory data:\n\n- 5 contacts’ transactions: C1–C5.\n- 20 other public transactions: P1–P20.\n- Page size: 10.\n\nCurrent results:\n\n- Page 1: C1–C5 and P1–P5; totalPages = 3.\n- Page 2: P11–P20; totalPages = 2.\n- Page 3: empty; totalPages = 2.\n\nP6–P10 never appear. No deployed API or production database was contacted.\n\n## Expected behavior\n\nFor the same unchanged data:\n\n- Page 1: C1–C5 and P1–P5.\n- Page 2: P6–P15.\n- Page 3: P16–P20.\n- Every page reports totalPages = 3.\n\n## Acceptance criteria\n\n- [ ] Paginate the same ordered feed on every page.\n- [ ] Return all 25 eligible records exactly once in the reproduction above.\n- [ ] Preserve the existing priority of at most five contacts’ transactions.\n- [ ] Cover cases with zero, fewer than five, and more than five contacts’ transactions.\n- [ ] Preserve existing ordering, filters, and visibility rules.\n- [ ] Add a regression test exercising the public-route behavior. Record its failure before the fix and its success afterward.\n- [ ] Run yarn test:unit:ci, yarn types, and yarn lint. All required CI checks must pass.\n\n## Scope\n\nStart with backend/transaction-routes.ts and relevant regression tests.\n\nKeep the repair focused. Do not change dependencies, workflows, factory policy, usage limits, credentials, or deployment settings. Use synthetic local/CI data.\n\n## Controlled-test status\n\nFACTORY_ENABLED remains false. Creating this issue does not authorize agent execution, merging, or deployment.\n\nKeep Render Auto-Deploy off. No paid AI API usage or fallback provider is authorized.",
  state: "open",
};
const recoveryId = "issue-11-once-2026-11-13";
const now = new Date("2026-11-13T08:00:00Z");
function exhaustedState() {
  return structuredClone(seed);
}
function recoveryContext(overrides = {}) {
  return {
    repository: "haideearus/cypress-realworld-app",
    actor: "haideearus",
    triggeringActor: "haideearus",
    ref: "refs/heads/main",
    event: "workflow_dispatch",
    runId: "900",
    runAttempt: 1,
    ticket: 11,
    phase: "code",
    slot: "cycle1",
    head: "a".repeat(40),
    recovery: recoveryId,
    ...overrides,
  };
}
module.exports = { exhaustedState, recoveryContext, issue, recoveryId, now };
