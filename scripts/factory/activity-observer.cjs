const fs = require("node:fs");
const { GitHub, Ledger, ROOT } = require("./github.cjs");
const { runtimeContext } = require("./controller.cjs");
const a = require("./activity.cjs");
const { ActivityStore } = require("./activity-store.cjs");
const { triageHarnessFaults } = require("./activity-harness-faults.cjs");
const { REPOSITORY, OWNER } = require("./wake-contract.cjs");
const link = (id) => `https://github.com/${REPOSITORY}/actions/runs/${id}`;
const stateFor = (status, conclusion) =>
  status === "completed"
    ? ["success", "failure", "cancelled", "skipped"].includes(conclusion)
      ? conclusion
      : "held"
    : ["waiting", "pending", "queued"].includes(status)
      ? "pending"
      : "starting";
function producerFor(run, phase) {
  return {
    runId: String(run.id),
    runAttempt: run.run_attempt,
    workflow: run.path.split("/").at(-1),
    workflowSha: run.head_sha,
    phase,
    actor: run.actor.login,
  };
}
async function collectRunActivity({ run, jobs, ledger }) {
  const workflow = run.path.split("/").at(-1);
  if (!a.WORKFLOWS.includes(workflow) || workflow === "factory-activity.yml")
    throw Error("Unknown observed workflow");
  const { state } = await ledger.read();
  const events = [];
  const emit = (kind, status, phase, subject, head, summary) =>
    events.push(
      a.buildActivityEvent({
        producer: producerFor(run, phase),
        kind,
        state: status,
        subject,
        head,
        summary,
        links: [link(run.id)],
      })
    );
  const kind =
    workflow === "factory-monitor.yml"
      ? "monitor"
      : workflow === "factory-deploy.yml"
        ? "deployment"
        : workflow === "factory-ci.yml"
          ? "ci"
          : "queue";
  emit(
    kind,
    stateFor(run.status, run.conclusion),
    "run",
    run.id,
    run.head_sha,
    `Workflow ${workflow} is ${stateFor(run.status, run.conclusion)}. Check the linked run for authoritative evidence.`
  );
  if (workflow === "factory-discovery-intake.yml")
    for (const job of jobs.filter((j) => ["publish", "replay", "finalize"].includes(j.name)))
      emit(
        "discovery",
        stateFor(job.status, job.conclusion),
        `finding-${job.name}`,
        run.id,
        run.head_sha,
        job.name === "publish"
          ? "Verified finding publication job observed; duplicate and quota decisions are in its receipts."
          : job.name === "replay"
            ? "Current-main sandbox replay job observed. This is not production or live-monitor coverage."
            : "Finding intake assessment recorded. Observed resolution is not a factory-authored repair or production verification."
      );
  const grants = Object.values(state.grants).filter(
    (g) => g.runId === String(run.id) && g.runAttempt === run.run_attempt
  );
  for (const job of jobs) {
    const phase =
      job.name === "discover"
        ? "discovery"
        : job.name?.includes("review")
          ? "review"
          : job.name?.includes("code") || job.name?.includes("drill")
            ? "coding"
            : null;
    const grant =
      phase &&
      grants.find(
        (g) =>
          g.phase ===
            (phase === "discovery" ? "discover" : phase === "review" ? "review" : "code") &&
          (!job.name.includes("cycle") || job.name.includes(g.slot))
      );
    if (grant) {
      const model = job.steps?.find(
        (s) =>
          s.name === "Run the one reserved Claude subscription session" ||
          s.name === "Run the one reserved Claude discovery session"
      );
      if (job.status === "in_progress" && (!model || model.status === "pending"))
        emit(
          phase,
          "starting",
          `job-${job.id}-prepare`,
          grant.ticket,
          grant.head,
          "Reserved role is preparing; this is not proof that Claude executed."
        );
      if (
        model &&
        (model.status === "in_progress" ||
          (model.status === "completed" && !["skipped", null].includes(model.conclusion)))
      )
        emit(
          phase,
          "started",
          `job-${job.id}-model`,
          grant.ticket,
          grant.head,
          "GitHub reports the reserved model step started. This is not a review pass."
        );
      if (job.status === "completed")
        emit(
          phase,
          stateFor(job.status, job.conclusion),
          `job-${job.id}-finish`,
          grant.ticket,
          grant.head,
          `Role job completed with ${stateFor(job.status, job.conclusion)}; trusted validation decides its result.`
        );
    }
    if (workflow === "factory-deploy.yml" && job.name?.startsWith("Deploy tested commit "))
      emit(
        "deployment",
        stateFor(job.status, job.conclusion),
        `job-${job.id}`,
        run.id,
        run.head_sha,
        `Production deployment job is ${stateFor(job.status, job.conclusion)}; named human approval remains required.`
      );
  }
  for (const grant of grants) {
    const t = state.tickets[String(grant.ticket)];
    if (grant.status === "finished" && grant.phase === "review") {
      const passed =
        t?.approval?.grant === grant.id &&
        t.approval.source === "claude-subscription" &&
        t.approval.fixture === false &&
        t.approval.verdict === "pass";
      emit(
        "review",
        passed ? "passed" : "blocked",
        `grant-${grant.id}`,
        grant.ticket,
        grant.head,
        passed
          ? "Trusted assessment retained a genuine current-head Claude subscription approval."
          : "Review did not retain a passing approval; inspect the assessment before retrying."
      );
    }
    if (t?.merge?.runId === String(run.id) && t.merge.status === "merged")
      emit(
        "merge",
        "merged",
        `merge-${t.pr}`,
        grant.ticket,
        t.merge.mergeCommit,
        "Protected merge confirmed in the retained usage ledger."
      );
  }
  return events;
}
async function observeRun({
  api,
  runId,
  runAttempt,
  journalIssue,
  store = new ActivityStore(api),
  ledger = new Ledger(api),
  preview = false,
  triage = false,
}) {
  const run = await api.request("GET", `${ROOT}/actions/runs/${runId}/attempts/${runAttempt}`);
  const probe = a.buildActivityEvent({
    producer: producerFor(run, "run"),
    kind: "queue",
    state: "starting",
    subject: run.id,
    head: run.head_sha,
    summary: "Verifying observed source",
    links: [link(run.id)],
  });
  let trustedRun;
  try {
    trustedRun = await a.verifyActivityProducer(api, probe);
  } catch (e) {
    if (!(e instanceof require("./trusted-wake.cjs").PendingWakeBinding)) throw e;
    if (run.status === "completed" && !preview) {
      const held = a.buildActivityEvent({
        producer: producerFor(run, "binding-held"),
        kind: "queue",
        state: "held",
        subject: run.id,
        head: run.head_sha,
        summary:
          "Receiver finished without a verified wake binding; no model or review outcome is asserted.",
        links: [link(run.id)],
      });
      await a.publishActivity({ api, event: held, journalIssue, store });
    }
    return { outcome: "awaiting_binding", events: 0, status: run.status, modelCalls: 0 };
  }
  const jobs = await api.pages(
    `${ROOT}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
    "jobs"
  );
  if (triage && !preview) {
    // Infrastructure triage can succeed even if journal scanning is unavailable.
    let result;
    try {
      result = await triageHarnessFaults({ api, store, ledger, run: trustedRun, jobs });
    } catch {
      result = "held";
    }
    if (result === "held")
      console.warn(
        "Harness maintenance ticket publication held. Check the durable activity receipt."
      );
  }
  const events = await collectRunActivity({ run, jobs, ledger });
  if (run.path === ".github/workflows/factory-deploy.yml") {
    const approvals = await api.request("GET", `${ROOT}/actions/runs/${run.id}/approvals`);
    for (const review of approvals)
      if (
        review.user?.login === OWNER &&
        review.environments?.some((e) => e.name === "production") &&
        ["approved", "rejected"].includes(review.state)
      )
        events.push(
          a.buildActivityEvent({
            producer: producerFor(run, `approval-${review.state}`),
            kind: "deployment",
            state: review.state,
            subject: run.id,
            head: run.head_sha,
            summary: `The named owner ${review.state} the production deployment.`,
            links: [link(run.id)],
          })
        );
  }
  if (!preview) {
    const registry = (await store.read()).state;
    const queued = Object.values(registry.events).filter(
      (r) =>
        r.event.producer.runId === String(run.id) &&
        r.event.producer.runAttempt === run.run_attempt &&
        r.status !== "published"
    );
    for (const entry of queued)
      await a.publishActivity({ api, event: entry.event, journalIssue, store });
    for (const event of events) await a.publishActivity({ api, event, journalIssue, store });
  }
  return {
    outcome: preview ? "preview" : "observed",
    events: events.length,
    status: run.status,
    modelCalls: 0,
  };
}
async function checkFreshness({
  api,
  context,
  journalIssue,
  store = new ActivityStore(api),
  preview = false,
  scan,
}) {
  const runs = await api.request(
    "GET",
    `${ROOT}/actions/workflows/factory-monitor.yml/runs?status=completed&branch=main&per_page=20`
  );
  let monitor = runs.workflow_runs?.find(
    (r) =>
      r.conclusion === "success" &&
      r.run_attempt === 1 &&
      r.actor?.login === OWNER &&
      r.head_repository?.full_name === REPOSITORY &&
      r.path === ".github/workflows/factory-monitor.yml"
  );
  const { state } = await store.read();
  if (monitor)
    monitor = await require("./wake-controller.cjs").verifiedRun(
      api,
      String(monitor.id),
      1,
      "factory-monitor.yml"
    );
  const before = structuredClone(state);
  const change = a.monitorFreshness(
    state,
    new Date(),
    monitor ? { runId: String(monitor.id), at: monitor.updated_at } : undefined
  );
  if (preview) return { change, lastMonitor: state.lastMonitor };
  if (change) {
    const source =
      monitor ||
      (await require("./wake-controller.cjs").verifiedRun(
        api,
        state.lastMonitor.runId,
        1,
        "factory-monitor.yml"
      ));
    const p = producerFor(source, "freshness");
    // Key by the verified monitor interval, not by whichever observer noticed it.
    const event = a.buildActivityEvent({
      producer: p,
      kind: change,
      state: change === "monitor-stale" ? "stale" : "recovered",
      subject: Number(state.lastMonitor.runId),
      head: source.head_sha,
      summary:
        change === "monitor-stale"
          ? "No verified production monitor completion for at least 90 minutes. Old health is not current health."
          : "A newer successful production monitor completion was verified.",
      links: [link(state.lastMonitor.runId)],
    });
    const publication = await a.publishActivity({
      api,
      event,
      journalIssue,
      store,
      ...(scan ? { scan } : {}),
    });
    if (publication.outcome === "uncertain") return { change, publication: "uncertain" };
  }
  if (JSON.stringify(before) !== JSON.stringify(state))
    await store.update((s) => {
      a.monitorFreshness(
        s,
        new Date(),
        monitor ? { runId: String(monitor.id), at: monitor.updated_at } : undefined
      );
      return { state: s };
    });
  return { change };
}
async function main(
  env = process.env,
  { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}
) {
  require("./policy.cjs").assertSubscriptionEnv(env);
  const context = runtimeContext(env),
    vars = JSON.parse(env.FACTORY_VARIABLES || "{}");
  if (
    context.repository !== REPOSITORY ||
    context.ref !== "refs/heads/main" ||
    context.workflowRef !==
      `${REPOSITORY}/.github/workflows/factory-activity.yml@refs/heads/main` ||
    context.runAttempt !== 1
  )
    throw Error("Untrusted activity observer context");
  const stat = fs.lstatSync(env.GITHUB_EVENT_PATH);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2000000)
    throw Error("Invalid observer event");
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
    inputs = event.inputs || {};
  const preview = inputs.preview === true || inputs.preview === "true";
  if (context.event !== "workflow_dispatch" && vars.FACTORY_ACTIVITY_LOG_ENABLED !== "true")
    return { outcome: "disabled", modelCalls: 0 };
  const api = new GitHub({ token: env.GITHUB_TOKEN }),
    store = new ActivityStore(api);
  if (context.event === "workflow_dispatch") {
    if (context.actor !== OWNER || context.triggeringActor !== OWNER)
      throw Error("Owner-only activity setup");
    if (inputs.operation === "initialize") {
      if (preview) return { outcome: "initialization_preview", modelCalls: 0 };
      await a.journal(api, Number(vars.FACTORY_ACTIVITY_ISSUE_NUMBER));
      await store.initialize();
      return { outcome: "initialized", modelCalls: 0 };
    }
    if (!preview) throw Error("Manual observation is preview-only");
    const run = Number(inputs.run_id);
    if (!Number.isSafeInteger(run) || run < 1) throw Error("Preview needs a source run");
    return observeRun({
      api,
      runId: run,
      runAttempt: 1,
      journalIssue: Number(vars.FACTORY_ACTIVITY_ISSUE_NUMBER),
      preview: true,
    });
  }
  const journalIssue = Number(vars.FACTORY_ACTIVITY_ISSUE_NUMBER);
  await a.journal(api, journalIssue);
  const source = event.workflow_run;
  if (
    context.event === "workflow_run" &&
    (!source ||
      !a.WORKFLOWS.some(
        (f) => f !== "factory-activity.yml" && source.path === `.github/workflows/${f}`
      ))
  )
    throw Error("Unallowlisted activity source");
  const observe = (triage) =>
    observeRun({
      api,
      runId: source.id,
      runAttempt: source.run_attempt,
      journalIssue,
      store,
      triage,
    });
  const terminalCI =
    context.event === "workflow_run" &&
    event.action === "completed" &&
    source.path === ".github/workflows/factory-ci.yml" &&
    source.event === "push";
  if (terminalCI) await observe(true);
  const controlRegistry = (await store.read()).state;
  const commandEvents = require("./activity-controls.cjs").controlEvents(
    await new Ledger(api).read(),
    {
      runId: context.runId,
      runAttempt: context.runAttempt,
      workflow: "factory-activity.yml",
      workflowSha: context.workflowSha,
      phase: "control",
      actor: context.actor,
    },
    controlRegistry.controlAfter
  );
  for (const control of commandEvents)
    await a.publishActivity({ api, event: control, journalIssue, store });
  await checkFreshness({ api, context, journalIssue, store });
  if (context.event === "issues") {
    if (
      event.issue?.number === journalIssue ||
      event.sender?.login !== OWNER ||
      event.sender.id !== 101267861
    )
      return { outcome: "ignored", modelCalls: 0 };
    const issue = await api.request("GET", `${ROOT}/issues/${event.issue.number}`);
    const current = a.buildActivityEvent({
      producer: {
        runId: context.runId,
        runAttempt: 1,
        workflow: "factory-activity.yml",
        workflowSha: context.workflowSha,
        phase: `issue-${event.action}`,
        actor: context.actor,
      },
      kind: "issue",
      state: issue.state === "closed" ? "completed" : "queued",
      subject: issue.number,
      head: context.workflowSha,
      summary: `Issue ${issue.number} lifecycle action ${event.action}; ${issue.labels?.some((l) => l.name === "factory-ready") ? "marked ready" : "not marked ready"}.`,
      links: [`https://github.com/${REPOSITORY}/issues/${issue.number}`],
    });
    await a.publishActivity({ api, event: current, journalIssue, store });
  } else if (context.event === "workflow_run" && !terminalCI) {
    // A bounded in-progress observer catches actual job/step transitions. A separate
    // completion delivery catches the final result even if this polling window ends.
    const max = event.action === "in_progress" ? 240 : 1;
    for (let n = 0; n < max; n++) {
      const result = await observe(false);
      if (result.status === "completed" || max === 1) break;
      await sleep(20000);
    }
  }
  await checkFreshness({ api, context, journalIssue, store });
  return { outcome: "observed", modelCalls: 0 };
}
if (require.main === module)
  main()
    .then((r) => console.log(JSON.stringify(r)))
    .catch(() => {
      console.error(
        "Activity publication held. Inspect source, journal and durable intent; do not rerun a model for a notification failure."
      );
      process.exitCode = 1;
    });
module.exports = { producerFor, collectRunActivity, observeRun, checkFreshness, main };
