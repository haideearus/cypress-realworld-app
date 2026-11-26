const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const feature = require("../factory/feature-contract.cjs");
const { criteriaHash } = require("../factory/controller.cjs");
const { ROOT } = require("../factory/github.cjs");

const sourceBase = "a".repeat(40);
const sourceHead = "b".repeat(40);
const base = "c".repeat(40);
const refreshedHead = "d".repeat(40);
const laterBase = "1".repeat(40);
const laterHead = "2".repeat(40);
const finalBase = "3".repeat(40);
const finalHead = "4".repeat(40);
const repo = { full_name: policy.REPOSITORY };

function featureFixture(number) {
  const proposal = {
    size: "minor",
    title: "Name the amount range clear action",
    problem: "The amount range clear button has a generic accessible name.",
    benefit: "Users can identify the amount filter before clearing it.",
    evidence: { kind: "issue", number: 8, quote: "Identify the filter being reset" },
    steps: [
      {
        title: "Name the amount range clear action",
        scope: "Give the reset button a distinct, filter-specific accessible name.",
        acceptance: ["The clear button can be found by its filter-specific accessible name."],
      },
    ],
  };
  const key = feature.proposalKey(proposal);
  const row = {
    week: "2026-11-23",
    producer: { mode: "pilot", head: sourceBase, runId: "15" },
    proposal,
    parent: null,
    stages: [{ phase: "ready", issue: number }],
  };
  return {
    issue: { ...feature.issueFields(key, row, 0), user: feature.BOT },
    receipt: feature.receiptFor(key, row, 0),
    file: {
      type: "file",
      encoding: "base64",
      content: Buffer.from(JSON.stringify({ version: 1, records: { [key]: row } })).toString(
        "base64"
      ),
    },
  };
}

