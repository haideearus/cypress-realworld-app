const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const policy = require("./policy.cjs");
const { GitHub, Ledger, ROOT } = require("./github.cjs");
const { SWITCHES, validateStop } = require("./stop-contract.cjs");
const { hasContainment, inspectQuarantine, partitionRuns } = require("./quarantine.cjs");
const AGENT_WORKFLOWS = Object.freeze(
  [
    "factory-agents.yml",
    "factory-automatic.yml",
    "factory-dependencies.yml",
    "factory-monitor-drill.yml",
    "factory-model.yml",
    "factory-cycle.yml",
    "factory-pr-review.yml",
  ].map((file) => `.github/workflows/${file}`)
);
const monotonic = () => performance.now();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function owner(actor) {
  if (actor !== policy.OWNER)
    throw new Error("Only the repository owner can stop or resume the factory");
}
function agent(run) {
  return (
    run &&
    Number.isSafeInteger(run.id) &&
    run.id > 0 &&
    AGENT_WORKFLOWS.includes(run.path?.split("@")[0])
  );
}
async function runs(api) {
  const groups = await Promise.all(
    ["queued", "in_progress", "waiting", "pending", "requested"].map(async (status) => {
      const selected = [];
      for (let page = 1; page <= 10; page++) {
        const response = await api.request(
          "GET",
          `${ROOT}/actions/runs?status=${status}&per_page=100&page=${page}`
        );
        if (!Array.isArray(response.workflow_runs) || response.workflow_runs.length > 100)
          throw new Error("Invalid bounded workflow inventory");
        selected.push(
          ...response.workflow_runs.filter((run) => agent(run) && run.status !== "completed")
        );
        if (response.workflow_runs.length < 100) return selected;
      }
      throw new Error("Active workflow inventory exceeds stop safety bound");
    })
  );
  return [...new Map(groups.flat().map((run) => [run.id, run])).values()];
}
async function settings(api) {
  const response = await api.request("GET", `${ROOT}/actions/variables?per_page=100`);
  if (!Array.isArray(response.variables) || response.variables.length > 100)
    throw new Error("Invalid stop switch inventory");
  const values = Object.fromEntries(
    response.variables
      .filter((item) => SWITCHES.includes(item.name))
      .map((item) => [item.name, item.value])
  );
  if (SWITCHES.some((key) => !["true", "false"].includes(values[key])))
    throw new Error("Missing factory stop switches");
  return values;
}
function cleanup(state, terminalIds) {
  const next = structuredClone(state);
  if (next.active && terminalIds.has(Number(next.active.runId))) {
    const active = next.active;
    for (const grant of Object.values(next.grants)) {
      if (
        grant.ticket === active.ticket &&
        grant.runId === active.runId &&
        grant.runAttempt === active.runAttempt &&
        grant.status === "reserved"
      ) {
        grant.status = "finished";
        grant.outcome = "blocked";
      }
    }
    const ticket = next.tickets[String(active.ticket)];
    if (ticket.status !== "reviewed") {
      ticket.status = "blocked";
      ticket.approval = null;
    }
    next.active = null;
  }
  return next;
}
async function stopFactory({
  api,
  actor,
  execute = false,
  ledger = new Ledger(api),
  clock = monotonic,
  sleep = pause,
  started = clock(),
}) {
  owner(actor);
  if (typeof execute !== "boolean") throw new Error("Invalid stop execution flag");
  const deadline = started + 55000;
  const { state: original } = await ledger.read();
  const previous = original.stop?.previous || (await settings(api));
  if (!execute) {
    const inventory = await partitionRuns(api, original, await runs(api));
    return {
      preview: true,
      runIds: inventory.pending.map((run) => run.id),
      quarantinedRunIds: inventory.quarantinedRunIds,
      quarantinedRuns: inventory.quarantined,
      switches: previous,
      stopped: !!original.stop,
    };
  }
  if (clock() >= deadline) throw new Error("Stop deadline reached before mutation");
  let stop = original.stop;
  if (!stop) {
    stop = {
      id: randomUUID(),
      at: new Date().toISOString(),
      actor,
      reason: "Owner emergency stop",
      previous,
    };
    validateStop(stop);
    await ledger.update((state) => {
      if (state.stop) {
        stop = state.stop;
        return { state };
      }
      const next = structuredClone(state);
      next.stop = stop;
      policy.audit(next, "factory-stop-requested", {
        actor,
        commandId: stop.id,
        reason: stop.reason,
      });
      return { state: next };
    });
  }
  let pending = [];
  let quarantined = new Map();
  const terminalIds = new Set();
  const requested = new Set();
  const forced = new Set();
  let errorCount = 0;
  let switchesOff = false;
  let settled = false;
  let inventoryComplete = false;
  // Variable service failures must not prevent cancelling an already-running model.
  const switched = await Promise.allSettled(
    SWITCHES.map((name) =>
      api.request("PATCH", `${ROOT}/actions/variables/${name}`, { name, value: "false" })
    )
  );
  errorCount += switched.filter((result) => result.status === "rejected").length;
  try {
    const actual = await settings(api);
    switchesOff = SWITCHES.every((name) => actual[name] === "false");
  } catch {
    errorCount++;
  }
  try {
    while (clock() < deadline) {
      let current = [];
      inventoryComplete = false;
      try {
        current = await runs(api);
        inventoryComplete = true;
      } catch {
        errorCount++;
      }
      const byId = new Map(
        [...pending, ...quarantined.values(), ...current].map((run) => [run.id, run])
      );
      const loaded = await ledger.read();
      if (loaded.state.stop?.id !== stop.id) throw new Error("Durable stop marker changed");
      if (loaded.state.active) {
        const activeId = Number(loaded.state.active.runId);
        if (!byId.has(activeId)) {
          const activeRun = await api.request("GET", `${ROOT}/actions/runs/${activeId}`);
          if (!agent(activeRun))
            throw new Error("Active ledger run cannot be verified as an agent workflow");
          byId.set(activeId, activeRun);
        }
      }
      pending = [];
      quarantined = new Map();
      for (const id of byId.keys()) {
        if (clock() >= deadline) {
          pending.push({ id });
          continue;
        }
        try {
          const run = await api.request("GET", `${ROOT}/actions/runs/${id}`);
          if (!agent(run) || run.id !== id) throw new Error("Agent cancellation identity changed");
          if (run.status === "completed") {
            if (Number(loaded.state.active?.runId) === id) {
              const attempt = await api.request(
                "GET",
                `${ROOT}/actions/runs/${id}/attempts/${loaded.state.active.runAttempt}`
              );
              if (
                attempt.run_attempt !== loaded.state.active.runAttempt ||
                attempt.status !== "completed"
              )
                throw new Error("Active reservation attempt is not confirmed terminal");
            }
            terminalIds.add(id);
            continue;
          }
          const proof = await inspectQuarantine(api, loaded.state, run);
          if (proof) {
            quarantined.set(id, proof);
            continue;
          }
          pending.push(run);
          const force = requested.has(id);
          if (force && forced.has(id)) continue;
          (force ? forced : requested).add(id);
          try {
            await api.request(
              "POST",
              `${ROOT}/actions/runs/${id}/${force ? "force-cancel" : "cancel"}`
            );
          } catch {
            errorCount++;
          }
        } catch {
          errorCount++;
          if (!pending.some((run) => run.id === id)) pending.push({ id });
        }
      }
      if (inventoryComplete && !pending.length) break;
      await sleep(Math.min(1000, Math.max(0, deadline - clock())));
    }
    if (clock() < deadline) {
      await ledger.update((state) => {
        if (state.stop?.id !== stop.id) throw new Error("Durable stop marker changed");
        if (quarantined.size && !hasContainment(state)) {
          pending.push(...quarantined.values());
          quarantined.clear();
          throw new Error("Quarantine containment changed");
        }
        const next = cleanup(state, terminalIds);
        policy.audit(next, "factory-stop-result", {
          actor,
          commandId: stop.id,
          terminalRunIds: [...terminalIds],
          quarantinedRunIds: [...quarantined.keys()],
          quarantinedRuns: [...quarantined.values()],
          pendingRunIds: pending.map((run) => run.id),
          elapsedMs: Math.ceil(clock() - started),
        });
        return { state: next };
      });
      settled = true;
    }
  } catch {
    errorCount++;
  }
  const elapsedMs = Math.ceil(clock() - started);
  const stopped =
    switchesOff && inventoryComplete && settled && pending.length === 0 && elapsedMs <= 55000;
  return {
    preview: false,
    stopped,
    withinMinute: stopped && elapsedMs < 60000,
    elapsedMs,
    commandId: stop.id,
    pendingRunIds: pending.map((run) => run.id),
    terminalRunIds: [...terminalIds],
    quarantinedRunIds: [...quarantined.keys()],
    quarantinedRuns: [...quarantined.values()],
    errorCount,
    reason: stopped
      ? quarantined.size
        ? "Executable agent parents are terminal; independently contained queued record retained; durable stop active"
        : "All agent parents are terminal; durable stop remains active"
      : "Stop incomplete; durable marker and unresolved locks are retained",
  };
}
async function resumeFactory({ api, actor, execute = false, ledger = new Ledger(api) }) {
  owner(actor);
  if (typeof execute !== "boolean") throw new Error("Invalid resume execution flag");
  const { state } = await ledger.read();
  if (!state.stop) throw new Error("Factory has no durable stop marker to resume");
  validateStop(state.stop);
  let inventory = await partitionRuns(api, state, await runs(api));
  if (state.active || inventory.pending.length)
    throw new Error("Active or running agents must be terminal before resume");
  if (!execute)
    return {
      preview: true,
      restore: state.stop.previous,
      quarantinedRunIds: inventory.quarantinedRunIds,
      quarantinedRuns: inventory.quarantined,
    };
  await Promise.all(
    SWITCHES.map((name) =>
      api.request("PATCH", `${ROOT}/actions/variables/${name}`, {
        name,
        value: state.stop.previous[name],
      })
    )
  );
  const actual = await settings(api);
  if (SWITCHES.some((name) => actual[name] !== state.stop.previous[name]))
    throw new Error("Resume switches were not acknowledged; durable stop retained");
  await ledger.update(async (current) => {
    if (current.stop?.id !== state.stop.id || current.active)
      throw new Error("Factory state changed before resume");
    inventory = await partitionRuns(api, current, await runs(api));
    if (inventory.pending.length) throw new Error("Running agents changed before resume");
    const next = structuredClone(current);
    delete next.stop;
    policy.audit(next, "factory-resumed", {
      actor,
      commandId: state.stop.id,
      restored: state.stop.previous,
      quarantinedRunIds: inventory.quarantinedRunIds,
      quarantinedRuns: inventory.quarantined,
    });
    return { state: next };
  });
  return {
    preview: false,
    resumed: true,
    restored: state.stop.previous,
    quarantinedRunIds: inventory.quarantinedRunIds,
    quarantinedRuns: inventory.quarantined,
  };
}
async function main(env = process.env, args = process.argv.slice(2)) {
  const started = monotonic();
  if (
    args.some((arg) => !["--execute", "--resume"].includes(arg)) ||
    new Set(args).size !== args.length
  )
    throw new Error("Usage: node scripts/factory/stop.cjs [--resume] [--execute]");
  let token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    const reply = execFileSync(
      "git",
      ["-c", "credential.interactive=never", "credential", "fill"],
      {
        input: "protocol=https\nhost=github.com\n\n",
        encoding: "utf8",
        timeout: 6000,
        stdio: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      }
    );
    token = reply
      .split("\n")
      .find((line) => line.startsWith("password="))
      ?.slice(9)
      .trim();
  }
  if (!token) throw new Error("Existing owner GitHub authentication is required");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const auth = await fetch("https://api.github.com/user", {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(6000),
  });
  if (!auth.ok) throw new Error("Owner GitHub authentication failed");
  const actor = (await auth.json()).login;
  owner(actor);
  const api = new GitHub({
    token,
    fetch: (url, options) => {
      const remaining = 55000 - (monotonic() - started);
      if (remaining <= 0) throw new Error("Stop command deadline reached");
      return fetch(url, {
        ...options,
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, Math.floor(remaining)))),
      });
    },
  });
  const result = await (args.includes("--resume") ? resumeFactory : stopFactory)({
    api,
    actor,
    execute: args.includes("--execute"),
    started,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.stopped === false && !result.preview) process.exitCode = 1;
  return result;
}
if (require.main === module)
  main().catch(() => {
    console.error(
      "Factory control failed closed; inspect the stop marker and active runs. No credentials are logged."
    );
    process.exitCode = 1;
  });
module.exports = { AGENT_WORKFLOWS, stopFactory, resumeFactory, main };
