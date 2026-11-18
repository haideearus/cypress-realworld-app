const test = require("node:test"),
  assert = require("node:assert/strict");
const a = require("../factory/artifacts.cjs"),
  p = require("../factory/policy.cjs"),
  w = require("../factory/worker.cjs");
const { vars, context } = require("./helpers/factory-fixtures.cjs");
const head = "2ad9a70529ee28c4d14fca0bccbe122837ea143f";
const summary =
  "Reviewed scripts/factory/discovery-recovery-run.cjs and artifact provenance against the recovery criteria; the supplied CI covers policy regressions, while live recovery remains unexecuted.";
const valid = () => ({ head, verdict: "pass", summary, findings: [] });
function priorPass() {
  let state = p.emptyState(p.REPOSITORY);
  const config = p.readConfig({ ...vars, FACTORY_MAX_REVIEWS_PER_TICKET: "10" });
  for (const [index, runId] of ["44288249555", "44296391691"].entries()) {
    const reserved = p.reserve(
      state,
      {
        ...context,
        head,
        ticket: 93,
        pr: 94,
        phase: "review",
        slot: "existing",
        origin: "owner-pr",
        runId,
      },
      config,
      new Date("2026-11-18T11:38:00Z")
    );
    state = p.finish(
      reserved.state,
      reserved.grant.id,
      {
        status: index ? "reviewed" : "blocked",
        ...(index
          ? {
              head,
              pr: 94,
              verdict: "pass",
              evidence: `https://github.com/${p.REPOSITORY}/actions/runs/${runId}`,
            }
          : {}),
      },
      new Date("2026-11-18T11:57:00Z")
    );
  }
  state.tickets["93"].feedback = JSON.stringify({
    head,
    verdict: "pass",
    summary: "test",
    findings: [{ severity: "minor", message: "test" }],
  });
  return state;
}

test("actual pass/test artifact is refused by collector without inventing a replacement review", () => {
  const result = {
    head,
    verdict: "pass",
    summary: "test",
    findings: [{ severity: "minor", message: "test" }],
  };
  assert.throws(() => a.validateReview(result, head), /review|placeholder/i);
  assert.throws(
    () => w.collectReview({ grantId: "d3bf69b7-e8c8-41c9-a2ea-9e0e7b163fde", head, result }),
    /review|placeholder/i
  );
});
test("padding, Unicode formatting and a placeholder finding cannot turn samples into review evidence", () => {
  for (const text of [
    "test",
    " TEST!!! ",
    "ＴＥＳＴ",
    "t\u200be\u200bs\u200bt",
    "test ".repeat(30),
    "This is a test review with a sample summary and a placeholder finding message.",
    "OK",
    "No blocking findings",
  ])
    assert.throws(
      () => a.validateReview({ ...valid(), summary: text }, head),
      /review|placeholder/i
    );
  for (const message of [
    "test",
    "minor issue",
    "test ".repeat(15),
    "This is a test finding with a sample message for a review.",
  ])
    assert.throws(
      () => a.validateReview({ ...valid(), findings: [{ severity: "minor", message }] }, head),
      /review|placeholder/i
    );
});
test("genuine scope reasoning and honest concrete blockers remain valid", () => {
  assert.equal(a.validateReview(valid(), head).verdict, "pass");
  assert.equal(
    a.validateReview(
      {
        ...valid(),
        verdict: "changes_requested",
        summary:
          "The recovery collector accepts placeholder summaries in artifacts.cjs; this defeats the required independent review evidence despite valid commit identity.",
        findings: [
          {
            severity: "important",
            message:
              "scripts/factory/artifacts.cjs accepts sample output as approval; reject placeholder text before storing the review artifact.",
          },
        ],
      },
      head
    ).verdict,
    "changes_requested"
  );
});
test("retained placeholder approval cannot satisfy the gate and both consumed reviews remain immutable", () => {
  const state = priorPass(),
    saved = structuredClone(state);
  assert.doesNotThrow(() => p.validateState(state));
  assert.equal(p.reviewGate(state, { number: 94, head }).ok, false);
  assert.deepEqual(state, saved);
  assert.equal(state.tickets["93"].reviews, 2);
  assert.equal(Object.values(state.grants).length, 2);
  const sound = structuredClone(state);
  sound.tickets["93"].feedback = JSON.stringify(valid());
  assert.equal(p.reviewGate(sound, { number: 94, head }).ok, true);
  for (const feedback of [
    undefined,
    "not json",
    JSON.stringify({ ...valid(), head: "a".repeat(40) }),
    JSON.stringify({ ...valid(), verdict: "changes_requested" }),
  ]) {
    const changed = structuredClone(sound);
    changed.tickets["93"].feedback = feedback;
    assert.equal(p.reviewGate(changed, { number: 94, head }).ok, false);
  }
});
test("schema and prompt require a substantive final review without expanding read-only permissions", () => {
  assert.ok(a.REVIEW_SCHEMA.properties.summary.minLength >= 60);
  assert.ok(a.REVIEW_SCHEMA.properties.findings.items.properties.message.minLength >= 30);
  const prompt = w.promptFor("review", head);
  assert.match(prompt, /placeholder|sample/i);
  assert.match(prompt, /repository paths|file paths/i);
  assert.match(prompt, /findings.*\[\]/i);
  assert.match(prompt, /Do not write files or execute code/);
});
test("natural sample-only sentences cannot exploit a few unfamiliar filler words", () => {
  for (const text of [
    "This is a sample review response generated only for testing the structured JSON output.",
    "Here is a fabricated review response with randomly chosen words solely to exercise schema acceptance.",
    "Here�s an illustrative sample review response, written solely as a schema demonstration.",
  ]) {
    assert.throws(
      () => a.validateReview({ ...valid(), summary: text }, head),
      /review|placeholder/i
    );
    const state = priorPass();
    state.tickets["93"].feedback = JSON.stringify({ ...valid(), summary: text });
    assert.equal(p.reviewGate(state, { number: 94, head }).ok, false);
  }
});