function fixture({
  behind = false,
  altered = false,
  priorReviewJob,
  number = 300,
  prNumber = 301,
  firstParentRun = "800",
  fromFeature = false,
} = {}) {
  const branch = `agent/factory-${number}`;
  const featureOrigin = fromFeature ? featureFixture(number) : null;
  const issue = {
    number,
    state: "open",
    title: "Name the clear button",
    body: "Give the reset action a distinct accessible name.",
    user: { login: policy.OWNER },
    labels: [{ name: "factory-ready" }],
    created_at: "2026-11-24T18:54:00Z",
    ...featureOrigin?.issue,
  };
  const config = {
    enabled: true,
    automatic: true,
    concurrent: 1,
    reviews: 2,
    appSlug: "factory-test",
    featureMode: fromFeature ? "pilot" : "off",
  };
  const context = {
    repository: policy.REPOSITORY,
    ref: "refs/heads/main",
    actor: policy.OWNER,
    triggeringActor: policy.OWNER,
    event: "schedule",
    workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
    workflowSha: behind ? base : sourceBase,
    runId: firstParentRun,
    runAttempt: 1,
  };
  const ci = {
    requestId: "00000000-0000-4000-8000-000000000001",
    head: sourceHead,
    runId: 745,
    passed: true,
  };
  const state = {
    version: 1,
    active: null,
    audit: [],
    grants: {
      coding: {
        ticket: number,
        phase: "code",
        slot: "cycle1",
        runId: "700",
        runAttempt: 1,
        status: "finished",
        outcome: "awaiting_review",
        head: sourceBase,
      },
    },
    tickets: {
      [number]: {
        origin: "factory",
        automatic: {
          workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
          workflowSha: sourceBase,
          runId: "700",
          runAttempt: 1,
          appSlug: config.appSlug,
        },
        status: "blocked",
        coding: 1,
        reviews: 0,
        retries: 0,
        approval: null,
        pr: prNumber,
        branch,
        head: sourceHead,
        ci,
        criteriaHash: criteriaHash(issue),
        ...(featureOrigin ? { feature: featureOrigin.receipt } : {}),
      },
    },
  };
  const pr = {
    number: prNumber,
    state: "open",
    merged: false,
    draft: false,
    user: { login: "factory-test[bot]", type: "Bot" },
    head: { ref: branch, sha: sourceHead, repo },
    base: { ref: "main", sha: context.workflowSha, repo },
  };
  const files = [
    { filename: "src/components/Filter.tsx", status: "modified", sha: "e".repeat(40) },
  ];
  const calls = [];
  const ciReads = [];
  const updates = {
    [base]: { from: sourceHead, to: refreshedHead, previousBase: sourceBase },
    [laterBase]: { from: refreshedHead, to: laterHead, previousBase: base },
    [finalBase]: { from: laterHead, to: finalHead, previousBase: laterBase },
  };
  const api = {
    async request(method, path, body) {
      const target = path.slice(ROOT.length);
      calls.push([method, target, body]);
      if (target === `/issues/${number}`) return issue;
      if (target === `/pulls/${prNumber}`) return structuredClone(pr);
      if (target === "/git/ref/heads/factory/features" && featureOrigin)
        return { object: { sha: sourceBase } };
      if (target === `/contents/features.json?ref=${sourceBase}` && featureOrigin)
        return featureOrigin.file;
      if (target === "/branches/main") return { commit: { sha: context.workflowSha } };
      if (target === "/git/ref/heads/main") return { object: { sha: context.workflowSha } };
      if (target === "/actions/runs/700/attempts/1")
        return {
          id: 700,
          run_attempt: 1,
          workflow_id: 70,
          event: "schedule",
          path: ".github/workflows/factory-automatic.yml",
          status: "completed",
          conclusion: "failure",
          head_branch: "main",
          head_sha: sourceBase,
          repository: repo,
          head_repository: repo,
          actor: { login: policy.OWNER },
          triggering_actor: { login: policy.OWNER },
        };
      if (target === `/actions/runs/${firstParentRun}/attempts/1`)
        return {
          id: Number(firstParentRun),
          run_attempt: 1,
          workflow_id: 70,
          event: "schedule",
          path: ".github/workflows/factory-automatic.yml",
          status: "completed",
          conclusion: priorReviewJob ? "success" : "cancelled",
          head_branch: "main",
          head_sha: behind ? base : sourceBase,
          repository: repo,
          head_repository: repo,
        };
      if (target === "/actions/workflows/factory-automatic.yml")
        return { id: 70, path: ".github/workflows/factory-automatic.yml" };
      if (target === `/git/commits/${refreshedHead}`)
        return { sha: refreshedHead, parents: [{ sha: sourceHead }, { sha: base }] };
      if (target === `/git/commits/${laterHead}`)
        return { sha: laterHead, parents: [{ sha: refreshedHead }, { sha: laterBase }] };
      if (target === `/git/commits/${finalHead}`)
        return { sha: finalHead, parents: [{ sha: laterHead }, { sha: finalBase }] };
      if (target.startsWith("/compare/")) {
        const [left, right] = target.slice("/compare/".length).split("?")[0].split("...");
        const update = updates[left];
        const stale = update?.from === right;
        return {
          behind_by: stale ? 1 : 0,
          merge_base_commit: { sha: stale ? update.previousBase : left },
          files:
            altered && right === refreshedHead
              ? [{ ...files[0], sha: "f".repeat(40) }]
              : structuredClone(files),
        };
      }
      if (target === `/pulls/${prNumber}/update-branch`) {
        const update = updates[context.workflowSha];
        assert.deepEqual(body, { expected_head_sha: update.from });
        assert.deepEqual(state.tickets[number].publishedRecovery.refreshes.at(-1), {
          base: context.workflowSha,
          from: update.from,
        });
        pr.head.sha = update.to;
        return {};
      }
      assert.fail(`Unexpected ${method} ${target}`);
    },
    async pages(path) {
      if (path.includes("/runs?branch=main")) {
        return [
          {
            id: 746,
            run_attempt: 1,
            head_sha: context.workflowSha,
            head_branch: "main",
            event: "push",
            path: ".github/workflows/factory-ci.yml",
            status: "completed",
            conclusion: "success",
            repository: repo,
          },
        ];
      }
      if (path.includes("/746/"))
        return [{ name: "verify", head_sha: context.workflowSha, conclusion: "success" }];
      if (path.includes(`/${firstParentRun}/attempts/1/jobs`))
        return Object.entries({
          coding: "skipped",
          publish: "skipped",
          ci: "success",
          reserve_review: "success",
          review: priorReviewJob,
          assess: "success",
        })
          .filter(([, conclusion]) => conclusion !== "missing")
          .map(([name, conclusion]) => ({
            name: `cycle1 / ${name}`,
            conclusion,
            status: "completed",
          }));
      assert.match(path, /700\/attempts\/1\/jobs/);
      return Object.entries({
        "coding / agent": "success",
        publish: "success",
        ci: "success",
        reserve_review: "failure",
        review: "skipped",
      }).map(([name, conclusion]) => ({
        name: `cycle1 / ${name}`,
        conclusion,
        status: "completed",
      }));
    },
  };
  const ledger = {
    async read() {
      return { state: structuredClone(state), commit: base };
    },
    async update(fn) {
      const result = await fn(structuredClone(state));
      Object.assign(state, result.state);
      return { ...result, commit: base };
    },
  };
  const controller = {
    async validateCI(runId, head, receipt) {
      ciReads.push({ runId, head, receipt });
      return { passed: true };
    },
  };
  return {
    coordinator: { api, config, context, ledger, controller },
    state,
    calls,
    ci,
    pr,
    issue,
    ciReads,
  };
}

