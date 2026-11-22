const fs = require("node:fs");
const { ROOT, GitHub, Ledger } = require("./github.cjs");
const policy = require("./policy.cjs");
const { activeFor } = require("./active-tickets.cjs");
const { criteriaHash } = require("./controller.cjs");
const { contextFromEnv } = require("./deploy.cjs");
const { waitForRelease, readLiveRelease: currentRelease } = require("./deploy-render.cjs");
const { runActorOK } = require("./discovery-contract.cjs");
const { verifyApprovedDeploymentRun } = require("./monitor-recovery.cjs");
const { MonitorStore } = require("./monitor-state.cjs");
const { verifyMonitorIssue } = require("./monitor-origin.cjs");

const { REPOSITORY, OWNER, SHA } = policy;
const WORKFLOW = `${REPOSITORY}/.github/workflows/factory-ticket-closure.yml@refs/heads/main`;
const DEPLOY_PATH = ".github/workflows/factory-deploy.yml";
const validId = (id) => /^[1-9]\d{0,15}$/.test(id || "") && Number.isSafeInteger(Number(id));
const OWNER_ID = 101267861;
const BOT_ID = 41898282;
const MAX_CANDIDATES = 12;
const MAX_CLOSURES = 5;

function dispatchContext(context, event) {
  const preview = context.eventName === "workflow_dispatch";
  const wake = context.eventName === "workflow_run";
  const source = event.workflow_run;
  if (
    context.repository !== REPOSITORY ||
    context.ref !== "refs/heads/main" ||
    context.workflowRef !== WORKFLOW ||
    !SHA.test(context.workflowSha || "") ||
    context.sha !== context.workflowSha ||
    !validId(context.runId) ||
    context.runAttempt !== "1" ||
    context.actor !== context.triggeringActor ||
    (wake
      ? event.action !== "completed" ||
        event.repository?.full_name !== REPOSITORY ||
        source?.path !== DEPLOY_PATH ||
        source.repository?.full_name !== REPOSITORY ||
        source.head_repository?.full_name !== REPOSITORY ||
        source.head_branch !== "main" ||
        source.run_attempt !== 1 ||
        source.status !== "completed" ||
        source.conclusion !== "success" ||
        !SHA.test(source.head_sha || "") ||
        source.actor?.login !== context.actor ||
        !runActorOK(source)
      : !["workflow_dispatch", "schedule"].includes(context.eventName) || context.actor !== OWNER)
  )
    throw Error("Untrusted ticket closure context");
  const runId = wake ? String(source.id) : preview ? event.inputs?.deployment_run_id : null;
  const ticket = preview ? event.inputs?.ticket : null;
  if ((runId !== null && !validId(runId)) || (preview && !validId(ticket)))
    throw Error("Invalid ticket closure input");
  return { preview, runId, ticket: ticket === null ? null : Number(ticket) };
}

function ticketEvidence(state, number) {
  const ticket = state.tickets[String(number)];
  const { automatic, ci, approval, merge } = ticket || {};
  const grant = approval && state.grants[approval.grant];
  if (
    ticket?.origin !== "factory" ||
    ticket.status !== "reviewed" ||
    !automatic ||
    !SHA.test(ticket.head || "") ||
    !Number.isSafeInteger(ticket.pr) ||
    !/^[a-f0-9]{64}$/.test(ticket.criteriaHash || "") ||
    (ticket.monitor && ticket.monitor.probeMode !== "functional-browser") ||
    activeFor(state, number) ||
    Object.values(state.grants).some((g) => g.ticket === number && g.status === "reserved") ||
    !ci?.passed ||
    ci.head !== ticket.head ||
    merge?.status !== "merged" ||
    !SHA.test(merge.mergeCommit || "") ||
    merge.pr !== ticket.pr ||
    merge.head !== ticket.head ||
    approval?.pr !== ticket.pr ||
    approval.head !== ticket.head ||
    grant?.ticket !== number ||
    !policy.reviewGate(state, { number: ticket.pr, head: ticket.head }).ok
  )
    return null;
  return ticket;
}

function issueMatches(issue, number, ticket) {
  const fromBot = Boolean(ticket.monitor || ticket.finding);
  return (
    issue.number === number &&
    !issue.pull_request &&
    issue.user?.id === (fromBot ? BOT_ID : OWNER_ID) &&
    issue.user.login === (fromBot ? "github-actions[bot]" : OWNER) &&
    issue.user.type === (fromBot ? "Bot" : "User") &&
    issue.labels?.some((label) => label.name === "factory-ready") &&
    criteriaHash(issue) === ticket.criteriaHash
  );
}

