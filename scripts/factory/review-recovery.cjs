const assert = require("node:assert/strict");
const policy = require("./policy.cjs");
const slots = require("./active-tickets.cjs");
const { ROOT } = require("./github.cjs");
const { criteriaHash } = require("./controller.cjs");
const { validateReview } = require("./artifacts.cjs");

const WORKFLOW = "factory-review-recovery.yml";
const WORKFLOW_REF = `${policy.REPOSITORY}/.github/workflows/${WORKFLOW}@refs/heads/main`;
const SLOT = "review_recovery";
const HEAD = "b5f70973cbbfe752697e1542c6c2558a4c6687e5";
const SOURCE = Object.freeze({
  ticket: 112,
  pr: 113,
  parent: "44431933780",
  wake: "5d6e288988e641d4fca4da7900e0f1af27ae58de134b8f22e6d86d69dd8d08a8",
  base: "56294cf7fe21ebe1a040a66798b5f75fe7ed9411",
  head: HEAD,
  branch: "agent/factory-112",
  appSlug: "haideearus-software-factory",
  codeGrant: "c3c7cde9-020e-47ea-bac4-e09c3c9f003a",
  ci: Object.freeze({
    requestId: "4d4c7250-3a88-4b72-8328-fd8929146dcd",
    head: HEAD,
    runId: 44432947268,
    passed: true,
  }),
});
const ORIGINAL_OWNER = { ticket: SOURCE.ticket, runId: SOURCE.parent, runAttempt: 1 };
const PATHS = new Map([
  ["src/components/TransactionDetail.tsx", "modified"],
  ["src/components/__tests__/TransactionDetail.test.tsx", "added"],
]);

function assertContext(context) {
  if (
    context.workflowRef !== WORKFLOW_REF ||
    context.actor !== policy.OWNER ||
    context.triggeringActor !== policy.OWNER ||
    context.event !== "workflow_dispatch" ||
    context.runAttempt !== 1 ||
    context.runId === SOURCE.parent ||
    !policy.SHA.test(context.workflowSha || "") ||
    context.ticket !== SOURCE.ticket ||
    context.phase !== "review" ||
    context.slot !== SLOT
  )
    throw new Error("Invalid saved-CI review context");
}

const request = (context, head) => ({
  ...context,
  ticket: SOURCE.ticket,
  phase: "review",
  slot: SLOT,
  head,
});

function source(state, config) {
  const ticket = state.tickets[SOURCE.ticket];
  const coding = state.grants[SOURCE.codeGrant];
  if (
    config.appSlug !== SOURCE.appSlug ||
    config.autoMerge !== false ||
    ticket?.origin !== "factory" ||
    ticket.pr !== SOURCE.pr ||
    ticket.branch !== SOURCE.branch ||
    ticket.coding !== 1 ||
    ticket.retries !== 0 ||
    ticket.finding ||
    ticket.monitor ||
    ticket.merge ||
    ticket.automatic?.workflowRef !== policy.AUTOMATIC_WORKFLOW_REF ||
    ticket.automatic.workflowSha !== SOURCE.base ||
    ticket.automatic.appSlug !== SOURCE.appSlug ||
    ticket.automatic.runId !== SOURCE.parent ||
    ticket.automatic.runAttempt !== 1 ||
    coding?.ticket !== SOURCE.ticket ||
    coding.phase !== "code" ||
    coding.status !== "finished" ||
    coding.outcome !== "awaiting_review" ||
    coding.slot !== "cycle1" ||
    coding.head !== SOURCE.base ||
    !slots.owns(ORIGINAL_OWNER, coding)
  )
    throw new Error("Original coding receipt or recovery configuration changed");
  assert.deepEqual(ticket.ci, SOURCE.ci, "Saved exact-head CI receipt changed");
  return ticket;
}