test("recovery reuses the passing CI and claims a review-only slot with the coding grant preserved", async () => {
  const { resumePublishedReview } = require("../factory/published-review-recovery.cjs");
  const { coordinator, state, calls, ci } = fixture();
  const coding = structuredClone(state.grants);
  const result = await resumePublishedReview(coordinator, state, base, false);
  assert.equal(result.reviewOnly, true);
  assert.equal(result.head, sourceHead);
  assert.deepEqual(state.tickets[300].ci, ci);
  assert.deepEqual(state.grants, coding);
  assert.equal(state.active.runId, "800");
  assert.equal(
    calls.some(([method]) => method === "PUT"),
    false
  );
});

test("a branch refresh that changes the verified files remains held without spending a grant", async () => {
  const { resumePublishedReview } = require("../factory/published-review-recovery.cjs");
  const { coordinator, state, calls } = fixture({ behind: true, altered: true });
  const result = await resumePublishedReview(coordinator, state, base, false);
  assert.match(result.reason, /does not preserve the original patch/);
  assert.equal(state.tickets[300].head, sourceHead);
  assert.equal(state.tickets[300].reviews, 0);
  assert.equal(state.active, null);
  assert.equal(calls.filter(([method]) => method === "PUT").length, 1);
  assert.equal((await resumePublishedReview(coordinator, state, base, false)).ready, false);
  assert.equal(calls.filter(([method]) => method === "PUT").length, 1);
});

test("a terminal recovery without a review reservation frees the slot and may reuse the same head once", async () => {
  const recovery = require("../factory/published-review-recovery.cjs");
  const { coordinator, state } = fixture();
  await recovery.resumePublishedReview(coordinator, state, base, false);
  const original = state.tickets[300].publishedRecovery.parent;
  coordinator.context.runId = "801";
  await recovery.releaseTerminalRecovery(coordinator, state.active, state.tickets[300], base);
  assert.equal(state.active, null);
  assert.equal(state.tickets[300].feedback, recovery.INTERRUPTED_REASON);
  assert.equal(
    (await recovery.resumePublishedReview(coordinator, state, base, false)).reviewOnly,
    true
  );
  assert.equal(state.tickets[300].head, sourceHead);
  assert.deepEqual(state.tickets[300].publishedRecovery.previousParent, original);
  recovery.validateRecovery(state.tickets[300], Object.values(state.grants));
});

test("a terminal recovery keeps a spent review and does not repeat it on the same head", async () => {
  const recovery = require("../factory/published-review-recovery.cjs");
  const { coordinator, state } = fixture();
  await recovery.resumePublishedReview(coordinator, state, base, false);
  state.tickets[300].reviews = 1;
  state.tickets[300].status = "reviewing";
  state.grants.review = {
    ...state.active,
    phase: "review",
    slot: "cycle1",
    head: sourceHead,
    status: "reserved",
  };
  coordinator.context.runId = "801";
  await recovery.releaseTerminalRecovery(coordinator, state.active, state.tickets[300], base);
  assert.equal(state.grants.review.status, "finished");
  assert.equal(state.grants.review.outcome, "blocked");
  assert.equal(state.tickets[300].reviews, 1);
  assert.equal(state.active, null);
  assert.equal(
    (await recovery.resumePublishedReview(coordinator, state, base, false))?.ready ?? false,
    false
  );
});

