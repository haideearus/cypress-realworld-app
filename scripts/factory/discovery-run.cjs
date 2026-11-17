const fs = require("node:fs");
const p = require("./policy.cjs");
const c = require("./discovery-contract.cjs");
const { GitHub, Ledger, ROOT } = require("./github.cjs");
const { DiscoveryStore } = require("./discovery-store.cjs");
const { runtimeContext, output } = require("./controller.cjs");
const active = require("./active-tickets.cjs");
function selectSweep({ state, registry, head, day, config, repairsWaiting = false }) {
  p.assertNotStopped(state);
  if (!config.enabled || !config.discovery) return { ready: false, reason: "Discovery disabled" };
  if (repairsWaiting || active.activeEntries(state).length)
    return { ready: false, reason: "Repairs or active work take priority" };
  if ((state.days[day] || []).length >= config.daily)
    return { ready: false, reason: "Daily ticket limit reached" };
  if (
    Object.values(state.grants).filter(
      (g) => g.phase === "discover" && p.dayKey(new Date(g.at), config.timezone) === day
    ).length >= 2
  )
    return { ready: false, reason: "Discovery daily session limit reached" };
  const offset = Number.parseInt(c.digest(day).slice(0, 4), 16) % c.CHARTERS.length;
  const charters = [...c.CHARTERS.slice(offset), ...c.CHARTERS.slice(0, offset)];
  const charter = charters.find((x) => !registry.sources[c.sweepKey(head, x, day)]);
  return charter
    ? { ready: true, charter }
    : { ready: false, reason: "No unused charter on this main revision" };
}
function sourceBody(proof) {
  return `Discovery sweep audit source. This is not a bug or repair request. Keep unlabelled.\n\nHead: ${proof.head}\nCharter: ${proof.charter}\nDay: ${proof.day}\nCI run: ${proof.ciRunId}\nProducer: ${proof.runId}, attempt 1\n\n<!-- factory-discovery-source:${proof.key} -->`;
}
function issueOK(issue, proof) {
  return (
    issue &&
    issue.state === "open" &&
    issue.user?.login === "github-actions[bot]" &&
    issue.user.id === 41898282 &&
    !issue.pull_request &&
    Array.isArray(issue.labels) &&
    issue.labels.length === 0 &&
    issue.body === sourceBody(proof) &&
    Number.isSafeInteger(issue.number)
  );
}
async function sourceFor(api, store, proof) {
  c.validateProof(proof);
  const saved = (await store.read()).state.sources[proof.key];
  if (saved) {
    if (saved.status === "created") {
      const issue = await api.request("GET", `${ROOT}/issues/${saved.issue}`);
      if (!issueOK(issue, saved.proof)) throw Error("Discovery source changed");
      return saved.issue;
    }
    const issues = await api.pages(`${ROOT}/issues?state=all&per_page=100`);
    const matches = issues.filter((i) => issueOK(i, saved.proof));
    if (matches.length !== 1)
      throw Error("Discovery source POST uncertain; retained intent requires reconciliation");
    await store.update((s) => {
      s.sources[proof.key].status = "created";
      s.sources[proof.key].issue = matches[0].number;
      return { state: s };
    });
    return matches[0].number;
  }
  // CAS retries may observe another intent. Only the creator of this intent may POST.
  const result = await store.update((s) => {
    if (s.sources[proof.key]) return { state: s, created: false };
    s.sources[proof.key] = { proof: structuredClone(proof), status: "intent", issue: null };
    return { state: s, created: true };
  });
  if (!result.created) throw Error("Discovery source intent already claimed");
  const issue = await api.request("POST", `${ROOT}/issues`, {
    title: `Discovery sweep: ${proof.charter} (${proof.day})`,
    body: sourceBody(proof),
    labels: [],
  });
  if (!issueOK(issue, proof)) throw Error("Discovery source POST unacknowledged");
  await store.update((s) => {
    s.sources[proof.key].status = "created";
    s.sources[proof.key].issue = issue.number;
    return { state: s };
  });
  return issue.number;
}
async function testedMain(api, context, event) {
  const branch = await api.request("GET", `${ROOT}/branches/main`);
  const head = branch.commit?.sha;
  if (!c.SHA.test(head) || head !== context.workflowSha)
    throw Error("Current main changed; fresh invocation required");
  const runs = await api.pages(
    `${ROOT}/actions/workflows/factory-ci.yml/runs?branch=main&event=push&status=success&per_page=100`,
    "workflow_runs"
  );
  const run = runs.find(
    (r) =>
      r.head_sha === head &&
      r.head_branch === "main" &&
      r.event === "push" &&
      r.path === ".github/workflows/factory-ci.yml" &&
      r.status === "completed" &&
      r.conclusion === "success" &&
      r.repository?.full_name === p.REPOSITORY
  );
  if (!run) throw Error("Successful current-main push CI required");
  if (context.event === "workflow_run" && event.workflow_run?.id !== run.id)
    throw Error("Stale or unrelated main CI event");
  const jobs = await api.pages(
    `${ROOT}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
    "jobs"
  );
  if (!jobs.some((j) => j.name === "verify" && j.head_sha === head && j.conclusion === "success"))
    throw Error("Current-main verification job required");
  return { head, ciRunId: String(run.id) };
}
async function verifyParent(api, context) {
  if (!c.contextOK(context)) throw Error("Unauthorized discovery invocation");
  const run = await api.request("GET", `${ROOT}/actions/runs/${context.runId}`);
  if (
    run.id !== Number(context.runId) ||
    run.run_attempt !== 1 ||
    run.path !== ".github/workflows/factory-discovery.yml" ||
    run.head_sha !== context.workflowSha ||
    run.head_branch !== "main" ||
    run.repository?.full_name !== p.REPOSITORY ||
    run.actor?.login !== p.OWNER ||
    run.actor.id !== 101267861 ||
    run.triggering_actor?.login !== p.OWNER ||
    run.event !== context.event ||
    run.status !== "in_progress"
  )
    throw Error("Discovery parent identity mismatch");
}
async function main(env = process.env) {
  p.assertSubscriptionEnv(env);
  const vars = JSON.parse(env.FACTORY_VARIABLES || "{}");
  const config = p.readConfig(vars);
  const inputs = JSON.parse(env.FACTORY_INPUTS || "{}");
  const op = env.FACTORY_OPERATION || inputs.operation || "preview";
  const context = { ...runtimeContext(env), phase: "discover", slot: "discovery" };
  if (context.event === "schedule") {
    const hour = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Bucharest",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date());
    if (!["03", "15"].includes(hour)) {
      output({ outcome: "outside-local-window", ready: false, modelCalls: 0 }, env);
      return;
    }
  }
  const api = new GitHub({ token: env.GH_TOKEN });
  await verifyParent(api, context);
  const ledger = new Ledger(api);
  const store = new DiscoveryStore(api);
  if (op === "initialize") {
    if (context.event !== "workflow_dispatch") throw Error("Owner setup invocation required");
    if (inputs.dry_run !== false) {
      const r = { outcome: "initialization_preview", ready: false, modelCalls: 0 };
      output(r, env);
      return r;
    }
    await store.initialize();
    const r = { outcome: "initialized", ready: false, modelCalls: 0 };
    output(r, env);
    return r;
  }
  if (op === "finish") {
    const snapshot = await ledger.read();
    const g = snapshot.state.grants[inputs.grantId];
    if (!g || g.runId !== context.runId || g.runAttempt !== 1)
      throw Error("Discovery finish parent mismatch");
    if (g.status === "finished") {
      output({ outcome: g.outcome }, env);
      return;
    }
    const status = env.FACTORY_DISCOVERY_VERIFIED === "true" ? "discovery_complete" : "blocked";
    await ledger.update((s) => ({ state: p.finish(s, g.id, { status }) }));
    output({ outcome: status }, env);
    return;
  }
  const { state } = await ledger.read();
  p.assertNotStopped(state);
  if (
    !config.enabled ||
    !config.discovery ||
    (context.event !== "workflow_dispatch" && !config.automatic)
  ) {
    const r = { outcome: "disabled", ready: false, modelCalls: 0 };
    output(r, env);
    return r;
  }
  const tested = await testedMain(
    api,
    context,
    env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {}
  );
  const registry = (await store.read()).state;
  const queue = await api.pages(`${ROOT}/issues?state=open&labels=factory-ready&per_page=100`);
  const day = p.dayKey(new Date(), config.timezone);
  const choice = selectSweep({
    state,
    registry,
    head: tested.head,
    day,
    config,
    repairsWaiting: queue.some(
      (i) =>
        !i.pull_request && !state.tickets[String(i.number)] && i.number !== config.activityIssue
    ),
  });
  if (!choice.ready) {
    output({ outcome: "held", ...choice, modelCalls: 0 }, env);
    return choice;
  }
  if (context.event === "workflow_dispatch" && (op !== "run" || inputs.dry_run !== false)) {
    const r = { outcome: "preview", ...choice, head: tested.head, modelCalls: 0, ready: false };
    output(r, env);
    return r;
  }
  const proof = {
    version: 1,
    ...tested,
    charter: choice.charter,
    day,
    key: c.sweepKey(tested.head, choice.charter, day),
    runId: context.runId,
    runAttempt: 1,
    workflowSha: context.workflowSha,
    workflowRef: c.WORKFLOW_REF,
  };
  const ticket = await sourceFor(api, store, proof);
  const request = {
    ...context,
    head: tested.head,
    ticket,
    origin: "discovery-sweep",
    discovery: proof,
  };
  const result = await ledger.update((s) => p.reserve(s, request, config));
  output(
    {
      ready: true,
      grantId: result.grant.id,
      head: tested.head,
      ticket,
      charter: choice.charter,
      outcome: "reserved",
    },
    env
  );
  return result;
}
if (require.main === module)
  main().catch((error) => {
    const msg = String(error.message || "").slice(0, 180);
    console.error(
      require("./artifacts.cjs").secretLike(msg)
        ? "Discovery operation held."
        : `Discovery operation held: ${msg}`
    );
    process.exitCode = 1;
  });
module.exports = { selectSweep, sourceFor, sourceBody, issueOK, testedMain, verifyParent, main };
