const { ROOT } = require("./github.cjs");
const policy = require("./policy.cjs");
const retry = require("./delayed-retry.cjs");
const { testedMain } = require("./discovery-run.cjs");

const positive = (value) => Number.isSafeInteger(value) && value > 0;
const sha = /^[a-f0-9]{40}$/;

function eligible(state, ticket, number, config) {
  return (
    !state.stop &&
    !ticket?.delayedRetry &&
    !ticket?.monitor &&
    !ticket?.finding &&
    retry.eligibleBlocked(state, ticket, number, config)
  );
}

async function failedAttempt(api, state, ticket, number) {
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
  if (failed.length !== 1) throw Error("Original failed grant is unavailable");
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
    run.head_repository?.full_name !== policy.REPOSITORY
  )
    throw Error("Original failed factory run is unavailable");
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
  if (matches.length !== 1 || !positive(matches[0].id))
    throw Error("Original failed coding job is unavailable");
  return {
    grant: failed[0],
    jobId: matches[0].id,
    finishedAt: new Date(Date.parse(matches[0].completed_at)),
  };
}

async function verifyFix(api, fixPr, failureHead, context) {
  const fix = await api.request("GET", `${ROOT}/pulls/${fixPr}`);
  if (
    fix.number !== fixPr ||
    fix.merged !== true ||
    fix.state !== "closed" ||
    fix.user?.login !== policy.OWNER ||
    fix.base?.ref !== "main" ||
    fix.base.repo?.full_name !== policy.REPOSITORY ||
    !sha.test(fix.merge_commit_sha || "") ||
    fix.merge_commit_sha === failureHead
  )
    throw Error("Supply a merged harness fix on this repository's main branch");
  const mergeCommit = fix.merge_commit_sha;
  const [source, result, files, ci] = await Promise.all([
    api.request("GET", `${ROOT}/compare/${failureHead}...${mergeCommit}`),
    api.request("GET", `${ROOT}/compare/${mergeCommit}...${context.workflowSha}`),
    api.request("GET", `${ROOT}/pulls/${fixPr}/files?per_page=100`),
    testedMain(api, context),
  ]);
  if (
    source.status !== "ahead" ||
    !["ahead", "identical"].includes(result.status) ||
    ci.head !== context.workflowSha ||
    !/^[1-9]\d*$/.test(ci.ciRunId) ||
    !Array.isArray(files) ||
    !files.some((file) =>
      /^(scripts\/factory\/|\.github\/(workflows|actions)\/)/.test(file.filename)
    )
  )
    throw Error("The merged harness fix must be newer than the failed attempt and on tested main");
  return { pr: fixPr, mergeCommit, ciRunId: ci.ciRunId };
}

async function assertNotPublished(api, ticket) {
  try {
    await api.request("GET", `${ROOT}/git/ref/heads/agent/factory-${ticket}`);
  } catch (error) {
    if (error.status === 404) return;
    throw error;
  }
  throw Error("A publication branch exists; recover the published work instead");
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
  if (
    !Number.isFinite(failed.finishedAt.getTime()) ||
    failed.finishedAt > now ||
    failed.finishedAt < new Date(failed.grant.at)
  )
    throw Error("Original job completion time is unavailable");
  const next = { ...retry.receipt(failed.grant.id, failed.jobId, failed.finishedAt), fix };
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
      original.delayedRetry = next;
      policy.audit(
        current,
        "blocked_retry_queued_after_fix",
        {
          ticket,
          fixPr,
          fixCommit: fix.mergeCommit,
          testedMainRun: fix.ciRunId,
          notBefore: next.notBefore,
        },
        now
      );
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

async function testedFixOnMain(api, context, fix) {
  const [compare, ci] = await Promise.all([
    api.request("GET", `${ROOT}/compare/${fix.mergeCommit}...${context.workflowSha}`),
    testedMain(api, context).catch((error) => {
      if (
        /^(Current main changed|Successful current-main push CI required|Current-main verification job required)/.test(
          error.message
        )
      )
        return null;
      throw error;
    }),
  ]);
  return ci?.head === context.workflowSha && ["ahead", "identical"].includes(compare.status);
}

module.exports = { queueBlockedRetry, testedFixOnMain };