async function afterReviewSkip({ priorReviewJob = "skipped", ...options } = {}) {
  const recovery = require("../factory/published-review-recovery.cjs");
  const result = fixture({ priorReviewJob, ...options });
  const { coordinator, state } = result;
  await recovery.resumePublishedReview(coordinator, state, base, false);
  const ticket = state.tickets[result.issue.number];
  const savedCi = { ...result.ci, head: ticket.head, runId: 747 };
  state.grants.review = {
    ...state.active,
    id: "00000000-0000-4000-8000-000000000002",
    phase: "review",
    slot: "cycle1",
    head: ticket.head,
    status: "finished",
    outcome: "blocked",
  };
  Object.assign(ticket, {
    status: "blocked",
    feedback: recovery.INTERRUPTED_REASON,
    ci: savedCi,
    reviews: 1,
  });
  state.active = null;
  coordinator.context.runId = "801";
  return { ...result, recovery, savedCi };
}

test("a proven skipped review can resume once on the same head with saved CI and both counters intact", async () => {
  const { coordinator, state, savedCi, recovery, ciReads, calls } = await afterReviewSkip();
  const grants = structuredClone(state.grants);
  assert.equal(
    (await recovery.resumePublishedReview(coordinator, state, base, false))?.reviewOnly,
    true
  );
  assert.deepEqual(state.tickets[300].ci, savedCi);
  assert.equal(state.tickets[300].coding, 1);
  assert.equal(state.tickets[300].reviews, 1);
  assert.deepEqual(state.grants, grants);
  assert.ok(ciReads.some((ci) => ci.runId === savedCi.runId && ci.head === sourceHead));
  assert.ok(!calls.some(([method]) => method === "PUT"));
  recovery.validateRecovery(state.tickets[300], Object.values(state.grants));
  state.active = null;
  state.tickets[300].status = "blocked";
  assert.equal(await recovery.resumePublishedReview(coordinator, state, base, false), null);
});

test("a skipped review whose base advanced carries saved CI history into a second verified branch refresh", async () => {
  const { coordinator, state, savedCi, recovery } = await afterReviewSkip({ behind: true });
  coordinator.context.workflowSha = laterBase;
  const result = await recovery.resumePublishedReview(coordinator, state, base, false);
  assert.equal(result?.head, laterHead);
  assert.equal(state.tickets[300].ci, null);
  assert.deepEqual(state.tickets[300].skippedPublishedReview.ci, savedCi);
  assert.equal(state.tickets[300].publishedRecovery.refreshes.length, 2);
  assert.equal(state.tickets[300].reviews, 1);
  recovery.validateRecovery(state.tickets[300], Object.values(state.grants));
});

test("a review that ran or has incomplete evidence cannot spend another reservation", async () => {
  for (const priorReviewJob of ["failure", "success", "missing"]) {
    const { coordinator, state, recovery, calls } = await afterReviewSkip({ priorReviewJob });
    coordinator.context.workflowSha = base;
    const result = await recovery.resumePublishedReview(coordinator, state, base, false);
    assert.match(result?.reason ?? "", /review.*skipped/i);
    assert.equal(state.tickets[300].reviews, 1);
    assert.equal(state.active, null);
    assert.ok(!calls.some(([method]) => method === "PUT"));
  }
});

test("skipped review recovery still requires passing CI for its reserved head and unused review allowance", async () => {
  const wrongHead = await afterReviewSkip();
  wrongHead.state.tickets[300].ci.head = refreshedHead;
  const rejected = await wrongHead.recovery.resumePublishedReview(
    wrongHead.coordinator,
    wrongHead.state,
    base,
    false
  );
  assert.match(rejected.reason, /passing CI/);
  assert.equal(wrongHead.state.active, null);

  const spent = await afterReviewSkip();
  spent.coordinator.config.reviews = 1;
  assert.equal(
    await spent.recovery.resumePublishedReview(spent.coordinator, spent.state, base, false),
    null
  );
  assert.equal(spent.state.tickets[300].reviews, 1);
});

