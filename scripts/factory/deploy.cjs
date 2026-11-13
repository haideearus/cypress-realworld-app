const fs = require("node:fs");
const path = require("node:path");
const { GitHub, ROOT } = require("./github.cjs");
const { APP_URL, triggerDeploy, waitForRelease } = require("./deploy-render.cjs");

const REPOSITORY = "haideearus/cypress-realworld-app";
const OWNER = "haideearus";
const WORKFLOW = `${REPOSITORY}/.github/workflows/factory-deploy.yml@refs/heads/main`;
const SHA = /^[a-f0-9]{40}$/;
class DeploymentError extends Error {}
function requireThat(condition, code) {
  if (!condition) throw new DeploymentError(code);
}
function id(value) {
  const text = String(value ?? "");
  requireThat(/^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)), "invalid_id");
  return text;
}
function assertContext(context) {
  requireThat(
    context.repository === REPOSITORY &&
      context.ref === "refs/heads/main" &&
      context.workflowRef === WORKFLOW &&
      SHA.test(context.workflowSha || "") &&
      context.sha === context.workflowSha &&
      context.runAttempt === "1" &&
      ["workflow_run", "workflow_dispatch"].includes(context.eventName) &&
      (context.eventName !== "workflow_dispatch" ||
        (context.actor === OWNER && context.triggeringActor === OWNER)),
    "untrusted_context"
  );
  id(context.runId);
}

async function prepareCandidate({ api, context, event, ciRunId }) {
  assertContext(context);
  const runId = id(ciRunId);
  const eventId =
    context.eventName === "workflow_run" ? event.workflow_run?.id : event.inputs?.ci_run_id;
  requireThat(id(eventId) === runId, "ci_input_mismatch");
  const workflow = await api.request("GET", `${ROOT}/actions/workflows/factory-ci.yml`);
  const run = await api.request("GET", `${ROOT}/actions/runs/${runId}`);
  requireThat(
    String(run.id) === runId &&
      Number.isSafeInteger(workflow.id) &&
      workflow.id > 0 &&
      run.workflow_id === workflow.id &&
      workflow.path === ".github/workflows/factory-ci.yml" &&
      run.path === ".github/workflows/factory-ci.yml" &&
      run.repository?.full_name === REPOSITORY &&
      run.head_repository?.full_name === REPOSITORY &&
      run.event === "push" &&
      run.head_branch === "main" &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      SHA.test(run.head_sha || "") &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0,
    "ci_not_eligible"
  );
  const jobs = await api.pages(
    `${ROOT}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs`,
    "jobs"
  );
  const verifies = jobs.filter((job) => job.name === "verify");
  requireThat(
    verifies.length === 1 &&
      verifies[0].status === "completed" &&
      verifies[0].conclusion === "success" &&
      verifies[0].head_sha === run.head_sha,
    "ci_verify_missing"
  );
  const main = await api.request("GET", `${ROOT}/git/ref/heads/main`);
  requireThat(
    run.head_sha === main.object?.sha && run.head_sha === context.workflowSha,
    "stale_candidate"
  );
  return { sha: run.head_sha, ciRunId: runId, ciAttempt: run.run_attempt };
}

async function humanApproval(api, context, now) {
  const rows = await api.request("GET", `${ROOT}/actions/runs/${id(context.runId)}/approvals`);
  requireThat(Array.isArray(rows), "approval_required");
  const production = rows.filter(
    (row) =>
      Array.isArray(row.environments) && row.environments.some((env) => env.name === "production")
  );
  // A new, first-attempt run has one production decision. Never infer ordering
  // or approval time from this API: neither is documented in its response.
  requireThat(production.length === 1, "approval_required");
  const review = production[0];
  const environment = review.environments.find((env) => env.name === "production");
  requireThat(
    review.state === "approved" &&
      review.user?.login === OWNER &&
      review.user.type === "User" &&
      Number.isSafeInteger(environment.id) &&
      environment.id > 0,
    "approval_required"
  );
  return {
    actor: OWNER,
    environment: "production",
    environmentId: environment.id,
    observedAt: now(),
  };
}