function reserve(state, context, config, { head, runId }) {
  const reservation = request(context, head);
  assertContext(reservation);
  policy.validateState(state);
  const ticket = source(state, config);
  const active = slots.activeFor(state, SOURCE.ticket);
  const parked = ticket.status === "blocked" && active === null;
  if (
    ticket.head !== SOURCE.head ||
    ticket.reviews !== 0 ||
    ticket.approval !== null ||
    (!parked && (ticket.status !== "awaiting_review" || !slots.owns(active, ORIGINAL_OWNER)))
  )
    throw new Error("Saved review has been used or the original reservation changed");
  const next = structuredClone(state);
  if (active) slots.releaseActive(next, ORIGINAL_OWNER);
  slots.claimActive(
    next,
    { ticket: SOURCE.ticket, runId: context.runId, runAttempt: 1 },
    config.concurrent
  );
  next.tickets[SOURCE.ticket].status = "awaiting_review";
  next.tickets[SOURCE.ticket].head = head;
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    (head === SOURCE.head) !== (runId === SOURCE.ci.runId)
  )
    throw new Error("Invalid review CI binding");
  const result = policy.reserve(next, reservation, config);
  result.state.tickets[SOURCE.ticket].reviewRecovery = {
    grantId: result.grant.id,
    base: context.workflowSha,
    ci: { head, runId, passed: true },
  };
  return result;
}

function reviewEvidence(ticket, grant, context) {
  const receipt = ticket?.reviewRecovery;
  if (
    !receipt ||
    receipt.grantId !== grant.id ||
    receipt.base !== context.workflowSha ||
    receipt.ci?.head !== grant.head ||
    receipt.ci.passed !== true ||
    !Number.isSafeInteger(receipt.ci.runId) ||
    receipt.ci.runId < 1
  )
    throw new Error("Missing exact-head recovery CI receipt");
  return receipt;
}
function validateReceipt(ticket, id, grants) {
  const recovered = grants.filter((grant) => grant.slot === SLOT);
  if (ticket.reviewRecovery === undefined && recovered.length === 0) return;
  const receipt = ticket.reviewRecovery;
  const [grant] = recovered;
  if (
    id !== String(SOURCE.ticket) ||
    ticket.pr !== SOURCE.pr ||
    ticket.coding !== 1 ||
    ticket.reviews !== 1 ||
    ticket.retries !== 0 ||
    recovered.length !== 1 ||
    grant.phase !== "review" ||
    grant.runId === SOURCE.parent ||
    grant.runAttempt !== 1 ||
    ticket.head !== grant.head ||
    !policy.SHA.test(receipt?.base || "") ||
    Object.keys(receipt).sort().join(",") !== "base,ci,grantId" ||
    Object.keys(receipt.ci || {})
      .sort()
      .join(",") !== "head,passed,runId" ||
    (grant.head === SOURCE.head) !== (receipt.ci.runId === SOURCE.ci.runId)
  )
    throw new Error("Invalid saved-CI review receipt");
  reviewEvidence(ticket, grant, { workflowSha: receipt.base });
  assert.deepEqual(ticket.ci, SOURCE.ci, "Original CI must survive review recovery");
}

