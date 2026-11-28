const path = require("node:path");
const { ROOT } = require("./github.cjs");
const policy = require("./policy.cjs");
const d = require("./dependency-contract.cjs");
const lifecycle = require("./dependency-policy.cjs");
const { inspectUpdate, toolsAt } = require("./dependency-analysis.cjs");
const compatibility = require("./dependency-compatibility.cjs");

const APP_CI_STEPS = new Set([
  "Run yarn types && yarn lint && yarn test:unit:ci",
  "Run yarn build:production && yarn test:production",
  "Run yarn test:production:browser",
  "Exercise the weekly functional discovery suite without ticket publication",
  "Run yarn build:ci",
  "API and browser regression tests without cloud recording",
]);

async function sources(api, ticket) {
  const { readDependencySource: content } = compatibility;
  const { base } = d.validateTicket(ticket);
  const { head } = ticket;
  const [baseManifest, headManifest, baseLock, headLock] = await Promise.all([
    content(api, base, "package.json"),
    content(api, head, "package.json"),
    content(api, base, "yarn.lock"),
    content(api, head, "yarn.lock"),
  ]);
  return { base, head, baseManifest, headManifest, baseLock, headLock };
}

function targetFor(source, ticket, tools) {
  return compatibility.classifyNativeUpdate({ ...source, ref: ticket.branch, tools });
}

// Minor and grouped proposals that pass the original lock policy need no special scope.
function analysisScope(source, ticket, tools) {
  if (!d.branch(ticket.branch)) return {};
  const receipt = d.compatibilityForHead(ticket)?.compatibility;
  try {
    inspectUpdate(
      source.baseManifest,
      source.headManifest,
      source.baseLock,
      source.headLock,
      tools
    );
    if (!receipt) return {};
  } catch (error) {
    if (
      !receipt &&
      !/^(Dependency major update held|Dependency major version or downgrade held)$/.test(
        error.message
      )
    )
      throw error;
  }
  const target = targetFor(source, ticket, tools);
  if (
    receipt &&
    (target.name !== receipt.package.name || target.version !== receipt.package.version)
  )
    throw new Error("Dependency target differs from the retained compatibility receipt");
  compatibility.verifyNativeLockScope({ ...source, ref: ticket.branch, target, tools });
  return { nativeMajor: true };
}

async function appFailed(api, run) {
  if (
    !Number.isSafeInteger(run?.id) ||
    run.id < 1 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    run.path !== ".github/workflows/factory-ci.yml" ||
    run.status !== "completed" ||
    run.conclusion !== "failure" ||
    run.repository?.full_name !== policy.REPOSITORY ||
    run.head_repository?.full_name !== policy.REPOSITORY
  )
    return false;
  const { jobs } = await api.request(
    "GET",
    `${ROOT}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`
  );
  if (!Array.isArray(jobs) || jobs.length > 100)
    throw new Error("Invalid native dependency CI jobs");
  const failed = (name) =>
    jobs.filter(
      (job) => job.name === name && job.status === "completed" && job.conclusion === "failure"
    );
  const app = failed("app");
  return (
    failed("verify").length === 1 &&
    app.length === 1 &&
    app[0].steps?.some(
      ({ name, conclusion }) => APP_CI_STEPS.has(name) && conclusion === "failure"
    ) === true
  );
}

async function verifyNativeFailure(api, pr) {
  const query = new URLSearchParams({
    head_sha: pr.head.sha,
    event: "pull_request",
    branch: pr.head.ref,
    per_page: "10",
  });
  const { workflow_runs: runs } = await api.request(
    "GET",
    `${ROOT}/actions/workflows/factory-ci.yml/runs?${query}`
  );
  if (!Array.isArray(runs) || runs.length > 10)
    throw new Error("Invalid native dependency CI runs");
  const run = runs.find(
    (row) =>
      row.head_sha === pr.head.sha &&
      row.head_branch === pr.head.ref &&
      row.event === "pull_request" &&
      row.pull_requests?.some((pull) => pull.number === pr.number)
  );
  return run ? verifyNativeFailureRun(api, pr, run) : false;
}

async function verifyNativeFailureRun(api, pr, run, { allowMissingAssociation = false } = {}) {
  try {
    d.prOK(pr, true);
  } catch {
    return false;
  }
  if (
    run?.event !== "pull_request" ||
    run.head_sha !== pr.head.sha ||
    run.head_branch !== pr.head.ref ||
    run.display_title !== `Factory CI / ${pr.number}` ||
    run.actor?.login !== pr.user.login ||
    run.actor?.id !== pr.user.id ||
    run.actor?.type !== "Bot" ||
    !Array.isArray(run.pull_requests) ||
    !(
      run.pull_requests.some((pull) => pull.number === pr.number) ||
      (allowMissingAssociation &&
        pr.state === "closed" &&
        pr.merged === true &&
        run.pull_requests.length === 0)
    )
  )
    return false;
  return appFailed(api, run);
}

