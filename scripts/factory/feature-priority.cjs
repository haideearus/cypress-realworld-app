const { ROOT } = require("./github.cjs");
const slots = require("./active-tickets.cjs");
const { MonitorStore } = require("./monitor-state.cjs");

async function productionIncident(api) {
  const { state } = await new MonitorStore(api).read();
  const incident = state.incidents[state.active];
  return incident && !incident.recovered ? incident : null;
}

function pendingRepairMerge(state) {
  return Object.values(state.tickets).some(
    (ticket) =>
      !ticket.feature &&
      (ticket.automatic || ticket.dependency) &&
      ticket.status === "reviewed" &&
      !["merged", "closed"].includes(ticket.merge?.status)
  );
}

async function repairsWaiting(api, config, context, state) {
  if (
    slots.pendingIntent(state) ||
    slots.activeEntries(state).some((entry) => !state.tickets[entry.ticket]?.feature) ||
    pendingRepairMerge(state)
  )
    return true;

  if (await productionIncident(api)) return true;
  const { AutomaticCoordinator } = require("./automation.cjs");
  const automatic = new AutomaticCoordinator(api, config, context);
  if (
    (await automatic.candidate(state, { complete: true })) ||
    (await automatic.delayedCandidate(state, { priorityCheck: true }))
  )
    return true;
  if (config.alertRepair) {
    const registry = await require("./dependency-alert-repair.cjs")
      .storeFor(api)
      .read({ allowMissing: true });
    if (
      Object.values(registry.state.records).some((row) =>
        ["prepared", "issue", "linked", "refresh"].includes(row.phase)
      )
    )
      return true;
  }
  return dependencyWaiting(api, config, context, state);
}

async function dependencyWaiting(api, config, context, state) {
  const d = require("./dependency-contract.cjs");
  const { DependencyCoordinator } = require("./dependencies.cjs");
  const coordinator = new DependencyCoordinator(api, config, context);
  for (let page = 1; page <= 5; page++) {
    const rows = await api.request(
      "GET",
      ROOT + "/pulls?state=open&base=main&per_page=100&page=" + page
    );
    if (!Array.isArray(rows) || rows.length > 100) throw Error("Invalid dependency priority queue");
    for (const row of rows) {
      try {
        d.prOK(row, false, config);
      } catch {
        continue;
      }
      const prior = state.tickets[row.number];
      if (
        prior &&
        (prior.merge ||
          prior.dependency?.attempts.some((attempt) => attempt.head === row.head.sha) ||
          prior.reviews >= Math.min(10, config.reviews))
      )
        continue;
      try {
        if ((await coordinator.pr(row.number)).head.sha === row.head.sha) return true;
      } catch (error) {
        if (
          error.message !== "Dependency PR requires a current-main rebase" &&
          !(error instanceof require("./dependency-alert-repair.cjs").AlertAdmissionHold)
        )
          throw error;
      }
    }
    if (rows.length < 100) return false;
  }
  throw Error("Dependency priority exceeds bounded inspection");
}

module.exports = { repairsWaiting, productionIncident, pendingRepairMerge };
