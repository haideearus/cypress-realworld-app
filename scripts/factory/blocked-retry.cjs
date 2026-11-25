const { ROOT } = require("./github.cjs");
const policy = require("./policy.cjs");
const retry = require("./delayed-retry.cjs");
const { testedMain } = require("./discovery-run.cjs");
const { BOT, BOT_ID } = require("./wake-contract.cjs");

const positive = (value) => Number.isSafeInteger(value) && value > 0;
const sha = /^[a-f0-9]{40}$/;

// PR #111 diagnosed the Claude Action rejecting the wake actor before starting
// Claude. That rejection happened inside the action, so the step is failed,
// not skipped. Keep this reviewed historical exception tied to its exact job.
const WAKE_REPAIR = Object.freeze({
  ticket: 109,
  runId: "44424312124",
  jobId: 135225265791,
  head: "60ec2c6a851b315e3db3f175a62cc580ef9e99ab",
  pr: 111,
  mergeCommit: "56294cf7fe21ebe1a040a66798b5f75fe7ed9411",
});

class BlockedRetryEvidenceUnavailable extends Error {}

function eligible(state, ticket, number, config) {
  return (
    !state.stop &&
    !ticket?.delayedRetry &&
    !ticket?.monitor &&
    !ticket?.finding &&
    retry.eligibleBlocked(state, ticket, number, config)
  );
}

async function failedAttempt(api, state, ticket, number, known) {
  const owner = ticket.automatic;
  const failed = Object.values(state.grants).filter(
    (grant) =>
      grant.ticket === number &&
      grant.phase === "code" &&
      grant.slot === "cycle1" &&
      grant.status === "finished" &&
      grant.outcome === "blocked" &&
      grant.runId === owner.runId &&
      grant.runAttempt === owner.runAttempt &&
      grant.head === owner.workflowSha
  );
  if (failed.length !== 1)
    throw new BlockedRetryEvidenceUnavailable("Original failed grant is unavailable");
  const run = await api.request("GET", `${ROOT}/actions/runs/${owner.runId}`);
  if (
    run.id !== Number(owner.runId) ||
    run.run_attempt !== owner.runAttempt ||
    run.status !== "completed" ||
    run.conclusion !== "failure" ||
    run.path !== ".github/workflows/factory-automatic.yml" ||
    run.head_branch !== "main" ||
    run.head_sha !== owner.workflowSha ||
    run.repository?.full_name !== policy.REPOSITORY ||
    run.head_repository?.full_name !== policy.REPOSITORY ||
    (known &&
      (run.event !== "workflow_dispatch" ||
        [run.actor, run.triggering_actor].some(
          (actor) => actor?.login !== BOT || actor.id !== BOT_ID
        )))
  )
    throw new BlockedRetryEvidenceUnavailable("Original failed factory run is unavailable");
  const jobs = await api.pages(
    `${ROOT}/actions/runs/${owner.runId}/attempts/${owner.runAttempt}/jobs`,
    "jobs"
  );
  const matches = jobs.filter(
    (job) =>
      job.name === "cycle1 / coding / agent" &&
      job.run_id === run.id &&
      job.run_attempt === run.run_attempt &&
      job.status === "completed" &&
      job.conclusion === "failure"
  );
  const job = matches[0];
  if (matches.length !== 1 || !positive(job.id) || (known && !matchesWakeRejection(job, known)))
    throw new BlockedRetryEvidenceUnavailable("Original failed coding job is unavailable");
  return {
    grant: failed[0],
    jobId: job.id,
    finishedAt: new Date(Date.parse(job.completed_at)),
  };
}

function matchesWakeRejection(job, known) {
  return (
    job.id === known.jobId &&
    job.head_sha === known.head &&
    Array.isArray(job.steps) &&
    [
      ["Verify the durable reservation and prepare the isolated role", "success"],
      [retry.MODEL_STEP, "failure"],
      ["Validate and collect only the role output", "skipped"],
    ].every(([name, conclusion]) => {
      const matches = job.steps.filter((step) => step.name === name);
      return (
        matches.length === 1 &&
        matches[0].status === "completed" &&
        matches[0].conclusion === conclusion
      );
    })
  );
}

