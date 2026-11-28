const c = require("./wake-contract.cjs");
const slots = require("./active-tickets.cjs");
const { terminalParent } = require("./active-runs.cjs");
const { ROOT } = require("./github.cjs");
const mergeRetry = require("./dependency-merge-retry.cjs");
const { timerRun, TIMER_STEP } = require("./pickup-timer.cjs");

const AUTO_WORKFLOW = "factory-automatic.yml";
const CI_WORKFLOW = "factory-ci.yml";
const IDLE_STEP = "Hand off an idle app queue to dependency maintenance";
const MAX_SOURCE_CHECKS = 4;

const manualPickup = (run) =>
  run.event === "workflow_dispatch" && run.display_title === "Automatic factory";
const appWakeId = (run) =>
  run.event === "workflow_dispatch" &&
  /^Automatic factory \/ wake ([a-f0-9]{64})$/.exec(run.display_title)?.[1];

async function verifyIdlePickup(api, runId, attempt, store) {
  const { verifiedRun } = require("./wake-controller.cjs");
  if (attempt !== 1) return null;
  const run = await verifiedRun(api, runId, attempt, AUTO_WORKFLOW);
  const external = timerRun(run);
  const wake = appWakeId(run);
  if (run.head_branch !== "main") return null;
  if (
    !wake &&
    (!(run.event === "schedule" || external || manualPickup(run)) ||
      ![run.actor, run.triggering_actor].every((a) => a?.login === c.OWNER && a.id === c.OWNER_ID))
  )
    return null;
  const jobs = await api.pages(`${ROOT}/actions/runs/${run.id}/attempts/1/jobs`, "jobs");
  const idle = jobs.some(
    (job) =>
      job.name === "pick" &&
      job.status === "completed" &&
      job.conclusion === "success" &&
      job.steps?.some((step) => step.name === IDLE_STEP && step.conclusion === "success") &&
      (!external ||
        job.steps.some((step) => step.name === TIMER_STEP && step.conclusion === "success"))
  );
  if (!idle) return null;
  if (wake) {
    const wakeStore = store ?? new (require("./wake-store.cjs").WakeStore)(api);
    const receipt = (await wakeStore.read()).state.receipts[wake];
    if (!receipt || receipt.status !== "bound" || !c.isAppQueueCheck(receipt.signal)) return null;
    const context = {
      repository: c.REPOSITORY,
      actor: run.actor?.login,
      triggeringActor: run.triggering_actor?.login,
      ref: "refs/heads/main",
      event: run.event,
      workflowRef: `${c.REPOSITORY}/.github/workflows/${AUTO_WORKFLOW}@refs/heads/main`,
      workflowSha: run.head_sha,
      runId: String(run.id),
      runAttempt: attempt,
    };
    await require("./trusted-wake.cjs").verifyWake({
      api,
      context,
      store: wakeStore,
      receiptId: wake,
      lane: "app",
    });
  }
  return run;
}

const queueKey = (number, head) => c.digest(["dependency-queue", number, head]);

function queueCheckFor(run, number) {
  return {
    kind: "drain",
    lane: "dependency",
    number,
    head: run.head_sha,
    criteriaHash: queueKey(number, run.head_sha),
    revision: `queue-check:${run.run_attempt}`,
    sourceRun: String(run.id),
    sourceAttempt: run.run_attempt,
    actor: { login: run.actor.login, id: run.actor.id },
  };
}

async function verifyQueueCheck(api, signal, bound) {
  const run = await verifyIdlePickup(api, signal.sourceRun, signal.sourceAttempt);
  if (
    !run ||
    signal.head !== run.head_sha ||
    signal.actor.login !== run.actor.login ||
    signal.actor.id !== run.actor.id ||
    signal.criteriaHash !== queueKey(signal.number, signal.head)
  )
    throw Error("Untrusted dependency queue scan");
  if (!bound) {
    const main = await api.request("GET", `${ROOT}/git/ref/heads/main`);
    if (main.object?.sha !== signal.head)
      throw new c.StaleWakeSource("Scheduled dependency queue base changed");
  }
}