async function performDeployment(options) {
  const {
    api,
    context,
    event,
    ciRunId,
    expectedSha,
    expectedCiAttempt,
    hook,
    trigger = triggerDeploy,
    verify = waitForRelease,
    evidence = {},
    now = () => new Date().toISOString(),
  } = options;
  evidence.outcome = "not_verified";
  evidence.phase = "validate_candidate";
  const candidate = await prepareCandidate({ api, context, event, ciRunId });
  requireThat(
    candidate.sha === expectedSha && String(candidate.ciAttempt) === expectedCiAttempt,
    "candidate_changed"
  );
  Object.assign(evidence, {
    version: 1,
    repository: REPOSITORY,
    appUrl: APP_URL,
    deploymentRunId: context.runId,
    deploymentRunAttempt: 1,
    candidate,
    startedAt: now(),
    hookAttempted: false,
  });
  evidence.phase = "validate_approval";
  evidence.approval = await humanApproval(api, context, now);
  // Approval may have waited while new main commits or a new CI attempt arrived.
  const current = await prepareCandidate({ api, context, event, ciRunId });
  requireThat(JSON.stringify(current) === JSON.stringify(candidate), "candidate_changed");
  evidence.phase = "request_deploy";
  evidence.hookAttempted = true;
  evidence.hookAttemptedAt = now();
  const response = await trigger({ hook, sha: candidate.sha });
  evidence.render = {
    httpStatus: response.httpStatus,
    deployId: response.deployId,
  };
  evidence.phase = "verify_release";
  const live = await verify({ sha: candidate.sha });
  requireThat(
    live.release === candidate.sha &&
      live.health === true &&
      live.ready === true &&
      live.frontend === true,
    "release_not_verified"
  );
  evidence.live = {
    release: live.release,
    health: true,
    ready: true,
    frontend: true,
    observedAt: live.observedAt,
  };
  evidence.phase = "complete";
  evidence.outcome = "verified";
  evidence.finishedAt = now();
  return evidence;
}

function contextFromEnv(env) {
  return {
    repository: env.GITHUB_REPOSITORY,
    ref: env.GITHUB_REF,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    sha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    eventName: env.GITHUB_EVENT_NAME,
    actor: env.GITHUB_ACTOR,
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
  };
}

async function main(env = process.env) {
  const evidence = { version: 1, outcome: "not_verified", phase: "startup", hookAttempted: false };
  try {
    const operation = process.argv[2];
    requireThat(["prepare", "deploy"].includes(operation), "invalid_operation");
    const context = contextFromEnv(env);
    assertContext(context);
    requireThat(fs.statSync(env.GITHUB_EVENT_PATH).size <= 1000000, "invalid_event");
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const api = new GitHub({ token: env.GITHUB_TOKEN });
    const options = { api, context, event, ciRunId: env.CI_RUN_ID };
    if (operation === "prepare") {
      const candidate = await prepareCandidate(options);
      Object.assign(evidence, { phase: "awaiting_approval", outcome: "prepared", candidate });
      fs.appendFileSync(
        env.GITHUB_OUTPUT,
        `sha=${candidate.sha}\nci_attempt=${candidate.ciAttempt}\nci_run_id=${candidate.ciRunId}\n`
      );
      fs.appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `## Production deployment awaits your approval\n\nCommit: \`${candidate.sha}\`\n\n[Successful main CI](https://github.com/${REPOSITORY}/actions/runs/${candidate.ciRunId})\n\nTarget: ${APP_URL}\n\nOnly haideearus may approve the production job. If main advances, start a fresh run for its successful CI.\n`
      );
    } else {
      await performDeployment({
        ...options,
        expectedSha: env.DEPLOY_EXPECTED_SHA,
        expectedCiAttempt: env.DEPLOY_EXPECTED_CI_ATTEMPT,
        hook: env.RENDER_DEPLOY_HOOK_URL,
        evidence,
      });
    }
  } catch (error) {
    evidence.outcome = "not_verified";
    evidence.reason =
      error instanceof DeploymentError ? error.message : "request_or_verification_failed";
    // Never print raw transport errors, remote bodies, or credential-bearing URLs.
    console.error(
      `Deployment stopped: ${evidence.reason}. A fresh run and approval are required for retry.`
    );
    process.exitCode = 1;
  } finally {
    const dir = path.join(env.RUNNER_TEMP, "factory-deployment");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `\n## Deployment evidence\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`
    );
  }
}

if (require.main === module)
  main().catch(() => {
    console.error("Could not write sanitized deployment evidence.");
    process.exitCode = 1;
  });
module.exports = { prepareCandidate, performDeployment, contextFromEnv };
