const { buildActivityEvent } = require("./activity-contract.cjs");
const { ROOT, Ledger } = require("./github.cjs");
const { REPOSITORY, OWNER } = require("./wake-contract.cjs");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// The stop audit is a durable command outbox, independent of whether stop is
// still active when GitHub next delivers an observer. No new stop-time network I/O.
function controlEvents({ state, commit }, producer, after) {
  const events = [];
  for (const row of state.audit) {
    if (
      row.actor !== OWNER ||
      !UUID.test(row.commandId || "") ||
      !Number.isFinite(Date.parse(row.at)) ||
      Date.parse(row.at) <= Date.parse(after) ||
      !["factory-stop-requested", "factory-stop-result", "factory-resumed"].includes(row.event)
    )
      continue;
    const operation =
      row.event === "factory-stop-requested"
        ? "request"
        : row.event === "factory-resumed"
          ? "resume"
          : `result-${Date.parse(row.at)}`;
    const phase = `stop-${row.commandId}-${operation}`;
    const pending = Array.isArray(row.pendingRunIds) ? row.pendingRunIds : [];
    const result = {
      commandId: row.commandId,
      operation: row.event,
      at: row.at,
      ...(row.event === "factory-stop-result"
        ? {
            switchesOff: row.switchesOff === true,
            inventoryComplete: row.inventoryComplete === true,
            pendingCount: pending.length,
            pendingRunIds: pending.slice(0, 20),
            terminalRunIds: (row.terminalRunIds || []).slice(0, 20),
            elapsedMs: row.elapsedMs,
          }
        : {}),
    };
    events.push(
      buildActivityEvent({
        producer: { ...producer, phase },
        kind: "stop",
        state:
          operation === "request"
            ? "requested"
            : row.event === "factory-stop-result" &&
                (pending.length || row.switchesOff !== true || row.inventoryComplete !== true)
              ? "held"
              : "completed",
        subject: 1,
        head: commit,
        summary: JSON.stringify(result),
        links: [`https://github.com/${REPOSITORY}/commit/${commit}`],
      })
    );
  }
  return events;
}
async function verifyControlEvent(api, event) {
  const file = await api.request("GET", `${ROOT}/contents/state.json?ref=${event.head}`);
  if (
    file.type !== "file" ||
    file.encoding !== "base64" ||
    typeof file.content !== "string" ||
    file.content.length > 1500000
  )
    throw Error("Invalid control audit snapshot");
  const state = require("./policy.cjs").validateState(
    JSON.parse(Buffer.from(file.content, "base64").toString("utf8"))
  );
  const canonical = controlEvents(
    { state, commit: event.head },
    event.producer,
    "1970-01-01T00:00:00.000Z"
  ).find((e) => e.id === event.id);
  if (!canonical || JSON.stringify(canonical) !== JSON.stringify(event))
    throw Error("Control activity does not match durable command history");
  const current = await new Ledger(api).read();
  if (current.commit !== event.head) {
    const compared = await api.request("GET", `${ROOT}/compare/${event.head}...${current.commit}`);
    if (compared.merge_base_commit?.sha !== event.head || compared.behind_by !== 0)
      throw Error("Control snapshot is outside retained ledger ancestry");
  }
}
module.exports = { controlEvents, verifyControlEvent };