function needsMergeCheck(ticket, autoMerge) {
  return (
    ticket.dependency &&
    ticket.status === "reviewed" &&
    !["merged", "closed"].includes(ticket.merge?.status) &&
    (mergeRetry.blocksQueue(ticket) ||
      (autoMerge && (mergeRetry.due(ticket, new Date()) || mergeRetry.heldGate(ticket))))
  );
}

async function terminalDependency(api, state, autoMerge) {
  const [entry, ...other] = slots.activeEntries(state);
  if (!entry || other.length || slots.reservedPlanners(state).length) return null;
  const ticket = state.tickets[String(entry.ticket)];
  if (!ticket?.dependency) return null;
  const grants = Object.values(state.grants).filter((g) => g.ticket === entry.ticket);
  if (grants.some((g) => g.status === "reserved")) return null;
  const recoverable =
    ticket.merge?.status === "intent" ||
    (state.version === 2 && needsMergeCheck(ticket, autoMerge)) ||
    (!ticket.merge && !grants.some((g) => g.head === ticket.head));
  return recoverable && (await terminalParent(api, entry)) ? entry.ticket : null;
}

function inputsToCheck(rows, runId) {
  if (rows.length <= MAX_SOURCE_CHECKS) return rows;
  const offset = Number(BigInt(runId) % BigInt(rows.length));
  return [...rows.slice(offset), ...rows.slice(0, offset)].slice(0, MAX_SOURCE_CHECKS);
}

async function currentCIBase(api, signal) {
  if (signal.kind !== "dependency-ci" && !c.isFailedDependencyCI(signal)) return true;
  const base = await api.request(
    "GET",
    `${ROOT}/compare/${signal.revision}...${signal.head}?per_page=1`
  );
  return base.behind_by === 0 && base.merge_base_commit?.sha === signal.revision;
}

function dependencyWakeAttempted(state, signal, vars) {
  const ticket = state.tickets[String(signal.number)];
  if (!ticket?.dependency?.attempts.some((attempt) => attempt.head === signal.head)) return false;
  if (!c.isFailedDependencyCI(signal)) return true;
  const pr = {
    number: signal.number,
    head: { ref: ticket.branch, sha: signal.head },
    base: { sha: signal.revision },
  };
  const config = require("./policy.cjs").readConfig(vars);
  return !require("./dependency-policy.cjs").canClaimCompatibility(
    ticket,
    pr,
    config,
    Object.values(state.grants)
  );
}