async function trustedOrigin(api, issue, ticket) {
  if (ticket.monitor) {
    const proof = await verifyMonitorIssue(api, issue, {
      proof: ticket.monitor,
      requireActive: false,
    });
    if (!proof) return false;
    const { state } = await new MonitorStore(api, "functional").read();
    const incident = state.incidents[proof.incidentId];
    return state.active === proof.incidentId && incident?.recovered === true;
  }
  if (ticket.finding)
    return require("./discovery-origin.cjs").verifyRepairOrigin(api, issue, ticket.finding);
  return true;
}

const ancestor = (comparison, base) =>
  comparison.status === "ahead" &&
  comparison.behind_by === 0 &&
  comparison.base_commit?.sha === base &&
  comparison.merge_base_commit?.sha === base;

async function releaseContainsRepair(api, pr, merge, release) {
  if (merge === release) return true;
  const comparison = await api.request("GET", `${ROOT}/compare/${merge}...${release}`);
  // GitHub limits compare responses to 300 files. Hold at the truncation
  // boundary or when a later change, including a revert, touches the repair.
  if (
    !ancestor(comparison, merge) ||
    !Array.isArray(comparison.files) ||
    comparison.files.length >= 300
  )
    return false;
  if (!Number.isSafeInteger(pr.changed_files) || pr.changed_files < 1 || pr.changed_files > 100)
    return false;
  const original = await api.request("GET", `${ROOT}/pulls/${pr.number}/files?per_page=100`);
  const names = (files) =>
    files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean));
  if (
    !Array.isArray(original) ||
    original.length !== pr.changed_files ||
    [...original, ...comparison.files].some(
      (file) => typeof file?.filename !== "string" || !file.filename
    )
  )
    return false;
  const repairPaths = new Set(names(original));
  return !names(comparison.files).some((name) => repairPaths.has(name));
}

async function isLiveRelease(verifyLive, release) {
  try {
    const live = await verifyLive({
      sha: release,
      timeoutMs: 20000,
      intervalMs: 2000,
      requestTimeoutMs: 5000,
    });
    return (
      live?.release === release &&
      live.health === true &&
      live.ready === true &&
      live.frontend === true
    );
  } catch {
    return false;
  }
}

async function inspectRepair(api, issue, ticket, release) {
  const number = issue.number;
  if (!issueMatches(issue, number, ticket) || !(await trustedOrigin(api, issue, ticket)))
    return { reason: "issue_or_origin_changed" };
  const pr = await api.request("GET", `${ROOT}/pulls/${ticket.pr}`);
  if (
    pr.number !== ticket.pr ||
    pr.merged !== true ||
    pr.state !== "closed" ||
    pr.merge_commit_sha !== ticket.merge.mergeCommit ||
    pr.head?.sha !== ticket.head ||
    pr.head?.ref !== `agent/factory-${number}` ||
    pr.head.repo?.full_name !== REPOSITORY ||
    pr.base?.repo?.full_name !== REPOSITORY ||
    pr.base.ref !== "main" ||
    pr.user?.type !== "Bot" ||
    pr.user?.login !== `${ticket.automatic.appSlug}[bot]` ||
    !(await releaseContainsRepair(api, pr, ticket.merge.mergeCommit, release))
  )
    return { reason: "repair_not_preserved_in_release" };
  return { proof: { issue: number, pr: pr.number, merge: ticket.merge.mergeCommit } };
}

async function deployedRun(api, context, id, expectedRelease) {
  const run = await api.request("GET", `${ROOT}/actions/runs/${id}/attempts/1`);
  if (
    String(run.id) !== String(id) ||
    !runActorOK(run) ||
    !SHA.test(run.head_sha || "") ||
    (expectedRelease && run.head_sha !== expectedRelease)
  )
    throw Error("Untrusted deployment for ticket closure");
  await verifyApprovedDeploymentRun(api, run, run.head_sha, context);
  return run;
}

async function latestDeployment(api, context, release) {
  if (!SHA.test(release || "")) return null;
  const { workflow_runs: rows } = await api.request(
    "GET",
    `${ROOT}/actions/workflows/factory-deploy.yml/runs?branch=main&head_sha=${release}&per_page=5`
  );
  if (!Array.isArray(rows) || rows.length > 5) throw Error("Invalid catch-up deployment list");
  for (const row of rows) {
    if (row.head_sha !== release || !validId(row.id)) continue;
    const verified = await deployedRun(api, context, row.id, release).catch(() => null);
    if (verified) return verified;
  }
  return null;
}

