const p = require("./policy.cjs");
const { runActorOK } = require("./discovery-contract.cjs");
const { BOT, BOT_ID } = require("./wake-contract.cjs");

const sources = new Set([
  "factory-ci.yml",
  "factory-automatic.yml",
  "factory-dependencies.yml",
  "factory-discovery.yml",
  "factory-agents.yml",
  "factory-monitor.yml",
  "factory-monitor-acknowledge.yml",
  "factory-ticket-closure.yml",
]);
const verified = new WeakSet();

function validActor(run) {
  const actor = run.actor;
  const trigger = run.triggering_actor || actor;
  if (!actor || trigger?.login !== actor.login || trigger.id !== actor.id) return false;
  return (
    (actor.login === BOT && actor.id === BOT_ID) ||
    runActorOK({ ...run, event: "workflow_run", triggering_actor: trigger })
  );
}

async function verifyContinuation(api, context, event) {
  const { verifiedRun } = require("./wake-controller.cjs");
  const source = event?.workflow_run;
  const file = source?.path?.split("/").at(-1);
  if (
    context.event !== "workflow_run" ||
    event?.action !== "completed" ||
    event.repository?.full_name !== p.REPOSITORY ||
    !sources.has(file) ||
    source.path !== ".github/workflows/" + file ||
    !Number.isSafeInteger(source.id) ||
    source.id < 1 ||
    !Number.isSafeInteger(source.run_attempt) ||
    source.run_attempt < 1
  )
    throw Error("Untrusted feature wake");
  const run = await verifiedRun(api, String(source.id), source.run_attempt, file, {
    success: false,
  });
  if (run.head_branch !== "main" || run.head_sha !== source.head_sha || !validActor(run))
    throw Error("Untrusted feature wake source");
  verified.add(context);
}

module.exports = {
  verifyContinuation,
  validActor,
  isContinuation: (context) => verified.has(context),
};
