const fs = require("node:fs");
const { createHash } = require("node:crypto");
const policy = require("./policy.cjs");
const { GitHub, Ledger, ROOT } = require("./github.cjs");
const { MonitorStore } = require("./monitor-state.cjs");
const { observeIncident, validateObservation } = require("./monitor.cjs");
const { criteriaHash, runtimeContext, readJson, output } = require("./controller.cjs");
const { isDrillContext, DRILL_PATH, DRILL_TEST_PATH } = require("./drill-contract.cjs");
const fixture = require("./drill-fixture.cjs");
const { checkFixture } = require("./drill-sandbox.cjs");
const { verifyBundle, validateReport } = require("./drill-verify.cjs");
const WORKFLOW = ".github/workflows/factory-monitor-drill.yml";
const iso = () => new Date().toISOString();
function assertContext(context) {
  if (!isDrillContext(context) || context.sha !== context.workflowSha)
    throw new Error("Untrusted drill context");
}
function time(value) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("Invalid drill time");
  return value;
}
function apiTime(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("Missing cloud step timestamp");
  return new Date(value).toISOString();
}
function runnerEvidence(job) {
  const safe = (value) =>
    typeof value === "string" && /^[A-Za-z0-9_. /-]{1,160}$/.test(value) ? value : "unavailable";
  return {
    jobId: Number.isSafeInteger(job.id) ? job.id : null,
    runnerId: Number.isSafeInteger(job.runner_id) ? job.runner_id : null,
    runnerName: safe(job.runner_name),
    labels: Array.isArray(job.labels) ? job.labels.slice(0, 10).map(safe) : [],
  };
}
function observation(value) {
  return validateObservation({
    healthy: value.healthy,
    checks: {
      health: value.checks.health,
      readiness: value.checks.readiness,
      frontend: value.checks.frontend,
    },
    attempts: value.attempts,
    ...(value.release ? { release: value.release } : {}),
  });
}
function failedBaseline(value) {
  if (
    value?.healthy !== false ||
    value.checks?.health !== "ok" ||
    value.checks?.readiness !== "failed" ||
    value.checks?.frontend !== "ok" ||
    value.checks?.regression !== "failed"
  )
    throw new Error("The isolated baseline did not demonstrate the expected defect");
  return observation(value);
}
function drillIssueText(incident) {
  return {
    title: "[DRILL] Repair the isolated readiness response",
    body: `## Isolated cloud rehearsal\n\nThis is a synthetic fixture, not a production incident.\nIncident: ${incident.id}\nObserved at: ${incident.at}\nEvidence: https://github.com/${policy.REPOSITORY}/actions/runs/${incident.source.runId}\n\n## Repair contract\n\nEdit only \`${DRILL_PATH}\`. The fixture must return HTTP 200 and JSON {"status":"ok"} for /readyz. Keep /healthz, its supplied release SHA, the frontend root marker and unknown-route behavior intact. The trusted seeded regression and HTTP oracle will measure the before/after behavior. Do not change tests, helpers, dependencies or instructions.\n\nYou have file tools only. Do not execute commands or claim you ran tests. Save a short factual change explanation to .factory-output/evidence.md; verification happens in a separate credential-free sandbox.\n\nOne Claude subscription coding attempt only. No retries, production admission, PR, AI review, merge or deployment. This issue is never factory-ready. If the repair fails, stop with the consumed usage and unresolved incident preserved.\n`,
  };
}
function counters(state, ticket, now) {
  return {
    daily: (state.days[policy.dayKey(new Date(now), "Europe/Bucharest")] || []).length,
    coding: ticket ? state.tickets[String(ticket)]?.coding || 0 : 0,
    reviews: ticket ? state.tickets[String(ticket)]?.reviews || 0 : 0,
    retries: ticket ? state.tickets[String(ticket)]?.retries || 0 : 0,
  };
}
class DrillCoordinator {
  constructor(
    api,
    config,
    context,
    {
      ledger = new Ledger(api),
      store = new MonitorStore(api, "drill"),
      check = checkFixture,
      now = iso,
    } = {}
  ) {
    Object.assign(this, { api, config, context, ledger, store, check, now });
  }
  async preview() {
    assertContext(this.context);
    const { state } = await this.ledger.read();
    const { state: registry } = await this.store.read();
    return {
      outcome: "preview",
      synthetic: true,
      ready: false,
      modelCalls: 0,
      prerequisites: {
        factoryEnabled: this.config.enabled,
        automaticPickupOff: !this.config.automatic,
        automaticMergeOff: !this.config.autoMerge,
        ledgerIdle: state.active === null,
        drillRegistryIdle: registry.active === null,
        dailyAvailable: counters(state, null, this.now()).daily < this.config.daily,
      },
      maximumCodingSessions: 1,
      maximumRetries: 0,
      maximumReviews: 0,
    };
  }
  available(state, at) {
    if (
      state.active ||
      !this.config.coding ||
      !this.config.minutes ||
      !this.config.turns ||
      counters(state, null, at).daily >= this.config.daily
    )
      throw new Error("Drill needs an idle ledger and available existing allowance");
  }
  async ready() {
    assertContext(this.context);
    if (!this.config.enabled) return false;
    if (this.config.automatic || this.config.autoMerge)
      throw new Error("Turn automatic pickup and merging off before a live drill");
    const { state } = await this.ledger.read();
    this.available(state, time(this.now()));
    const { state: registry } = await this.store.read();
    if (
      registry.active ||
      Object.values(registry.incidents).some((item) => item.source.runId === this.context.runId)
    )
      throw new Error("An existing drill receipt requires owner attention");
    return true;
  }
  async seed() {
    const branch = `factory/drill-${this.context.runId}`;
    try {
      await this.api.request("GET", `${ROOT}/git/ref/heads/${branch}`);
      throw new Error("Drill branch already exists; do not replay publication");
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    const source = await this.api.request("GET", `${ROOT}/git/commits/${this.context.workflowSha}`);
    if (!policy.SHA.test(source.tree?.sha || "")) throw new Error("Invalid drill source tree");
    const entries = [];
    for (const [path, content] of [
      [DRILL_PATH, fixture.brokenSource],
      [DRILL_TEST_PATH, fixture.regressionSource],
    ]) {
      if (typeof content !== "string" || !content) throw new Error("Invalid trusted drill fixture");
      const blob = await this.api.request("POST", `${ROOT}/git/blobs`, {
        content,
        encoding: "utf-8",
      });
      if (!policy.SHA.test(blob.sha || "")) throw new Error("Invalid fixture blob acknowledgement");
      entries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const tree = await this.api.request("POST", `${ROOT}/git/trees`, {
      base_tree: source.tree.sha,
      tree: entries,
    });
    if (!policy.SHA.test(tree.sha || "")) throw new Error("Invalid fixture tree acknowledgement");
    const commit = await this.api.request("POST", `${ROOT}/git/commits`, {
      message: `[DRILL] Isolated readiness fixture for run ${this.context.runId}`,
      tree: tree.sha,
      parents: [this.context.workflowSha],
    });
    if (!policy.SHA.test(commit.sha || ""))
      throw new Error("Invalid fixture commit acknowledgement");
    const ref = await this.api.request("POST", `${ROOT}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
    if (ref.object?.sha !== commit.sha || ref.ref !== `refs/heads/${branch}`)
      throw new Error("Unacknowledged drill branch publication");
    return { head: commit.sha, branch };
  }
  async ensureLabel() {
    let label;
    try {
      label = await this.api.request("GET", `${ROOT}/labels/factory-drill`);
    } catch (error) {
      if (error.status !== 404) throw error;
      label = await this.api.request("POST", `${ROOT}/labels`, {
        name: "factory-drill",
        color: "735c0f",
        description: "Isolated rehearsal; never production maintenance",
      });
    }
    if (label.name !== "factory-drill") throw new Error("Drill label acknowledgement missing");
  }
  async prepare() {
    if (!(await this.ready())) return { outcome: "disabled", ready: false };
    const startedAt = time(this.now());
    const baseline = await this.check(fixture.brokenSource, { release: this.context.workflowSha });
    const observed = failedBaseline(baseline);
    const { head, branch } = await this.seed();
    await this.ensureLabel();
    const args = {
      api: this.api,
      context: this.context,
      store: this.store,
      observation: observed,
      now: this.now,
      issueText: drillIssueText,
      labels: ["factory-drill"],
    };
    const created = await observeIncident(args);
    if (created.outcome !== "incident_created")
      throw new Error("Drill incident was not newly published");
    const repeated = await observeIncident(args);
    if (repeated.outcome !== "incident_existing" || repeated.issue !== created.issue)
      throw new Error("Drill deduplication failed");
    const { state: registry, commit: registryCommit } = await this.store.read();
    const incident = registry.incidents[registry.active];
    if (
      !incident ||
      incident.issue !== created.issue ||
      incident.source.runId !== this.context.runId
    )
      throw new Error("Drill publication receipt changed");
    const ticket = created.issue;
    const before = await this.ledger.read();
    const saved = await this.ledger.update(async (state) => {
      this.available(state, time(this.now()));
      const issue = await this.api.request("GET", `${ROOT}/issues/${ticket}`);
      this.matchIssue(issue, incident);
      const { state: current } = await this.store.read();
      if (
        current.active !== incident.id ||
        JSON.stringify(current.incidents[incident.id]) !== JSON.stringify(incident)
      )
        throw new Error("Drill receipt changed before reservation");
      const request = {
        ...this.context,
        ticket,
        head,
        phase: "code",
        slot: "drill",
        origin: "drill",
        drill: {
          runId: this.context.runId,
          runAttempt: 1,
          workflowRef: this.context.workflowRef,
          workflowSha: this.context.workflowSha,
          seedSha: head,
          incidentId: incident.id,
        },
      };
      const result = policy.reserve(state, request, this.config, new Date(this.now()));
      result.state.tickets[String(ticket)].criteriaHash = incident.criteriaHash;
      return result;
    });
    const after = saved.state;
    const grant = saved.grant;
    return {
      outcome: "reserved",
      ready: true,
      synthetic: true,
      ticket,
      grantId: grant.id,
      head,
      incidentId: incident.id,
      branch,
      registryCommit,
      deduplicated: true,
      baseline,
      startedAt,
      admittedAt: time(this.now()),
      countersBefore: counters(before.state, null, startedAt),
      countersAfter: counters(after, ticket, startedAt),
      identity: {
        grantId: grant.id,
        head,
        seedSha: head,
        runId: this.context.runId,
        runAttempt: 1,
        workflowSha: this.context.workflowSha,
      },
    };
  }
  matchIssue(issue, incident) {
    if (
      issue.number !== incident.issue ||
      issue.pull_request ||
      issue.user?.login !== "github-actions[bot]" ||
      issue.user?.type !== "Bot" ||
      !["open", "closed"].includes(issue.state) ||
      criteriaHash(issue) !== incident.criteriaHash
    )
      throw new Error("Drill issue identity or criteria changed");
  }
  async terminalJobs() {
    const run = await this.api.request(
      "GET",
      `${ROOT}/actions/runs/${this.context.runId}/attempts/1`
    );
    if (
      String(run.id) !== this.context.runId ||
      run.run_attempt !== 1 ||
      run.head_sha !== this.context.workflowSha ||
      run.head_branch !== "main" ||
      run.event !== "workflow_dispatch" ||
      run.path !== WORKFLOW ||
      run.repository?.full_name !== policy.REPOSITORY ||
      run.head_repository?.full_name !== policy.REPOSITORY ||
      run.actor?.login !== policy.OWNER ||
      run.triggering_actor?.login !== policy.OWNER
    )
      throw new Error("Drill run provenance changed");
    const response = await this.api.request(
      "GET",
      `${ROOT}/actions/runs/${this.context.runId}/attempts/1/jobs?per_page=100`
    );
    if (!Array.isArray(response.jobs) || response.total_count !== response.jobs.length)
      throw new Error("Unbounded or incomplete drill job list");
    const coding = response.jobs.filter((j) => j.name === "coding / agent");
    const verification = response.jobs.filter((j) => j.name === "Verify isolated recovery");
    const window = response.jobs.filter((j) => j.name === "Preview or PC shutdown window");
    if (
      coding.length !== 1 ||
      coding[0].status !== "completed" ||
      verification.length !== 1 ||
      verification[0].status !== "completed"
    )
      throw new Error("Wait for terminal coding and verification jobs before cleanup");
    const wait =
      window.length === 1 &&
      window[0].steps?.filter(
        (step) =>
          step.name === "Allow 90 seconds for the owner to shut down their PC" &&
          step.conclusion === "success"
      );
    if (window[0]?.conclusion !== "success" || !wait || wait.length !== 1)
      throw new Error("Missing completed PC shutdown window");
    for (const [job, stepName] of [
      [coding[0], "Run the one reserved Claude subscription session"],
      [verification[0], "Measure baseline and candidate in the isolated sandbox"],
    ]) {
      if (
        job.conclusion === "success" &&
        job.steps?.filter((step) => step.name === stepName && step.conclusion === "success")
          .length !== 1
      )
        throw new Error("Successful drill job is missing its trusted execution step");
    }
    const session = coding[0].steps?.find(
      (step) =>
        step.name === "Run the one reserved Claude subscription session" &&
        step.conclusion === "success"
    );
    return {
      coding: coding[0].conclusion,
      verification: verification[0].conclusion,
      cloud: {
        shutdownWindow: {
          startedAt: apiTime(wait[0].started_at),
          finishedAt: apiTime(wait[0].completed_at),
        },
        coding: {
          ...runnerEvidence(coding[0]),
          ...(session
            ? {
                sessionStartedAt: apiTime(session.started_at),
                sessionFinishedAt: apiTime(session.completed_at),
              }
            : {}),
        },
        verification: runnerEvidence(verification[0]),
      },
    };
  }
  async finalize({ prepared, bundle, report }) {
    assertContext(this.context);
    const loaded = await this.ledger.read();
    const grant = loaded.state.grants[prepared?.grantId];
    const ticket = grant && loaded.state.tickets[String(grant.ticket)];
    if (
      !grant ||
      grant.status !== "reserved" ||
      ticket?.origin !== "drill" ||
      grant.runId !== this.context.runId ||
      grant.runAttempt !== 1 ||
      grant.head !== prepared.head ||
      grant.ticket !== prepared.ticket ||
      ticket.drill.workflowSha !== this.context.workflowSha ||
      ticket.drill.incidentId !== prepared.incidentId
    )
      throw new Error("Drill finalization does not match its reservation");
    const jobs = await this.terminalJobs();
    let verified = false;
    let bundleSha256;
    if (jobs.coding === "success" && jobs.verification === "success") {
      const artifact = verifyBundle({ bundle, grantId: grant.id, head: grant.head });
      bundleSha256 = artifact.bundleSha256;
      const expected = {
        grantId: grant.id,
        head: grant.head,
        seedSha: ticket.drill.seedSha,
        runId: this.context.runId,
        runAttempt: 1,
        workflowSha: this.context.workflowSha,
        bundleSha256,
      };
      validateReport(report, expected);
      if (
        Date.parse(report.startedAt) < Date.parse(grant.at) ||
        Date.parse(report.finishedAt) > Date.parse(this.now())
      )
        throw new Error("Verification timestamps fall outside this reserved attempt");
      verified = report.healthy === true;
      if (!verified) throw new Error("Successful verification job did not prove recovery");
    }
    const { state: registry } = await this.store.read();
    const incident = registry.incidents[prepared.incidentId];
    if (
      !incident ||
      registry.active !== incident.id ||
      incident.issue !== grant.ticket ||
      incident.criteriaHash !== ticket.criteriaHash ||
      incident.source.runId !== this.context.runId ||
      incident.source.workflowSha !== this.context.workflowSha
    )
      throw new Error("Drill incident does not match finalization");
    const issue = await this.api.request("GET", `${ROOT}/issues/${grant.ticket}`);
    this.matchIssue(issue, incident);
    if (verified) {
      const options = {
        api: this.api,
        context: this.context,
        store: this.store,
        now: this.now,
        issueText: drillIssueText,
        labels: ["factory-drill"],
        observation: observation(report.candidate),
      };
      await observeIncident(options);
      if (issue.state === "open") {
        const closed = await this.api.request("PATCH", `${ROOT}/issues/${grant.ticket}`, {
          state: "closed",
          state_reason: "completed",
        });
        this.matchIssue(closed, incident);
        if (closed.state !== "closed") throw new Error("Drill close was not acknowledged");
      }
      await observeIncident(options);
      const cleared = await this.store.read();
      if (cleared.state.active !== null || !cleared.state.incidents[incident.id]?.recovered)
        throw new Error("Drill recovery cleanup was not acknowledged");
    }
    const finished = await this.ledger.update((state) => {
      const current = state.grants[grant.id];
      if (
        current?.status !== "reserved" ||
        current.runId !== this.context.runId ||
        current.runAttempt !== 1 ||
        current.head !== grant.head ||
        state.tickets[String(grant.ticket)]?.origin !== "drill"
      )
        throw new Error("Drill reservation changed before cleanup");
      const next = policy.finish(
        state,
        grant.id,
        { status: verified ? "drill_complete" : "blocked" },
        new Date(this.now())
      );
      next.tickets[String(grant.ticket)].feedback = verified
        ? "Isolated drill verified; no production approval, PR or deployment."
        : "Isolated drill failed; no automatic retry. Inspect evidence before owner recovery.";
      return { state: next };
    });
    return {
      outcome: verified ? "drill_complete" : "blocked",
      synthetic: true,
      runId: this.context.runId,
      runAttempt: 1,
      workflowSha: this.context.workflowSha,
      seedSha: grant.head,
      grantId: grant.id,
      issue: grant.ticket,
      issueUrl: `https://github.com/${policy.REPOSITORY}/issues/${grant.ticket}`,
      registryUrl: `https://github.com/${policy.REPOSITORY}/blob/factory/monitor-drill/monitor.json`,
      deduplicated: prepared.deduplicated,
      startedAt: prepared.startedAt,
      finishedAt: time(this.now()),
      countersBefore: prepared.countersBefore,
      countersAfter: counters(finished.state, grant.ticket, this.now()),
      ...(verified
        ? {
            baseline: report.baseline,
            candidate: report.candidate,
            bundleSha256,
            verificationSha256: createHash("sha256").update(JSON.stringify(report)).digest("hex"),
          }
        : {}),
      productionApproval: false,
      automaticRetries: 0,
      cloud: jobs.cloud,
    };
  }
}
async function main(env = process.env) {
  policy.assertSubscriptionEnv(env);
  const config = policy.readConfig(JSON.parse(env.FACTORY_VARIABLES || "{}"));
  const context = { ...runtimeContext(env), sha: env.GITHUB_SHA };
  const coordinator = new DrillCoordinator(
    new GitHub({ token: env.GITHUB_TOKEN }),
    config,
    context
  );
  let result;
  switch (env.FACTORY_DRILL_OPERATION) {
    case "preview":
      result = await coordinator.preview();
      break;
    case "window": {
      const ready = await coordinator.ready();
      result = {
        outcome: ready ? "shutdown_window" : "disabled",
        ready,
        synthetic: true,
        notBefore: new Date(Date.now() + 90000).toISOString(),
      };
      break;
    }
    case "prepare":
      result = await coordinator.prepare();
      break;
    case "finalize":
      result = await coordinator.finalize({
        prepared: JSON.parse(env.FACTORY_DRILL_PREPARED || "null"),
        bundle:
          env.FACTORY_DRILL_BUNDLE && fs.existsSync(env.FACTORY_DRILL_BUNDLE)
            ? readJson(env.FACTORY_DRILL_BUNDLE)
            : undefined,
        report:
          env.FACTORY_DRILL_REPORT && fs.existsSync(env.FACTORY_DRILL_REPORT)
            ? readJson(env.FACTORY_DRILL_REPORT, 20000)
            : undefined,
      });
      break;
    default:
      throw new Error("Unknown drill operation");
  }
  const safeRunnerValue = (value) =>
    typeof value === "string" && /^[A-Za-z0-9_. /-]{1,160}$/.test(value) ? value : "unavailable";
  result.runner = {
    environment: safeRunnerValue(env.RUNNER_ENVIRONMENT),
    name: safeRunnerValue(env.RUNNER_NAME),
    os: safeRunnerValue(env.RUNNER_OS),
    arch: safeRunnerValue(env.RUNNER_ARCH),
  };
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## Isolated monitor repair rehearsal\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\nSynthetic service only; no production approval or deployment.\n`
    );
  if (env.FACTORY_DRILL_EVIDENCE)
    fs.writeFileSync(env.FACTORY_DRILL_EVIDENCE, JSON.stringify(result, null, 2));
  output(
    {
      ready: result.ready === true,
      ticket: result.ticket || "",
      grantId: result.grantId || "",
      head: result.head || "",
      prepared: JSON.stringify(result),
      identity: JSON.stringify(result.identity || {}),
    },
    env
  );
  console.log(JSON.stringify(result));
  if (result.outcome === "blocked") process.exitCode = 1;
  return result;
}
if (require.main === module)
  main().catch(() => {
    console.error(
      "Isolated drill stopped; inspect trusted receipts before retrying. No automatic model retry."
    );
    process.exitCode = 1;
  });
module.exports = { DrillCoordinator, assertContext, drillIssueText, failedBaseline, main };