async function runClosure({
  api,
  context,
  event,
  enabled,
  ledger = new Ledger(api),
  verifyLive = waitForRelease,
  readLiveRelease = currentRelease,
}) {
  const { preview, runId, ticket: target } = dispatchContext(context, event);
  const result = {
    outcome: preview ? "preview" : "completed",
    release: null,
    eligible: [],
    closed: [],
    held: [],
  };
  if (!preview && !enabled) return { ...result, outcome: "disabled" };
  const { state } = await ledger.read();
  if (!preview && state.stop) return { ...result, outcome: "stopped" };
  const issues = preview
    ? [await api.request("GET", `${ROOT}/issues/${target}`)]
    : await api.pages(`${ROOT}/issues?state=open&labels=factory-ready`);
  const candidates = issues.filter((i) => i.state === "open" && ticketEvidence(state, i.number));
  if (!candidates.length) {
    if (preview) result.held.push({ issue: target, reason: "no_open_reviewed_factory_repair" });
    return result;
  }

  const run = runId
    ? await deployedRun(api, context, runId, event.workflow_run?.head_sha)
    : await latestDeployment(api, context, await readLiveRelease().catch(() => null));
  if (!run) return { ...result, outcome: "no_approved_deployment" };
  const release = run.head_sha;
  if (
    release !== context.workflowSha &&
    !ancestor(
      await api.request("GET", `${ROOT}/compare/${release}...${context.workflowSha}`),
      release
    )
  )
    throw Error("Deployed release is outside trusted main history");
  result.release = release;
  result.deployment = run.id;
  if (!(await isLiveRelease(verifyLive, release)))
    return { ...result, outcome: "live_release_unverified" };

  // Rotate the bounded batch only when a backlog exceeds one work unit.
  const offset = candidates.length > MAX_CANDIDATES ? Number(context.runId) % candidates.length : 0;
  const batch = [...candidates.slice(offset), ...candidates.slice(0, offset)].slice(
    0,
    MAX_CANDIDATES
  );
  for (const issue of batch) {
    if (result.closed.length >= MAX_CLOSURES) break;
    const number = issue.number;
    const ticket = ticketEvidence(state, number);
    const { reason, proof } = await inspectRepair(api, issue, ticket, release).catch(() => ({
      reason: "repair_proof_unavailable",
    }));
    if (reason) {
      result.held.push({ issue: number, reason });
      continue;
    }
    result.eligible.push(proof);
    if (preview) continue;

    // A release switch, emergency stop, relabel or changed criteria can arrive
    // during proof collection. Re-read before the only write.
    const originStillTrusted = await trustedOrigin(api, issue, ticket).catch(() => false);
    if (!(await isLiveRelease(verifyLive, release)))
      return { ...result, outcome: "live_release_unverified" };
    const [{ state: fresh }, before] = await Promise.all([
      ledger.read(),
      api.request("GET", `${ROOT}/issues/${number}`),
    ]);
    policy.assertNotStopped(fresh);
    if (
      !originStillTrusted ||
      before.state !== "open" ||
      !issueMatches(before, number, ticket) ||
      JSON.stringify(ticketEvidence(fresh, number)) !== JSON.stringify(ticket)
    ) {
      result.held.push({ issue: number, reason: "repair_or_issue_changed_before_close" });
      continue;
    }
    try {
      await api.request("PATCH", `${ROOT}/issues/${number}`, {
        state: "closed",
        state_reason: "completed",
      });
    } catch {
      // GitHub may have applied a request whose response was lost. The
      // authoritative read below decides the result. Never replay the write.
    }
    const after = await api.request("GET", `${ROOT}/issues/${number}`);
    if (
      !issueMatches(after, number, ticket) ||
      after.state !== "closed" ||
      after.state_reason !== "completed"
    )
      throw Error("Ticket closure could not be confirmed");
    result.closed.push(proof);
  }
  return result;
}

async function main(env = process.env) {
  policy.assertSubscriptionEnv(env);
  if (fs.statSync(env.GITHUB_EVENT_PATH).size > 1000000) throw Error("Invalid closure event");
  const result = await runClosure({
    api: new GitHub({ token: env.GITHUB_TOKEN, retryReads: true }),
    context: contextFromEnv(env),
    event: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
    enabled: env.FACTORY_ENABLED === "true" && env.FACTORY_AUTOMATION_ENABLED === "true",
  });
  const output = JSON.stringify(result, null, 2);
  fs.appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    `## Verified repair ticket closure\n\n\`\`\`json\n${output}\n\`\`\`\n`
  );
  console.log(output);
}

if (require.main === module)
  main().catch(() => {
    console.error("Ticket closure held. Inspect the trusted deployment and repair evidence.");
    process.exitCode = 1;
  });

module.exports = { runClosure };