test("a saved CI run whose metadata no longer matches holds the recovery without stopping pickup", async () => {
  const { coordinator, state, recovery, savedCi, calls } = await afterReviewSkip();
  const validate = coordinator.controller.validateCI;
  coordinator.controller.validateCI = async (id, ...args) => {
    if (id === savedCi.runId) throw Error("CI does not cover the expected head or run attempt");
    return validate(id, ...args);
  };
  const result = await recovery.resumePublishedReview(coordinator, state, base, false);
  assert.match(result.reason, /skipped with passing CI/);
  assert.equal(state.active, null);
  assert.ok(!calls.some(([method]) => method === "PUT"));
});

test("when main advances after review, a bounded continuation uses a new head with the previous review retained", async () => {
  const recovery = require("../factory/published-review-recovery.cjs");
  const { coordinator, state } = fixture();
  await recovery.resumePublishedReview(coordinator, state, base, false);
  const previous = state.tickets[300].publishedRecovery.parent;
  state.grants.review = {
    ...state.active,
    phase: "review",
    slot: "cycle1",
    head: sourceHead,
    status: "finished",
    outcome: "reviewed",
  };
  state.tickets[300].reviews = 1;
  state.tickets[300].status = "blocked";
  state.tickets[300].feedback = recovery.STALE_REASON;
  state.active = null;
  coordinator.context.runId = "801";
  coordinator.context.workflowSha = base;
  const result = await recovery.resumePublishedReview(coordinator, state, base, false);
  assert.equal(result.head, refreshedHead);
  assert.equal(state.tickets[300].reviews, 1);
  assert.equal(state.grants.review.outcome, "reviewed");
  assert.deepEqual(state.tickets[300].publishedRecovery.previousParent, previous);
  recovery.validateRecovery(state.tickets[300], Object.values(state.grants));
});

test("an out-of-date published PR refreshes once and keeps its old CI as history", async () => {
  const { resumePublishedReview } = require("../factory/published-review-recovery.cjs");
  const { coordinator, state, calls, ci } = fixture({ behind: true });
  assert.equal((await resumePublishedReview(coordinator, state, base, true)).ticket, 300);
  assert.equal(
    calls.some(([method]) => method === "PUT"),
    false
  );
  const result = await resumePublishedReview(coordinator, state, base, false);
  assert.equal(result.reviewOnly, true);
  assert.equal(result.head, refreshedHead);
  assert.equal(state.tickets[300].ci, null);
  assert.deepEqual(state.tickets[300].publishedRecovery.sourceCi, ci);
  assert.equal(calls.filter(([method]) => method === "PUT").length, 1);
  assert.equal(await resumePublishedReview(coordinator, state, base, false), null);
});

async function afterTwo273Recoveries({ lastReviewJob = "skipped", prNumber = 274 } = {}) {
  const result = await afterReviewSkip({
    behind: true,
    number: 273,
    prNumber,
    firstParentRun: "45610806210",
    fromFeature: true,
  });
  const { coordinator, state, recovery, ci } = result;
  coordinator.context.runId = "45697642899";
  coordinator.context.workflowSha = laterBase;
  assert.equal(
    (await recovery.resumePublishedReview(coordinator, state, base, false)).head,
    laterHead
  );
  const ticket = state.tickets[273];
  Object.assign(ticket, {
    status: "blocked",
    feedback: recovery.STALE_REASON,
    ci: { ...ci, head: laterHead, runId: 748 },
  });
  state.active = null;
  coordinator.context.runId = "802";
  coordinator.context.workflowSha = finalBase;
  const { api } = coordinator;
  const { request, pages } = api;
  api.request = async (method, path, body) => {
    if (path === `${ROOT}/actions/runs/45697642899/attempts/1`)
      return {
        id: 45697642899,
        run_attempt: 1,
        workflow_id: 70,
        event: "workflow_dispatch",
        path: ".github/workflows/factory-automatic.yml",
        status: "completed",
        conclusion: "failure",
        head_branch: "main",
        head_sha: laterBase,
        repository: repo,
        head_repository: repo,
      };
    return request(method, path, body);
  };
  api.pages = async (path) => {
    if (path !== `${ROOT}/actions/runs/45697642899/attempts/1/jobs`) return pages(path);
    return Object.entries({
      coding: "skipped",
      publish: "skipped",
      ci: "success",
      reserve_review: "failure",
      review: lastReviewJob,
      assess: "success",
    }).map(([name, conclusion]) => ({
      name: `cycle1 / ${name}`,
      conclusion,
      status: "completed",
    }));
  };
  return result;
}

