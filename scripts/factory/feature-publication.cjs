const c = require("./feature-contract.cjs");
const { ROOT } = require("./github.cjs");
const { MetadataStore } = require("./metadata-store.cjs");

const slot = (row, index) => (index < 0 ? row.parent : row.stages[index]);
function stageTicket(ledger, key, row, index) {
  const entry = row.stages[index];
  const ticket = entry?.phase === "ready" && ledger.tickets?.[entry.issue];
  return ticket?.feature && c.digest(ticket.feature) === c.digest(c.receiptFor(key, row, index))
    ? ticket
    : null;
}

function storeFor(api) {
  return new MetadataStore(api, "features", c.emptyRegistry, c.validateRegistry);
}

async function nextPart(api, ledger, state, week, mode) {
  const entries = Object.entries(state.records);
  let pending = null;
  let continuation = null;
  for (const [key, row] of entries) {
    if (row.parent?.phase === "intent") pending = { key, index: -1 };
    for (const [index, item] of row.stages.entries()) {
      if (!item) break;
      if (item.phase !== "ready") {
        pending = { key, index };
        break;
      }
      const ticket = stageTicket(ledger, key, row, index);
      if (ticket?.merge?.status === "merged") continue;
      const issue = await api.request("GET", ROOT + "/issues/" + item.issue);
      if (!c.issueMatches(issue, key, row, index, true, true)) return null;
      const terminal =
        ticket &&
        (ticket.merge?.status === "closed" ||
          (ticket.status === "blocked" && (!ticket.delayedRetry || ticket.delayedRetry.parent)));
      if (!terminal && (issue.state !== "closed" || issue.state_reason !== "not_planned"))
        return null;
      break;
    }
    const next = row.stages.indexOf(null);
    if (
      row.parent?.phase === "linked" &&
      next >= 0 &&
      (next === 0 || stageTicket(ledger, key, row, next - 1)?.merge?.status === "merged")
    )
      continuation = { key, index: next };
  }
  const selected = pending || continuation;
  if (selected) return state.records[selected.key].producer.mode === mode ? selected : null;
  const first = entries.find(
    ([, row]) =>
      row.week === week && row.producer.mode === mode && !row.parent && row.stages[0] === null
  );
  return first ? { key: first[0], index: first[1].proposal.size === "major" ? -1 : 0 } : null;
}

async function advance(store, key, index, expected, result) {
  return store.update((state) => {
    const row = state.records[key];
    if (!row || c.digest(slot(row, index)) !== c.digest(expected))
      throw Error("Feature publication state changed");
    if (index < 0) row.parent = result;
    else row.stages[index] = result;
    return { state, row };
  });
}

async function reconcile(api, key, row, index) {
  // Never repeat an uncertain create. A bounded scan recovers only an exact bot-authored match.
  const path = ROOT + "/issues?state=all&sort=created&direction=desc";
  const rows = await api.pages(path);
  const matches = rows.filter((issue) => c.issueMatches(issue, key, row, index));
  if (matches.length !== 1)
    throw Error("Feature create remains uncertain; no issue write attempted");
  return matches[0];
}
async function linkStage(api, key, row, stage, beforeWrite) {
  if (!row.parent) return;
  const parent = await api.request("GET", ROOT + "/issues/" + row.parent.issue);
  if (!c.issueMatches(parent, key, row, -1)) throw Error("Feature parent issue changed");
  if (!Number.isSafeInteger(stage.id) || stage.id < 1) throw Error("Missing GitHub stage identity");
  const path = ROOT + "/issues/" + parent.number + "/sub_issues";
  const linked = async () =>
    (await api.pages(path)).some((child) => child.id === stage.id && child.number === stage.number);
  if (await linked()) return;
  await beforeWrite();
  await api.request("POST", path, { sub_issue_id: stage.id, replace_parent: false });
  if (!(await linked())) throw Error("GitHub stage relationship was not confirmed");
}
async function publishPart({ api, store, beforeWrite }, { key, index }) {
  let row = (await store.read()).state.records[key];
  let item = slot(row, index);
  if (["ready", "linked"].includes(item?.phase)) return item;
  if (!item || item.phase === "intent") {
    await beforeWrite();
    let issue;
    if (!item) {
      const intent = { phase: "intent", issue: null };
      const saved = await advance(store, key, index, null, intent);
      row = saved.row;
      try {
        await beforeWrite();
      } catch (error) {
        // This attempt has not sent the POST. Compare the exact intent before clearing it.
        await advance(store, key, index, intent, null);
        throw error;
      }
      issue = await api.request("POST", ROOT + "/issues", c.issueFields(key, row, index));
    } else {
      issue = await reconcile(api, key, row, index);
    }
    if (!c.issueMatches(issue, key, row, index)) throw Error("Unexpected feature issue response");
    item = { phase: index < 0 ? "linked" : "created", issue: issue.number };
    row = (await advance(store, key, index, { phase: "intent", issue: null }, item)).row;
  }
  if (index < 0) return item;
  let issue = await api.request("GET", ROOT + "/issues/" + item.issue);
  if (
    !c.issueMatches(issue, key, row, index, false) &&
    !c.issueMatches(issue, key, row, index, true)
  )
    throw Error("Feature issue changed before readiness");
  await linkStage(api, key, row, issue, beforeWrite);
  await beforeWrite();
  if (!c.issueMatches(issue, key, row, index, true)) {
    await api.request("POST", ROOT + "/issues/" + item.issue + "/labels", { labels: [c.READY] });
    issue = await api.request("GET", ROOT + "/issues/" + item.issue);
  }
  if (!c.issueMatches(issue, key, row, index, true)) throw Error("Feature ready label unconfirmed");
  const ready = { phase: "ready", issue: item.issue };
  await advance(store, key, index, item, ready);
  return ready;
}
function mergedMajorParents(registry, ledger) {
  return Object.entries(registry.records).filter(
    ([key, row]) =>
      row.parent?.phase === "linked" &&
      row.stages.every(
        (_, index) => stageTicket(ledger, key, row, index)?.merge?.status === "merged"
      )
  );
}
module.exports = { storeFor, nextPart, publishPart, mergedMajorParents, stageTicket };
