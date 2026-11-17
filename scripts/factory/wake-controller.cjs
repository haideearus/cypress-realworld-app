const c = require("./wake-contract.cjs");
const { ROOT, Ledger } = require("./github.cjs");
const { WakeStore } = require("./wake-store.cjs");
const { criteriaHash } = require("./controller.cjs");
const { eligibleIssue } = require("./automation.cjs");
const { verifyMonitorIssue } = require("./monitor-origin.cjs");
const { MonitorStore } = require("./monitor-state.cjs");
const slots = require("./active-tickets.cjs");
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
async function classifySignal({ api, event, context, ledger = new Ledger(api) }) {
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
  if (source.path === ".github/workflows/factory-monitor.yml") {
    const r = await verifiedRun(api, String(source.id), source.run_attempt, "factory-monitor.yml");
    const { state: monitor } = await new MonitorStore(api).read();
    const incident = monitor.incidents[monitor.active];
    if (!incident || incident.recovered) return null;
    const issue = await api.request("GET", `${ROOT}/issues/${incident.issue}`);
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
    // Only native PR CI can wake dependency intake, never owner harness/dispatch CI.
    if (r.event !== "pull_request") return null;
    const d = require("./dependency-contract.cjs");
    for (const link of r.pull_requests || []) {
      let pr;
      try {
        pr = d.prOK(await api.request("GET", `${ROOT}/pulls/${link.number}`));
      } catch {
        return null;
      }
      if (pr.head.sha !== r.head_sha) return null;
      d.filesOK(await api.request("GET", `${ROOT}/pulls/${pr.number}/files?per_page=3`));
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
      return {
        kind: "dependency-ci",
        lane: "dependency",
        number: pr.number,
        head: pr.head.sha,
        criteriaHash: d.criteria(pr.number),
        revision: pr.base.sha,
        sourceRun: String(r.id),
        sourceAttempt: r.run_attempt,
        actor: { login: r.actor.login, id: r.actor.id },
      };
    }
    return null;
  }
  if (
    !["factory-automatic.yml", "factory-dependencies.yml", "factory-agents.yml"].some(
      (f) => source.path === `.github/workflows/${f}`
    )
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
  let signal = await classifySignal({ api, event, context, ledger });
  if (!signal) return { outcome: "ignored" };
  c.validateSignal(signal);
  if (preview) return { outcome: "preview", lane: signal.lane, number: signal.number };
  const controls = (await ledger.read()).state;
  if (controls.stop) return { outcome: "stopped" };
  if (vars.FACTORY_ENABLED !== "true" || vars.FACTORY_AUTOMATION_ENABLED !== "true")
    return { outcome: "disabled" };
  const concurrent = Number(vars.FACTORY_MAX_CONCURRENT_TICKETS);
  if (![1, 2].includes(concurrent)) throw Error("Invalid wake capacity setting");
  let pendingId;
  if (signal.kind === "drain") {
    const { state } = await store.read();
    if (
      Object.values(state.receipts).some(
        (r) =>
          r.signal.kind === "drain" &&
          r.signal.sourceRun === signal.sourceRun &&
          r.signal.sourceAttempt === signal.sourceAttempt &&
          r.status !== "pending"
      )
    )
      return { outcome: "duplicate" };
    const pending = Object.values(state.receipts).find(
      (r) => r.status === "pending" && r.signal.kind !== "drain"
    );
    if (pending) {
      signal = { ...signal, lane: pending.signal.lane };
      pendingId = pending.id;
    }
  }
  const receipt = c.createWake({ signal, producer });
  const busy = !slots.capacity(controls, concurrent);
  const claim = await store.update((state) => {
    c.validateWakes(state);
    const old = state.receipts[receipt.id];
    if (old && old.status !== "pending") return { state, duplicate: true };
    if (!old && Object.keys(state.receipts).length >= c.MAX_RECEIPTS)
      throw Error("Wake registry full; retained receipts require owner maintenance");
    state.receipts[receipt.id] = old || receipt;
    if (!busy) {
      state.receipts[receipt.id].status = "intent";
      state.receipts[receipt.id].producer = producer;
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
module.exports = { classifySignal, verifiedRun, verifyProducer, handleWake };
