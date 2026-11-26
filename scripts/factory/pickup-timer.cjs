const c = require("./wake-contract.cjs");
const { GitHub, ROOT } = require("./github.cjs");
const { output, runtimeContext } = require("./controller.cjs");

const WORKFLOW_PATH = `.github/workflows/${c.LANES.app}`;
const TIMER_STEP = "Check the pickup timer";
const PICK_STEP = "Select eligible factory work";
const WINDOW_MS = 10 * 60 * 1000;
const OFFSET_MS = 3 * 60 * 1000;

function windowStart(time) {
  return Math.floor((time - OFFSET_MS) / WINDOW_MS) * WINDOW_MS + OFFSET_MS;
}

function ownerRun(run) {
  return (
    run?.path === WORKFLOW_PATH &&
    run.head_branch === "main" &&
    run.repository?.full_name === c.REPOSITORY &&
    run.head_repository?.full_name === c.REPOSITORY &&
    run.run_attempt === 1 &&
    [run.actor, run.triggering_actor].every((a) => a?.login === c.OWNER && a.id === c.OWNER_ID)
  );
}

function timerTitle(run) {
  return (
    run?.path === WORKFLOW_PATH &&
    run.event === "workflow_dispatch" &&
    run.display_title?.startsWith("Automatic factory / timer ")
  );
}

function timerRun(run) {
  return (
    ownerRun(run) &&
    timerTitle(run) &&
    Number.isFinite(Date.parse(run.created_at)) &&
    run.display_title === `Automatic factory / timer ${windowStart(Date.parse(run.created_at))}`
  );
}

async function pickupCompleted(api, run) {
  const { jobs } = await api.request(
    "GET",
    `${ROOT}/actions/runs/${run.id}/attempts/1/jobs?per_page=15`
  );
  return jobs.some(
    (job) =>
      job.name === "pick" &&
      job.run_id === run.id &&
      job.head_sha === run.head_sha &&
      job.steps?.some((step) => step.name === PICK_STEP && step.conclusion === "success")
  );
}

async function checkPickupTick(api, { context, inputs, vars }) {
  const held = (outcome, reason) => ({ allowed: false, outcome, reason });
  if (vars.FACTORY_EXTERNAL_PICKUP_ENABLED !== "true")
    return held("disabled", "External pickup is disabled");
  const native = context.event === "schedule";
  if (!native && vars.FACTORY_MAX_CONCURRENT_TICKETS !== "1")
    return held("held", "The pickup timer requires FACTORY_MAX_CONCURRENT_TICKETS=1");
  if (
    context.repository !== c.REPOSITORY ||
    context.actor !== c.OWNER ||
    context.triggeringActor !== c.OWNER ||
    context.ref !== "refs/heads/main" ||
    context.workflowRef !== `${c.REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main` ||
    context.runAttempt !== 1 ||
    !c.ID.test(context.runId || "") ||
    (!native &&
      (context.event !== "workflow_dispatch" ||
        inputs.operation !== "run" ||
        ![false, "false"].includes(inputs.dry_run) ||
        !/^\d{13}$/.test(inputs.timer_tick || "") ||
        inputs.ticket ||
        inputs.fix_pr ||
        inputs.wake_id))
  )
    return held("held", "Untrusted pickup timer request");

  const current = await api.request("GET", `${ROOT}/actions/runs/${context.runId}`);
  const created = Date.parse(current?.created_at);
  const start = windowStart(created);
  if (
    !ownerRun(current) ||
    current.id !== Number(context.runId) ||
    current.event !== context.event ||
    current.head_sha !== context.workflowSha ||
    !Number.isFinite(created) ||
    (!native && (!timerRun(current) || inputs.timer_tick !== String(start)))
  )
    return held("held", "Pickup timer run metadata did not match its window");

  const from = encodeURIComponent(`>=${new Date(start).toISOString()}`);
  const { total_count: count, workflow_runs: runs } = await api.request(
    "GET",
    `${ROOT}/actions/workflows/${c.LANES.app}/runs?branch=main&created=${from}&per_page=50`
  );
  if (!Array.isArray(runs) || !Number.isSafeInteger(count) || count > runs.length)
    return held("held", "Pickup timer could not verify a complete window of runs");
  const overlaps = runs.filter((run) => {
    const runTime = Date.parse(run.created_at);
    return (
      ownerRun(run) &&
      (run.event === "schedule" || timerRun(run)) &&
      run.id !== current.id &&
      Number.isSafeInteger(run.id) &&
      runTime >= start &&
      runTime < start + WINDOW_MS &&
      ["in_progress", "completed"].includes(run.status)
    );
  });
  if (overlaps.length > 4) return held("held", "Pickup timer exceeded its window evidence limit");
  for (const run of overlaps) {
    if (await pickupCompleted(api, run))
      return held("duplicate", `Pickup already checked this window in run ${run.id}`);
  }
  return { allowed: true, outcome: "checking", reason: "Pickup timer admitted one queue check" };
}

if (require.main === module) {
  const env = process.env;
  checkPickupTick(new GitHub({ token: env.GH_TOKEN }), {
    context: runtimeContext(env),
    inputs: JSON.parse(env.FACTORY_INPUTS || "{}"),
    vars: {
      FACTORY_EXTERNAL_PICKUP_ENABLED: env.FACTORY_EXTERNAL_PICKUP_ENABLED,
      FACTORY_MAX_CONCURRENT_TICKETS: env.FACTORY_MAX_CONCURRENT_TICKETS,
    },
  })
    .then((result) => {
      output(result, env);
      console.log(JSON.stringify(result));
    })
    .catch(() => {
      console.error("Pickup timer held because GitHub run evidence could not be read");
      process.exitCode = 1;
    });
}

module.exports = { checkPickupTick, pickupCompleted, timerRun, timerTitle, TIMER_STEP };
