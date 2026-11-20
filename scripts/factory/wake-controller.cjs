const c = require("./wake-contract.cjs");
const { ROOT, Ledger } = require("./github.cjs");
const { WakeStore } = require("./wake-store.cjs");
const { criteriaHash } = require("./controller.cjs");
const { eligibleIssue } = require("./automation.cjs");
const { verifyMonitorIssue } = require("./monitor-origin.cjs");
const { MonitorStore } = require("./monitor-state.cjs");
const slots = require("./active-tickets.cjs");
const dependency = require("./dependency-contract.cjs");

const alertWakeConfig = (vars) => ({
  alertRepair: vars.FACTORY_DEPENDENCY_ALERT_REPAIR_ENABLED === "true",
  appSlug: vars.FACTORY_GITHUB_APP_SLUG,
});

async function verifyAlertCI(api, pr, run, config, bound = false) {
  // GitHub can remove the PR association after merge. A bound receipt already
  // pins the original association, head and CI run before allowing any work.
  const associationRemoved =
    bound &&
    pr.state === "closed" &&
    pr.merged === true &&
    dependency.SHA.test(pr.merge_commit_sha || "") &&
    Array.isArray(run.pull_requests) &&
    run.pull_requests.length === 0;
  if (
    !dependency.alertKey(pr.head.ref) ||
    run.event !== "pull_request" ||
    run.head_sha !== pr.head.sha ||
    run.head_branch !== pr.head.ref ||
    run.display_title !== `Factory CI / ${pr.number}` ||
    (!associationRemoved && !run.pull_requests?.some((p) => p.number === pr.number)) ||
    run.actor?.type !== "Bot" ||
    run.actor.login !== pr.user.login ||
    run.actor.id !== pr.user.id
  )
    throw Error("Dependency alert CI identity changed");

  const { verifyAlertPR, verifyAlertGitDiff } = require("./dependency-alert-repair.cjs");
  const receipt = await verifyAlertPR(api, pr, config, undefined, bound);
  if (!bound && receipt.phase !== "ready") throw Error("Dependency alert is not ready");

  if (receipt.base === pr.base.sha) {
    const files = await api.request("GET", `${ROOT}/pulls/${pr.number}/files?per_page=3`);
    dependency.filesOK(files, true);
  } else if (bound) {
    await verifyAlertGitDiff(api, receipt);
  }
  const jobs = await api.pages(
    `${ROOT}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
    "jobs"
  );
  const verify = jobs.filter((job) => job.name === "verify");
  if (
    verify.length !== 1 ||
    verify[0].run_id !== run.id ||
    verify[0].head_sha !== run.head_sha ||
    verify[0].status !== "completed" ||
    verify[0].conclusion !== "success"
  )
    throw Error("Dependency alert CI verify job failed identity checks");

  if (!bound) {
    const compare = await api.request("GET", `${ROOT}/compare/${receipt.base}...${pr.head.sha}`);
    const main = await api.request("GET", `${ROOT}/git/ref/heads/main`);
    if (
      main.object?.sha !== receipt.base ||
      compare.behind_by !== 0 ||
      compare.merge_base_commit?.sha !== receipt.base
    )
      throw Error("Dependency alert CI base is stale");
  }
  return receipt;
}

async function verifiedRun(api, id, attempt, file, { terminal = true, success = true } = {}) {
  const [run, workflow] = await Promise.all([
    api.request("GET", `${ROOT}/actions/runs/${id}/attempts/${attempt}`),
    api.request("GET", `${ROOT}/actions/workflows/${file}`),
  ]);
  if (
    run.id !== Number(id) ||
    run.run_attempt !== attempt ||
    run.workflow_id !== workflow.id ||
    workflow.path !== `.github/workflows/${file}` ||
    run.path !== workflow.path ||
    run.repository?.full_name !== c.REPOSITORY ||
    run.head_repository?.full_name !== c.REPOSITORY ||
    !c.SHA.test(run.head_sha || "") ||
    (terminal && run.status !== "completed") ||
    (success && run.status === "completed" && run.conclusion !== "success")
  )
    throw Error("Untrusted source workflow run");
  return run;
}
async function verifyProducer(api, context) {
  if (
    context.repository !== c.REPOSITORY ||
    context.ref !== "refs/heads/main" ||
    context.workflowRef !== `${c.REPOSITORY}/${c.WORKFLOW}@refs/heads/main` ||
    context.runAttempt !== 1
  )
    throw Error("Untrusted wake bridge context");
  const r = await verifiedRun(api, context.runId, 1, "factory-wake.yml", { terminal: false });
  if (
    r.head_branch !== "main" ||
    r.head_sha !== context.workflowSha ||
    r.actor?.login !== context.actor ||
    r.triggering_actor?.login !== context.triggeringActor ||
    r.event !== context.event ||
    !c.actor(r.actor)
  )
    throw Error("Wake bridge identity mismatch");
  return {
    runId: context.runId,
    runAttempt: 1,
    workflowSha: context.workflowSha,
    actor: { login: r.actor.login, id: r.actor.id },
    event: r.event,
  };
}
async function classifySignal({ api, event, context, vars = {}, ledger = new Ledger(api) }) {
  if (event.repository?.full_name !== c.REPOSITORY) return null;
  const { state } = await ledger.read();
  if (context.event === "issues") {
    if (
      !["opened", "labeled", "reopened", "edited"].includes(event.action) ||
      event.sender?.login !== c.OWNER ||
      event.sender?.id !== 101267861 ||
      context.actor !== c.OWNER ||
      !Number.isSafeInteger(event.issue?.number)
    )
      return null;
    const issue = await api.request("GET", `${ROOT}/issues/${event.issue.number}`);
    if (!eligibleIssue(issue) || state.tickets[String(issue.number)]) return null;
    return {
      kind: "issue",
      lane: "app",
      number: issue.number,
      head: "0".repeat(40),
      criteriaHash: criteriaHash(issue),
      revision: issue.updated_at,
      sourceRun: context.runId,
      sourceAttempt: context.runAttempt,
      actor: { login: event.sender.login, id: event.sender.id },
    };
  }
  if (context.event !== "workflow_run" || event.action !== "completed") return null;
  const source = event.workflow_run;
  if (!source || !c.ID.test(String(source.id)) || !Number.isSafeInteger(source.run_attempt))
    return null;
  if (source.path === ".github/workflows/factory-discovery-intake.yml") {
    const r = await verifiedRun(
      api,
      String(source.id),
      source.run_attempt,
      "factory-discovery-intake.yml"
    );
    let registry;
    try {
      registry = (await new (require("./discovery-finding-store.cjs").FindingStore)(api).read())
        .state;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
    for (const row of Object.values(registry.records)) {
      if (
        row.intake?.outcome !== "ready" ||
        row.intake.context.runId !== String(r.id) ||
        state.tickets[String(row.publication?.issue)]
      )
        continue;
      const issue = await api.request("GET", `${ROOT}/issues/${row.publication.issue}`);
      const proof = await require("./discovery-origin.cjs").verifyDiscoveryIssue(api, issue);
      if (!proof || issue.state !== "open") continue;
      return {
        kind: "finding",
        lane: "app",
        number: issue.number,
        head: row.intake.head,
        criteriaHash: proof.criteriaHash,
        revision: row.intake.id,
        sourceRun: String(r.id),
        sourceAttempt: r.run_attempt,
        actor: { login: r.actor.login, id: r.actor.id },
      };
    }
    return null;
  }
  const functional = require("./functional-discovery-contract.cjs");
  if (
    source.path === ".github/workflows/factory-monitor.yml" ||
    source.path === functional.WORKFLOW_PATH
  ) {
    const functionalRun = source.path === functional.WORKFLOW_PATH;
    const file = functionalRun ? functional.WORKFLOW_FILE : "factory-monitor.yml";
    const r = await verifiedRun(api, String(source.id), source.run_attempt, file);
    const { state: monitor } = await new MonitorStore(
      api,
      functionalRun ? "functional" : "production"
    ).read();
    const incident = monitor.incidents[monitor.active];
    if (
      !incident ||
      incident.recovered ||
      (functionalRun && incident.source.runId !== String(r.id))
    )
      return null;
    const issue = await api.request("GET", `${ROOT}/issues/${incident.issue}`);
    if (
      functionalRun &&
      (issue.state !== "open" || !issue.labels?.some((label) => label.name === "factory-ready"))
    )
      return null;
    const proof = await verifyMonitorIssue(api, issue);
    if (state.tickets[String(issue.number)] || !proof) return null;
    return {
      kind: "monitor",
      lane: "app",
      number: issue.number,
      head: proof.workflowSha,
      criteriaHash: criteriaHash(issue),
      revision: incident.id,
      sourceRun: proof.runId,
      sourceAttempt: proof.runAttempt,
      actor: { login: r.actor.login, id: r.actor.id },
    };
  }
  if (source.path === ".github/workflows/factory-ci.yml") {
    const r = await verifiedRun(api, String(source.id), source.run_attempt, "factory-ci.yml");
    // Only PR CI can wake dependency intake.
    if (r.event !== "pull_request") return null;
    const config = alertWakeConfig(vars);
    for (const link of r.pull_requests || []) {
      let pr;
      try {
        pr = dependency.prOK(
          await api.request("GET", `${ROOT}/pulls/${link.number}`),
          false,
          config
        );
      } catch {
        return null;
      }
      if (pr.number !== link.number || pr.head.sha !== r.head_sha) return null;
      const generated = Boolean(dependency.alertKey(pr.head.ref));
      let revision = pr.base.sha;
      if (generated) {
        try {
          revision = (await verifyAlertCI(api, pr, r, config)).base;
        } catch {
          return null;
        }
      } else {
        dependency.filesOK(await api.request("GET", `${ROOT}/pulls/${pr.number}/files?per_page=3`));
        const jobs = await api.pages(
          `${ROOT}/actions/runs/${r.id}/attempts/${r.run_attempt}/jobs`,
          "jobs"
        );
        if (
          jobs.filter(
            (j) => j.name === "verify" && j.conclusion === "success" && j.status === "completed"
          ).length !== 1
        )
          return null;
        const main = await api.request("GET", `${ROOT}/git/ref/heads/main`);
        if (pr.base.sha !== main.object?.sha) return null;
      }
      return {
        kind: generated ? "dependency-alert-ci" : "dependency-ci",
        lane: "dependency",
        number: pr.number,
        head: pr.head.sha,
        criteriaHash: dependency.criteria(pr.number),
        revision,
        sourceRun: String(r.id),
        sourceAttempt: r.run_attempt,
        actor: { login: r.actor.login, id: r.actor.id },
      };
    }
    return null;
  }
  if (
    ![
      "factory-automatic.yml",
      "factory-dependencies.yml",
      "factory-agents.yml",
      "factory-discovery.yml",
    ].some((f) => source.path === `.github/workflows/${f}`)
  )
    return null;
  const r = await verifiedRun(
    api,
    String(source.id),
    source.run_attempt,
    source.path.split("/").at(-1),
    { success: false }
  );
  // Completion is a drain signal only if a real reservation finished and its slot was released.
  const grants = Object.values(state.grants).filter(
    (g) => g.runId === String(r.id) && g.runAttempt === r.run_attempt
  );
  if (
    !grants.length ||
    grants.some((g) => g.status !== "finished") ||
    slots
      .activeEntries(state)
      .some((e) => e.runId === String(r.id) && e.runAttempt === r.run_attempt)
  )
    return null;
  return {
    kind: "drain",
    lane: source.path.endsWith("factory-dependencies.yml") ? "dependency" : "app",
    number: grants[0].ticket,
    head: r.head_sha,
    criteriaHash: c.digest(grants.map((g) => g.id).sort()),
    revision: String(r.run_attempt),
    sourceRun: String(r.id),
    sourceAttempt: r.run_attempt,
    actor: { login: r.actor.login, id: r.actor.id },
  };
}
async function handleWake({
  api,
  context,
  event,
  vars,
  preview = false,
  store = new WakeStore(api),
  ledger = new Ledger(api),
}) {
  if (typeof preview !== "boolean") throw Error("Invalid wake preview");
  if (!preview && vars.FACTORY_EVENT_PICKUP_ENABLED !== "true") return { outcome: "disabled" };
  const producer = await verifyProducer(api, context);
  if (
    context.event === "issues" &&
    event.issue?.number === Number(vars.FACTORY_ACTIVITY_ISSUE_NUMBER)
  )
    return { outcome: "ignored" };
  let signal = await classifySignal({ api, event, context, vars, ledger });
  if (!signal) return { outcome: "ignored" };
  c.validateSignal(signal);
  if (preview) return { outcome: "preview", lane: signal.lane, number: signal.number };
  const controls = (await ledger.read()).state;
  if (controls.stop) return { outcome: "stopped" };
  if (vars.FACTORY_ENABLED !== "true" || vars.FACTORY_AUTOMATION_ENABLED !== "true")
    return { outcome: "disabled" };
  const concurrent = Number(vars.FACTORY_MAX_CONCURRENT_TICKETS);
  if (![1, 2].includes(concurrent)) throw Error("Invalid wake capacity setting");
  const busy = !slots.capacity(controls, concurrent);
  const drain = signal.kind === "drain" ? signal : null;
  const alreadyDrained = (state) =>
    drain &&
    Object.values(state.receipts).some(
      (r) =>
        r.signal.kind === "drain" &&
        r.signal.sourceRun === drain.sourceRun &&
        r.signal.sourceAttempt === drain.sourceAttempt &&
        r.status !== "pending"
    );
  let pendingId, completedDrain;
  if (drain) {
    const { state } = await store.read();
    if (alreadyDrained(state)) return { outcome: "duplicate" };
    const pending = Object.values(state.receipts).find(
      (r) => r.status === "pending" && r.signal.kind !== "drain"
    );
    if (pending) {
      if (!busy && ["dependency-ci", "dependency-alert-ci"].includes(pending.signal.kind)) {
        try {
          await require("./trusted-wake.cjs").verifySource(api, pending.signal, false, vars);
          completedDrain = c.createWake({ signal, producer });
          signal = pending.signal;
        } catch {
          // Fall back to the ordinary drain when the queued CI proof is stale.
        }
      }
      if (!completedDrain) {
        signal = { ...signal, lane: pending.signal.lane };
        pendingId = pending.id;
      }
    }
  }
  const receipt = c.createWake({ signal, producer });
  const claim = await store.update((state) => {
    c.validateWakes(state);
    const old = state.receipts[receipt.id];
    const oldDrain = completedDrain && state.receipts[completedDrain.id];
    if ((old && old.status !== "pending") || alreadyDrained(state))
      return { state, duplicate: true };
    const newReceipts = Number(!old) + Number(Boolean(completedDrain && !oldDrain));
    if (Object.keys(state.receipts).length + newReceipts > c.MAX_RECEIPTS)
      throw Error("Wake registry full; retained receipts require owner maintenance");
    state.receipts[receipt.id] = old || receipt;
    if (!busy) {
      state.receipts[receipt.id].status = "intent";
      state.receipts[receipt.id].producer = producer;
      if (completedDrain)
        state.receipts[completedDrain.id] = { ...completedDrain, status: "observed" };
      if (pendingId && state.receipts[pendingId]?.status === "pending")
        state.receipts[pendingId].status = "observed";
    }
    return { state, duplicate: false };
  });
  if (claim.duplicate) return { outcome: "duplicate", receiptId: receipt.id };
  if (busy) return { outcome: "busy", receiptId: receipt.id };
  const inputs = {
    wake_id: receipt.id,
    ...(signal.lane === "app" ? { dry_run: false } : { preview: false }),
  };
  try {
    await api.request("POST", `${ROOT}/actions/workflows/${c.LANES[signal.lane]}/dispatches`, {
      ref: "main",
      inputs,
    });
  } catch {
    return { outcome: "uncertain", receiptId: receipt.id };
  }
  await store.update((state) => {
    const r = state.receipts[receipt.id];
    if (r.status === "intent") r.status = "sent";
    return { state };
  });
  return { outcome: "dispatched", lane: signal.lane, receiptId: receipt.id };
}
module.exports = {
  classifySignal,
  verifiedRun,
  verifyProducer,
  handleWake,
  alertWakeConfig,
  verifyAlertCI,
};