async function verifyFix(api, fixPr, failureHead, context, known) {
  const fix = await api.request("GET", `${ROOT}/pulls/${fixPr}`);
  if (
    fix.number !== fixPr ||
    fix.merged !== true ||
    fix.state !== "closed" ||
    fix.user?.login !== policy.OWNER ||
    fix.base?.ref !== "main" ||
    fix.base.repo?.full_name !== policy.REPOSITORY ||
    !sha.test(fix.merge_commit_sha || "") ||
    fix.merge_commit_sha === failureHead ||
    (known && fix.merge_commit_sha !== known.mergeCommit)
  )
    throw new BlockedRetryEvidenceUnavailable(
      "Supply a merged harness fix on this repository's main branch"
    );
  const mergeCommit = fix.merge_commit_sha;
  const [source, result, files, ci] = await Promise.all([
    api.request("GET", `${ROOT}/compare/${failureHead}...${mergeCommit}`),
    api.request("GET", `${ROOT}/compare/${mergeCommit}...${context.workflowSha}`),
    api.request("GET", `${ROOT}/pulls/${fixPr}/files?per_page=100`),
    known ? testedCurrentMain(api, context) : testedMain(api, context),
  ]);
  if (
    source.status !== "ahead" ||
    !["ahead", "identical"].includes(result.status) ||
    ci?.head !== context.workflowSha ||
    !/^[1-9]\d*$/.test(ci.ciRunId) ||
    !Array.isArray(files) ||
    (known
      ? ![
          ".github/workflows/factory-model.yml",
          "scripts/factory/worker.cjs",
          "scripts/factory/trusted-wake.cjs",
        ].every((filename) => files.some((file) => file.filename === filename))
      : !files.some((file) =>
          /^(scripts\/factory\/|\.github\/(workflows|actions)\/)/.test(file.filename)
        ))
  )
    throw new BlockedRetryEvidenceUnavailable(
      "The merged harness fix must be newer than the failed attempt and on tested main"
    );
  return { pr: fixPr, mergeCommit, ciRunId: ci.ciRunId };
}

