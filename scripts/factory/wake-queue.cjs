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
    if (
      !receipt ||
      receipt.status !== "bound" ||
      (!c.isMainQueueCheck(receipt.signal) && !c.isAppMergeDrain(receipt.signal))
    )
      return null;
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
    (mergeRetry.blocksQueue(ticket) || (autoMerge && mergeRetry.due(ticket, new Date())))
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
  if (signal.kind !== "dependency-ci") return true;
  const base = await api.request(
    "GET",
    `${ROOT}/compare/${signal.revision}...${signal.head}?per_page=1`
  );
  return base.behind_by === 0 && base.merge_base_commit?.sha === signal.revision;
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
    const alreadyAttempted = (number, head) =>
      state.tickets[String(number)]?.dependency?.attempts.some((attempt) => attempt.head === head);
    const unused = (signal) => {
      const prior = wakes.receipts[c.sourceKey(signal)];
      return (
        !alreadyAttempted(signal.number, signal.head) && (!prior || prior.status === "pending")
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
      `${ROOT}/actions/workflows/${CI_WORKFLOW}/runs?event=pull_request&status=success&per_page=12`
    );
    const ready = (recent || []).filter(
      (ci) =>
        (ci.actor?.login === "dependabot[bot]" ||
          (vars.FACTORY_GITHUB_APP_SLUG &&
            ci.actor?.login === `${vars.FACTORY_GITHUB_APP_SLUG}[bot]`)) &&
        ci.pull_requests?.some((pr) => !alreadyAttempted(pr.number, ci.head_sha))
    );
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

module.exports = { nextDependency, verifyQueueCheck, terminalDependency, manualPickup, appWakeId };