async function archivedCIFailed(coordinator, ticket) {
  const previous = ticket.dependency.attempts
    .slice(0, -1)
    .findLast((attempt) => attempt.head === ticket.head);
  const ci = previous?.ci;
  if (!ci || ci.passed !== false) return false;
  const run = await coordinator.api.request("GET", `${ROOT}/actions/runs/${ci.runId}`);
  if (
    run.id !== ci.runId ||
    run.head_sha !== ticket.head ||
    run.head_branch !== ticket.branch ||
    run.event !== "workflow_dispatch" ||
    run.display_title !== `Factory CI / ${ci.requestId}`
  )
    return false;
  return appFailed(coordinator.api, run);
}

async function planCompatibility(coordinator, number) {
  const t = await coordinator.ticket(number);
  const skipped = { ready: false, reason: "No dependency compatibility coding required" };
  const failedWake = d.compatibilityWakeMatches(t, coordinator.context);
  if (!d.branch(t.branch) || (coordinator.context.wake && !failedWake)) return skipped;
  const sourceAttempt = d.compatibilityForHead(t);
  const reviewedBlock = d.archivedCompatibilityReview(t);
  const savedFailure = !failedWake && (await archivedCIFailed(coordinator, t));
  if (sourceAttempt && !failedWake && !savedFailure && !reviewedBlock) return skipped;
  const pr = await coordinator.pr(number, { expected: t });
  const source = await sources(coordinator.api, t);
  const tools = toolsAt(path.join(__dirname, "dependency-tools"));
  let reason;
  try {
    analysisScope(source, t, tools);
  } catch (error) {
    if (
      !/^(Dependency downgrade held|Dependency major version or downgrade held|Compatibility patch changed an unrelated lockfile resolution)$/.test(
        error.message
      )
    )
      throw error;
    reason = "dependency_analysis_failure";
  }
  if (reviewedBlock) reason = "review_blocked";
  else if (failedWake || savedFailure || (await verifyNativeFailure(coordinator.api, pr)))
    reason = "native_ci_failure";
  if (!reason) return skipped;
  const { name, version } = targetFor(source, t, tools);
  await coordinator.pr(number, { expected: t });
  const result = await coordinator.ledger.update((state) =>
    lifecycle.reserveDependencyCompatibility(
      state,
      number,
      coordinator.context,
      coordinator.config,
      { package: { name, version }, reason }
    )
  );
  return { ...coordinator.controller.result(result.grant), ready: true };
}

async function publishCompatibility(coordinator, number, grantId, bundle) {
  const t = await coordinator.ticket(number);
  const { base, compatibility: reservation } = d.validateTicket(t);
  const pr = await coordinator.pr(number, { expected: t });
  const { api, config, context, ledger } = coordinator;
  if (
    (context.wake && !d.compatibilityWakeMatches(t, context)) ||
    reservation?.grantId !== grantId ||
    bundle?.kind !== "code" ||
    bundle.grantId !== grantId ||
    bundle.base !== t.head
  )
    throw new Error("Dependency compatibility artifact identity changed");
  const { state } = await ledger.read();
  policy.preflight(
    state,
    grantId,
    { ...context, ticket: number, head: t.head, phase: "code", slot: "dependency_compat" },
    config
  );
  const { newHead: head } = await compatibility.prepareCompatibility({
    api,
    pr,
    expectedBase: base,
    expectedHead: t.head,
    bundle,
    target: reservation.package,
  });
  const evidence = { grantId, originalHead: t.head, head, base };
  await ledger.update((current) => ({
    state: lifecycle.beginDependencyCompatibilityPublish(
      current,
      number,
      context,
      config,
      evidence
    ),
  }));
  const { state: current } = await ledger.read();
  lifecycle.assertDependencyCompatibilityPublish(current, number, context, config, evidence);
  await compatibility.applyCompatibility({
    api,
    pr,
    expectedBase: base,
    expectedHead: t.head,
    newHead: head,
  });
  await ledger.update((latest) => ({
    state: lifecycle.recordDependencyCompatibility(latest, number, context, config, evidence),
  }));
  return {
    ready: true,
    head,
    ticket: number,
    reason: "Compatibility patch appended to the existing Dependabot PR",
  };
}

module.exports = {
  sources,
  analysisScope,
  verifyNativeFailure,
  verifyNativeFailureRun,
  planCompatibility,
  publishCompatibility,
};