async function hasPublicationBranch(api, ticket) {
  try {
    await api.request("GET", `${ROOT}/git/ref/heads/agent/factory-${ticket}`);
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

async function assertNotPublished(api, ticket) {
  if (await hasPublicationBranch(api, ticket))
    throw new BlockedRetryEvidenceUnavailable(
      "A publication branch exists; recover the published work instead"
    );
}

async function hasNoPublication(api, ticket) {
  const [branch, pulls] = await Promise.all([
    hasPublicationBranch(api, ticket),
    api.request(
      "GET",
      `${ROOT}/pulls?state=all&per_page=1&head=${encodeURIComponent(`${policy.OWNER}:agent/factory-${ticket}`)}`
    ),
  ]);
  return !branch && Array.isArray(pulls) && pulls.length === 0;
}

function hasKnownFailure(state, record, config) {
  return (
    eligible(state, record, WAKE_REPAIR.ticket, config) &&
    !record.feature &&
    !record.merge &&
    !record.pendingCi &&
    !record.publication &&
    !record.recovery &&
    !record.reviewRecovery &&
    record.head === WAKE_REPAIR.head &&
    record.automatic.workflowSha === WAKE_REPAIR.head &&
    record.automatic.runId === WAKE_REPAIR.runId &&
    record.automatic.runAttempt === 1 &&
    record.automatic.appSlug === config.appSlug &&
    Object.values(state.grants).filter((grant) => grant.ticket === WAKE_REPAIR.ticket).length === 1
  );
}

function makeReceipt(failed, fix, now) {
  if (
    !Number.isFinite(failed.finishedAt.getTime()) ||
    failed.finishedAt > now ||
    failed.finishedAt < new Date(failed.grant.at)
  )
    throw new BlockedRetryEvidenceUnavailable("Original job completion time is unavailable");
  return { ...retry.receipt(failed.grant.id, failed.jobId, failed.finishedAt), fix };
}

function recordVerifiedRetry(state, ticket, receipt, now = new Date()) {
  state.tickets[ticket].delayedRetry = receipt;
  policy.audit(
    state,
    "blocked_retry_queued_after_fix",
    {
      ticket,
      fixPr: receipt.fix.pr,
      fixCommit: receipt.fix.mergeCommit,
      testedMainRun: receipt.fix.ciRunId,
      notBefore: receipt.notBefore,
    },
    now
  );
}

async function knownBlockedRetry(coordinator, state, now = new Date()) {
  const { api, config, context } = coordinator;
  const { ticket, pr, head } = WAKE_REPAIR;
  const record = state.tickets[ticket];
  if (
    !policy.isAutomaticContext(context) ||
    context.actor !== policy.OWNER ||
    context.triggeringActor !== policy.OWNER ||
    context.runAttempt !== 1 ||
    context.wake ||
    context.runId === WAKE_REPAIR.runId ||
    ticket === config.activityIssue ||
    !hasKnownFailure(state, record, config)
  )
    return null;
  try {
    const issue = await api.request("GET", `${ROOT}/issues/${ticket}`);
    if (issue.number !== ticket || !(await coordinator.verifyDelayedIssue(issue, record)))
      return null;
    const [failed, fix, unpublished] = await Promise.all([
      failedAttempt(api, state, record, ticket, WAKE_REPAIR),
      verifyFix(api, pr, head, context, WAKE_REPAIR),
      hasNoPublication(api, ticket),
    ]);
    if (!unpublished) return null;
    const receipt = makeReceipt(failed, fix, now);
    return Date.parse(receipt.notBefore) <= now.getTime() ? { issue, receipt } : null;
  } catch (error) {
    if (
      error instanceof BlockedRetryEvidenceUnavailable ||
      [404, 500, 502, 503, 504].includes(error.status)
    )
      return null;
    throw error;
  }
}

async function queueBlockedRetry(coordinator, { ticket, fixPr, dryRun }, now = new Date()) {
  const { api, config, context, ledger } = coordinator;
  if (
    !policy.isAutomaticContext(context) ||
    context.event !== "workflow_dispatch" ||
    context.runAttempt !== 1 ||
    context.actor !== policy.OWNER ||
    context.triggeringActor !== policy.OWNER ||
    context.wake ||
    !positive(ticket) ||
    !positive(fixPr) ||
    typeof dryRun !== "boolean"
  )
    throw Error("Owner dispatch and explicit blocked issue and fix PR are required");
  const { state, commit } = await ledger.read();
  const record = state.tickets[String(ticket)];
  if (!config.enabled || !config.automatic || !eligible(state, record, ticket, config))
    throw Error("This ticket is not eligible for a blocked retry");
  const issue = await api.request("GET", `${ROOT}/issues/${ticket}`);
  if (issue.number !== ticket || !(await coordinator.verifyDelayedIssue(issue, record)))
    throw Error("Original ready issue identity or criteria changed");
  const [failed, fix] = await Promise.all([
    failedAttempt(api, state, record, ticket),
    verifyFix(api, fixPr, record.head, context),
    assertNotPublished(api, ticket),
  ]);
  const next = makeReceipt(failed, fix, now);
  if (dryRun)
    return {
      ready: false,
      modelCalls: 0,
      reason: `Preview passed for issue #${ticket}; no retry was queued.`,
    };

  await ledger.update(
    async (current) => {
      const original = current.tickets[String(ticket)];
      if (
        !eligible(current, original, ticket, config) ||
        original.criteriaHash !== record.criteriaHash
      )
        throw Error("Blocked retry evidence changed before recording");
      const [fresh, branch] = await Promise.all([
        api.request("GET", `${ROOT}/issues/${ticket}`),
        api.request("GET", `${ROOT}/branches/main`),
        assertNotPublished(api, ticket),
      ]);
      if (
        branch.commit?.sha !== context.workflowSha ||
        !(await coordinator.verifyDelayedIssue(fresh, original))
      )
        throw Error("Issue or tested main changed before recording; use a fresh invocation");
      recordVerifiedRetry(current, ticket, next, now);
      return { state: current };
    },
    { expectedCommit: commit }
  );
  return {
    ready: false,
    modelCalls: 0,
    reason: `Issue #${ticket} is queued for one delayed retry from ${next.notBefore}, subject to priority and limits.`,
  };
}

async function testedCurrentMain(api, context) {
  return testedMain(api, context).catch((error) => {
    if (
      /^(Current main changed|Successful current-main push CI required|Current-main verification job required)/.test(
        error.message
      )
    )
      return null;
    throw error;
  });
}

async function testedFixOnMain(api, context, fix) {
  const [compare, ci] = await Promise.all([
    api.request("GET", `${ROOT}/compare/${fix.mergeCommit}...${context.workflowSha}`),
    testedCurrentMain(api, context),
  ]);
  return ci?.head === context.workflowSha && ["ahead", "identical"].includes(compare.status);
}

module.exports = {
  hasNoPublication,
  knownBlockedRetry,
  queueBlockedRetry,
  recordVerifiedRetry,
  testedFixOnMain,
};