function patch(files) {
  if (
    !Array.isArray(files) ||
    files.length !== PATHS.size ||
    new Set(files.map((file) => file.filename)).size !== PATHS.size ||
    files.some(
      (file) =>
        PATHS.get(file.filename) !== file.status ||
        !policy.SHA.test(file.sha || "") ||
        typeof file.patch !== "string" ||
        !file.patch ||
        file.patch.length > 25000
    )
  )
    throw new Error("Expected the original two-file accessibility patch");
  return files
    .map(({ filename, status, sha, patch }) => ({ filename, status, sha, patch }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

async function verifyOriginal(controller) {
  const { api } = controller;
  const original = {
    ...controller.context,
    actor: "github-actions[bot]",
    triggeringActor: "github-actions[bot]",
    workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
    workflowSha: SOURCE.base,
    runId: SOURCE.parent,
  };
  const [run, jobs, ci] = await Promise.all([
    api.request("GET", `${ROOT}/actions/runs/${SOURCE.parent}`),
    api.pages(`${ROOT}/actions/runs/${SOURCE.parent}/attempts/1/jobs`, "jobs"),
    controller.validateCI(SOURCE.ci.runId, SOURCE.head, SOURCE.ci),
    require("./trusted-wake.cjs").verifyWake({
      api,
      context: original,
      receiptId: SOURCE.wake,
      lane: "app",
    }),
  ]);
  const phases = [
    ["cycle1 / coding / agent", 135251417407, "success"],
    ["cycle1 / publish", 135254286259, "success"],
    ["cycle1 / ci", 135254474255, "failure"],
    ["cycle1 / assess", 135258143964, "failure"],
    ["cycle1 / reserve_review", 135258144364, "skipped"],
    ["cycle1 / review", 135258146310, "skipped"],
  ];
  if (
    run.run_attempt !== 1 ||
    run.status !== "completed" ||
    run.conclusion !== "failure" ||
    !ci.passed
  )
    throw new Error("Original run must remain terminal with passing saved CI");
  for (const [name, id, conclusion] of phases) {
    assert.deepEqual(
      jobs.filter((job) => job.name === name).map((job) => [job.id, job.conclusion]),
      [[id, conclusion]],
      "Original coding and review job evidence changed"
    );
  }
}

async function verifyHost(controller) {
  const { api, context } = controller;
  const run = await require("./wake-controller.cjs").verifiedRun(api, context.runId, 1, WORKFLOW, {
    terminal: false,
  });
  if (
    run.status === "completed" ||
    run.head_sha !== context.workflowSha ||
    run.head_branch !== "main" ||
    run.event !== "workflow_dispatch" ||
    run.actor?.id !== 101267861 ||
    run.triggering_actor?.id !== 101267861
  )
    throw new Error("Expected a fresh owner-dispatched recovery run on main");
}

async function reviewedRevision(controller, ticket, updatedCi) {
  const { api, context } = controller;
  const get = (suffix) => api.request("GET", ROOT + suffix);
  const [pr, issue] = await Promise.all([
    get(`/pulls/${SOURCE.pr}`),
    controller.issue(SOURCE.ticket),
  ]);
  if (
    criteriaHash(issue) !== ticket.criteriaHash ||
    pr.number !== SOURCE.pr ||
    pr.state !== "open" ||
    pr.draft !== false ||
    pr.user?.login !== `${SOURCE.appSlug}[bot]` ||
    pr.head?.ref !== SOURCE.branch ||
    pr.head.repo?.full_name !== policy.REPOSITORY ||
    !policy.SHA.test(pr.head.sha || "") ||
    pr.base?.ref !== "main" ||
    pr.base.repo?.full_name !== policy.REPOSITORY ||
    pr.base.sha !== context.workflowSha
  )
    throw new Error("PR #113, its current main base, or issue #112 criteria changed");
  const head = pr.head.sha;
  if (head === SOURCE.head) {
    if (pr.base.sha !== SOURCE.base)
      throw new Error("Update PR #113 with a merge commit and wait for new PR CI");
    if (updatedCi) throw new Error("Leave the updated CI input blank for the original head");
    return { head, runId: SOURCE.ci.runId };
  }
  if (!/^[1-9]\d{0,14}$/.test(updatedCi || ""))
    throw new Error("Provide the green Factory CI run ID for the updated PR head");
  const [commit, previous, current, ci] = await Promise.all([
    get(`/git/commits/${head}`),
    get(`/compare/${SOURCE.base}...${SOURCE.head}?per_page=1`),
    get(`/compare/${pr.base.sha}...${head}?per_page=1`),
    require("./wake-controller.cjs").verifiedRun(api, updatedCi, 1, "factory-ci.yml"),
  ]);
  assert.deepEqual(
    commit.parents.map(({ sha }) => sha),
    [SOURCE.head, pr.base.sha],
    "Updated head must merge current main directly into the original PR head"
  );
  assert.deepEqual(
    patch(current.files),
    patch(previous.files),
    "PR patch changed during branch update"
  );
  if (
    ci.event !== "pull_request" ||
    ci.display_title !== `Factory CI / ${SOURCE.pr}` ||
    ci.head_sha !== head ||
    ci.head_branch !== SOURCE.branch ||
    !ci.pull_requests?.some(
      (row) => row.number === SOURCE.pr && row.head?.sha === head && row.base?.sha === pr.base.sha
    )
  )
    throw new Error("PR CI is unrelated to this exact updated head and base");
  const jobs = await api.pages(`${ROOT}/actions/runs/${updatedCi}/attempts/1/jobs`, "jobs");
  assert.deepEqual(
    jobs.filter((job) => job.name === "verify").map((job) => [job.status, job.conclusion]),
    [["completed", "success"]],
    "Updated PR must have one successful verify job"
  );
  return { head, runId: Number(updatedCi) };
}

async function prepare(controller, { preview, updated_ci_run: updatedCi }) {
  const { ledger, config, context } = controller;
  policy.authorize(request(context, SOURCE.head));
  const loaded = await ledger.read();
  const ticket = source(loaded.state, config);
  await Promise.all([verifyHost(controller), verifyOriginal(controller)]);
  const revision = await reviewedRevision(controller, ticket, updatedCi);
  const live = { ...config, enabled: true };
  if (preview === true) {
    reserve(loaded.state, context, live, revision);
    return {
      ready: false,
      reason: `Preview passed for #113 at ${revision.head}; CI run ${revision.runId}; zero reservations or model calls`,
    };
  }
  if (preview !== false) throw new Error("Explicit preview choice required");
  const result = await ledger.update(
    (state) => {
      const result = reserve(state, context, config, revision);
      policy.audit(result.state, "saved_ci_review_reserved", {
        actor: context.actor,
        ticket: SOURCE.ticket,
        pr: SOURCE.pr,
        originalRun: SOURCE.parent,
        originalCI: SOURCE.ci.runId,
        reviewedCI: revision.runId,
        grant: result.grant.id,
        runId: context.runId,
        head: revision.head,
      });
      return result;
    },
    { expectedCommit: loaded.commit }
  );
  return controller.result(result.grant);
}

async function assess(controller, { grantId, updated_ci_run: updatedCi, reviewResult }, bundle) {
  const { ledger, context, config } = controller;
  policy.authorize(request(context, SOURCE.head));
  await verifyHost(controller);
  const loaded = await ledger.read();
  const ticket = source(loaded.state, config);
  const expected = request(context, ticket.head);
  const grant = loaded.state.grants[grantId];
  if (
    !slots.owns(slots.activeFor(loaded.state, SOURCE.ticket), expected) ||
    !grant ||
    grant.status !== "reserved" ||
    grant.phase !== "review" ||
    grant.slot !== SLOT ||
    grant.head !== expected.head ||
    !slots.owns(grant, expected)
  )
    throw new Error("This run does not own the recovery reservation");
  if (reviewResult !== "success")
    return controller.block(SOURCE.ticket, "Recovery review unavailable; no automatic retry");
  policy.preflight(loaded.state, grantId, expected, config);
  const revision = await reviewedRevision(controller, ticket, updatedCi);
  const receipt = reviewEvidence(ticket, grant, expected);
  if (
    revision.head !== grant.head ||
    revision.runId !== receipt.ci.runId ||
    bundle?.kind !== "review" ||
    bundle.grantId !== grantId ||
    bundle.base !== grant.head
  )
    throw new Error("Invalid recovered review artifact identity");
  const review = validateReview(bundle.result, grant.head);
  const reviewed = review.verdict === "pass";
  await ledger.update(
    (state) => {
      const next = policy.finish(state, grantId, {
        status: reviewed ? "reviewed" : "blocked",
        head: grant.head,
        pr: SOURCE.pr,
        verdict: review.verdict,
        evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/${context.runId}`,
      });
      const active = slots.activeFor(next, SOURCE.ticket);
      if (active) slots.releaseActive(next, expected);
      next.tickets[SOURCE.ticket].feedback = JSON.stringify(review);
      return { state: next };
    },
    { expectedCommit: loaded.commit }
  );
  await controller.gate(SOURCE.pr);
  return { reviewed, pr: SOURCE.pr, head: grant.head };
}

module.exports = {
  WORKFLOW_REF,
  SLOT,
  SOURCE,
  assertContext,
  patch,
  reserve,
  reviewEvidence,
  validateReceipt,
  reviewedRevision,
  prepare,
  assess,
};