async function nextDependency({ api, source, context, vars, ledger, store, state }) {
  if (
    state.stop ||
    vars.FACTORY_ENABLED !== "true" ||
    vars.FACTORY_AUTOMATION_ENABLED !== "true" ||
    vars.FACTORY_EVENT_PICKUP_ENABLED !== "true"
  )
    return null;
  const autoMerge = vars.FACTORY_AUTOMERGE_ENABLED === "true";
  const full = !slots.capacity(state, Number(vars.FACTORY_MAX_CONCURRENT_TICKETS));
  const terminal = full ? await terminalDependency(api, state, autoMerge) : null;
  if (full && !terminal) return null;
  const run = await verifyIdlePickup(api, String(source.id), source.run_attempt, store);
  if (!run || run.head_sha !== context.workflowSha) return null;
  const { state: wakes } = await store.read();
  if (
    Object.values(wakes.receipts).some(
      (r) =>
        c.isQueueCheckDrain(r.signal) &&
        r.signal.sourceRun === String(run.id) &&
        r.status !== "pending"
    )
  )
    return { duplicate: true };

  const intent = slots.pendingIntent(state);
  if (intent && !intent.record.dependency) return null;
  const merge = Object.values(state.tickets).find((ticket) => needsMergeCheck(ticket, autoMerge));
  const skipped = [];
  let number = terminal || intent?.ticket || merge?.pr;
  if (!number) {
    const unused = (signal) => {
      const prior = wakes.receipts[c.sourceKey(signal)];
      return (
        !dependencyWakeAttempted(state, signal, vars) && (!prior || prior.status === "pending")
      );
    };
    const pending = Object.values(wakes.receipts).filter(
      (r) => r.status === "pending" && c.isDependencyCI(r.signal) && unused(r.signal)
    );
    for (const { signal } of inputsToCheck(pending, run.id)) {
      try {
        await require("./trusted-wake.cjs").verifySource(api, signal, false, vars);
        if (await currentCIBase(api, signal))
          return { signal, queueCheck: queueCheckFor(run, signal.number), skipped };
      } catch (error) {
        if (error.quotaResetAt || error.status === 429) throw error;
        skipped.push({
          number: signal.number,
          reason: "Dependency wake proof could not be verified",
        });
      }
    }

    // Rediscover recent exact-head CI if its original completion wake was missed.
    const { workflow_runs: recent } = await api.request(
      "GET",
      `${ROOT}/actions/workflows/${CI_WORKFLOW}/runs?event=pull_request&status=completed&per_page=12`
    );
    const ready = (recent || []).filter((ci) => {
      const native = ci.actor?.login === "dependabot[bot]";
      const app =
        vars.FACTORY_GITHUB_APP_SLUG && ci.actor?.login === `${vars.FACTORY_GITHUB_APP_SLUG}[bot]`;
      const failed = ci.conclusion === "failure" && native;
      const succeeded = ci.conclusion === "success" && (native || app);
      return (
        (failed || succeeded) &&
        ci.pull_requests?.some(
          (pr) =>
            !dependencyWakeAttempted(
              state,
              {
                kind: failed ? "dependency-failed-ci" : "dependency-ci",
                number: pr.number,
                head: ci.head_sha,
                revision: run.head_sha,
              },
              vars
            )
        )
      );
    });
    for (const ci of inputsToCheck(ready, run.id)) {
      try {
        const signal = await require("./wake-controller.cjs").classifySignal({
          api,
          context,
          event: {
            repository: { full_name: c.REPOSITORY },
            action: "completed",
            workflow_run: ci,
          },
          ledger,
          store,
          vars,
        });
        if (signal && unused(signal) && (await currentCIBase(api, signal)))
          return { signal, queueCheck: queueCheckFor(run, signal.number), skipped };
      } catch (error) {
        if (error.quotaResetAt || error.status === 429) throw error;
        skipped.push({ run: ci.id, reason: "Dependency CI proof could not be verified" });
      }
    }
    number = await require("./dependency-tracking.cjs").previewNativeRecovery(api, { ledger });
  }
  if (!number) return skipped.length ? { skipped } : null;
  // This receipt can run the model-free dependency recovery scan. It carries no
  // exact PR CI target and therefore cannot reserve a dependency model review.
  const queueCheck = queueCheckFor(run, number);
  return { signal: queueCheck, queueCheck, terminal, skipped };
}

async function reconcileDispatches(api, store, receipts) {
  const expected = new Map();
  for (const r of receipts) {
    const list = expected.get(r.signal.lane) || [];
    list.push(r);
    expected.set(r.signal.lane, list);
  }
  const accepted = [];
  const { verifyDispatchIdentity } = require("./trusted-wake.cjs");
  for (const [lane, intents] of expected) {
    const file = c.LANES[lane];
    const { workflow_runs } = await api.request(
      "GET",
      `${ROOT}/actions/workflows/${file}/runs?branch=main&event=workflow_dispatch&per_page=12`
    );
    if (!Array.isArray(workflow_runs) || workflow_runs.length > 12) continue;
    const title = lane === "app" ? "Automatic factory" : "Dependency maintenance";
    for (const r of intents) {
      const matches = workflow_runs.filter(
        (run) =>
          run.display_title === `${title} / wake ${r.id}` &&
          Date.parse(run.created_at) + 1000 >= Date.parse(r.at)
      );
      if (matches.length !== 1 || !c.ID.test(String(matches[0].id))) continue;
      const [run] = matches;
      try {
        await verifyDispatchIdentity(
          api,
          { runId: String(run.id), workflowSha: run.head_sha },
          r,
          lane,
          run
        );
      } catch (error) {
        if (error.quotaResetAt || [429, 500, 502, 503, 504].includes(error.status)) throw error;
        continue;
      }
      accepted.push(r.id);
    }
  }
  if (!accepted.length) return 0;
  const result = await store.update((state) => {
    let reconciled = 0;
    for (const id of accepted) {
      if (state.receipts[id]?.status !== "intent") continue;
      state.receipts[id].status = "sent";
      reconciled++;
    }
    return { state, reconciled };
  });
  return result.reconciled;
}

