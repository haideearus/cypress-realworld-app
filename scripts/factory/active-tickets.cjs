// Usage-ledger execution ownership only. Monitor registries have a different `active` field.
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
function activeEntries(state) {
  if (!record(state) || ![1, 2].includes(state.version)) throw new Error("Invalid ledger version");
  if (state.version === 1) {
    if (Object.hasOwn(state, "activeTickets") || !Object.hasOwn(state, "active"))
      throw new Error("Mixed active ticket schemas");
    if (state.active === null) return [];
    return [state.active];
  }
  if (Object.hasOwn(state, "active") || !record(state.activeTickets))
    throw new Error("Mixed active ticket schemas");
  const entries = Object.entries(state.activeTickets);
  if (entries.length > 2 || entries.some(([key, value]) => String(value?.ticket) !== key))
    throw new Error("Invalid active ticket map");
  return entries.map(([, value]) => value);
}
function validateActive(state) {
  const entries = activeEntries(state);
  const parents = new Set();
  for (const entry of entries) {
    if (
      !record(entry) ||
      Object.keys(entry).sort().join(",") !== "runAttempt,runId,ticket" ||
      !Number.isSafeInteger(entry.ticket) ||
      entry.ticket < 1 ||
      !Object.hasOwn(state.tickets, String(entry.ticket)) ||
      typeof entry.runId !== "string" ||
      !/^[1-9]\d*$/.test(entry.runId) ||
      !Number.isSafeInteger(entry.runAttempt) ||
      entry.runAttempt < 1 ||
      parents.has(entry.runId)
    )
      throw new Error("Invalid ledger active ticket");
    parents.add(entry.runId);
  }
  return entries;
}
function activeFor(state, ticket) {
  return activeEntries(state).find((entry) => entry.ticket === ticket) || null;
}
function capacity(state, limit) {
  if (![1, 2].includes(limit)) throw new Error("Invalid active ticket capacity");
  if (state.version === 1 && limit !== 1)
    throw new Error("Concurrency two requires owner ledger migration to version two");
  return activeEntries(state).length < limit;
}
const owns = (entry, owner) =>
  Boolean(
    entry && owner && ["ticket", "runId", "runAttempt"].every((key) => entry[key] === owner[key])
  );
function claimActive(state, entry, limit) {
  const existing = activeFor(state, entry.ticket);
  if (existing && !owns(existing, entry))
    throw new Error("Another active ticket/run holds the factory lock");
  // Reentrant ownership permits sequential phases, never a second reserved grant.
  const available = capacity(state, limit);
  if (!existing && !available)
    throw new Error("Another active ticket holds the factory capacity lock");
  if (state.version === 1) state.active = { ...entry };
  else state.activeTickets[String(entry.ticket)] = { ...entry };
  return state;
}
function releaseActive(state, entry) {
  if (!owns(activeFor(state, entry.ticket), entry))
    throw new Error("Cannot release another active run");
  if (state.version === 1) state.active = null;
  else delete state.activeTickets[String(entry.ticket)];
  return state;
}
function pendingIntent(state) {
  const intents = Object.entries(state.tickets).filter(
    ([, ticket]) => ticket.merge?.status === "intent"
  );
  if (intents.length > 1)
    throw new Error("Ambiguous global merge intents; owner reconciliation required");
  return intents.length ? { ticket: Number(intents[0][0]), record: intents[0][1] } : null;
}
module.exports = {
  activeEntries,
  activeFor,
  validateActive,
  capacity,
  owns,
  claimActive,
  releaseActive,
  pendingIntent,
};