test("#273 can refresh and resume #274 once while keeping both older recovery runs", async () => {
  const { coordinator, state, calls, recovery } = await afterTwo273Recoveries();
  const original = structuredClone(state);
  const result = await recovery.resumePublishedReview(coordinator, state, base, false);
  assert.deepEqual(
    { reviewOnly: result?.reviewOnly, head: result?.head, ticket: result?.ticket },
    { reviewOnly: true, head: finalHead, ticket: 273 }
  );
  const next = state.tickets[273];
  const prior = original.tickets[273];
  assert.equal(state.active.ticket, 273);
  assert.equal(next.ci, null);
  assert.equal(next.coding, 1);
  assert.equal(next.reviews, 1);
  assert.deepEqual(state.grants, original.grants);
  assert.deepEqual(next.skippedPublishedReview, prior.skippedPublishedReview);
  assert.deepEqual(next.feature, prior.feature);
  assert.deepEqual(next.publishedRecovery.previousParent, prior.publishedRecovery.previousParent);
  assert.deepEqual(next.publishedRecovery.finalContinuation, {
    failedParent: prior.publishedRecovery.parent,
    priorCi: prior.ci,
  });
  assert.deepEqual(next.publishedRecovery.sourceCi, prior.publishedRecovery.sourceCi);
  assert.equal(calls.filter(([method]) => method === "PUT").length, 3);
  recovery.validateRecovery(next, Object.values(state.grants));

  state.active = null;
  next.status = "blocked";
  next.feedback = recovery.STALE_REASON;
  coordinator.context.runId = "803";
  coordinator.context.workflowSha = "5".repeat(40);
  assert.equal(await recovery.resumePublishedReview(coordinator, state, base, false), null);
  assert.equal(calls.filter(([method]) => method === "PUT").length, 3);
});

test("the extra continuation requires the exact PR and skipped review evidence", async () => {
  for (const options of [{ lastReviewJob: "success" }, { prNumber: 275 }]) {
    const { coordinator, state, calls, recovery } = await afterTwo273Recoveries(options);
    const original = structuredClone(state);
    const result = await recovery.resumePublishedReview(coordinator, state, base, false);
    assert.equal(result?.ready ?? false, false);
    assert.deepEqual(state, original);
    assert.equal(calls.filter(([method]) => method === "PUT").length, 2);
  }
});

test("a lost refresh response can be reconciled without sending another branch update", async () => {
  const { coordinator, state, calls, recovery } = await afterTwo273Recoveries();
  const { api } = coordinator;
  const { request } = api;
  api.request = async (method, path, body) => {
    const response = await request(method, path, body);
    if (method === "PUT" && path.endsWith("/update-branch")) {
      const error = new Error("Lost response after branch update");
      error.status = 502;
      throw error;
    }
    return response;
  };
  const priorCi = structuredClone(state.tickets[273].ci);
  const held = await recovery.resumePublishedReview(coordinator, state, base, false);
  assert.match(held.reason, /delivery is unconfirmed/);
  assert.equal(state.active, null);
  assert.deepEqual(state.tickets[273].publishedRecovery.finalContinuation.priorCi, priorCi);
  recovery.validateRecovery(state.tickets[273], Object.values(state.grants));

  coordinator.context.runId = "803";
  const result = await recovery.resumePublishedReview(coordinator, state, base, false);
  assert.equal(result?.reviewOnly, true);
  assert.equal(result?.head, finalHead);
  assert.equal(calls.filter(([method]) => method === "PUT").length, 3);
  recovery.validateRecovery(state.tickets[273], Object.values(state.grants));
});