function scheduleHold(state, limit) {
  if (state.stop) return "stopped";
  if (slots.pendingIntent(state)) return "merge_intent_pending";
  return slots.capacity(state, limit) ? null : "busy";
}

async function recoverScheduledWake({ api, context, vars, store, ledger, producer, dispatchWake }) {
  if (vars.FACTORY_ENABLED !== "true" || vars.FACTORY_AUTOMATION_ENABLED !== "true")
    return { outcome: "disabled" };
  const limit = Number(vars.FACTORY_MAX_CONCURRENT_TICKETS);
  const { state: controls } = await ledger.read();
  const hold = scheduleHold(controls, limit);
  if (hold) return { outcome: hold };
  const main = await api.request("GET", `${ROOT}/git/ref/heads/main`);
  if (main.object?.sha !== context.workflowSha) return { outcome: "stale_main" };

  const { state } = await store.read();
  const receipts = Object.values(state.receipts);
  if (!Number.isFinite(producer.createdAt)) throw Error("Invalid scheduled wake start");
  const recentlyClaimed = (row) =>
    ["intent", "sent", "bound"].includes(row.status) && Date.parse(row.at) >= producer.createdAt;
  const intents = inputsToCheck(
    receipts.filter((r) => r.status === "intent"),
    producer.runId
  );
  const reconciled = await reconcileDispatches(api, store, intents);
  // A confirmed receiver can still be starting. Leave this tick to that receiver.
  if (reconciled) return { outcome: "reconciled", reconciled };
  if (receipts.some(recentlyClaimed)) return { outcome: "duplicate" };

  const pending = receipts.filter(
    (r) =>
      r.status === "pending" &&
      !c.isPreparationDrain(r.signal) &&
      (r.signal.kind !== "drain" || c.isAppQueueCheck(r.signal))
  );
  const stale = [];
  let target;
  const { verifySource, verifyRetainedProducer } = require("./trusted-wake.cjs");
  for (const r of inputsToCheck(pending, producer.runId)) {
    const { signal } = r;
    try {
      const ticket = controls.tickets[String(signal.number)];
      if (
        (signal.lane === "app" && signal.kind !== "drain" && ticket) ||
        (c.isDependencyCI(signal) && dependencyWakeAttempted(controls, signal, vars))
      )
        throw new c.StaleWakeSource("Wake already attempted");
      await verifySource(api, signal, false, vars);
      if (!(await currentCIBase(api, signal)))
        throw new c.StaleWakeSource("Wake dependency base stale");
      await verifyRetainedProducer(api, r);
      target = r;
      break;
    } catch (error) {
      if (error.quotaResetAt || error.status === 429) throw error;
      if (error instanceof c.StaleWakeSource) stale.push(r.id);
    }
  }
  if (!target && !stale.length) return { outcome: "idle" };
  const currentHold = scheduleHold((await ledger.read()).state, limit);
  if (currentHold) return { outcome: currentHold };
  const claim = await store.update((current) => {
    if (Object.values(current.receipts).some(recentlyClaimed))
      return { state: current, duplicate: true };
    for (const id of stale) {
      if (current.receipts[id]?.status === "pending") current.receipts[id].status = "observed";
    }
    const receipt = target && current.receipts[target.id];
    if (!receipt || receipt.status !== "pending") return { state: current };
    // The original event still proves this receipt's authority. Only the claim
    // time changes, so existing workers can read and verify the same schema.
    receipt.status = "intent";
    receipt.at = new Date().toISOString();
    return { state: current, receipt };
  });
  if (claim.receipt) return dispatchWake(api, store, claim.receipt);
  return { outcome: claim.duplicate ? "duplicate" : "idle" };
}

module.exports = {
  nextDependency,
  verifyQueueCheck,
  dependencyWakeAttempted,
  terminalDependency,
  manualPickup,
  appWakeId,
  recoverScheduledWake,
};
