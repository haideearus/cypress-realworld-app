const { createHash } = require("node:crypto");
const { dayKey, SHA } = require("./policy.cjs");
const { secretLike, validPath } = require("./artifacts.cjs");

const TIMEZONE = "Europe/Bucharest";
const WORKFLOW = ".github/workflows/factory-features.yml";
const READY = "factory-ready";
const BOT = { id: 41898282, type: "Bot", login: "github-actions[bot]" };
const LIMITS = { major: 1, minor: 5 };
const HASH = /^[a-f0-9]{64}$/;
const RUN = /^[1-9]\d{0,15}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const record = (v) => v && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) =>
  record(v) && Object.keys(v).sort().join(",") === keys.split(",").sort().join(",");
const text = (v, min, max) =>
  typeof v === "string" &&
  v === v.trim() &&
  v.length >= min &&
  v.length <= max &&
  !/[\p{Cc}\p{Cf}]/u.test(v) &&
  !secretLike(v);
const prose = (v, min, max) =>
  text(v, min, max) && !/[<>`]|(?:https?|file):\/\/|(?:^|\s)@\S/i.test(v);
const title = (v) => prose(v, 10, 90) && /^[\p{L}\p{N}]/u.test(v);
const unique = (items) => new Set(items).size === items.length;
const normalized = (v) =>
  v
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.join(" ") || "";

function weekKey(now) {
  const date = new Date(dayKey(now, TIMEZONE) + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}
function validWeek(value) {
  if (!DATE.test(value || "")) return false;
  const date = new Date(value + "T12:00:00Z");
  return Number.isFinite(date.getTime()) && weekKey(date) === value;
}
function validateProposal(proposal) {
  if (
    !exact(proposal, "size,title,problem,benefit,evidence,steps") ||
    !Object.hasOwn(LIMITS, proposal.size) ||
    !title(proposal.title) ||
    !prose(proposal.problem, 35, 320) ||
    !prose(proposal.benefit, 30, 280) ||
    !Array.isArray(proposal.steps) ||
    proposal.steps.length < 1 ||
    proposal.steps.length > (proposal.size === "minor" ? 1 : 5)
  )
    throw Error("Invalid bounded feature proposal");
  const e = proposal.evidence;
  if (
    !text(e?.quote, 15, 180) ||
    (e.kind === "source"
      ? !exact(e, "kind,path,quote") ||
        !validPath(e.path) ||
        !/^(?:src|backend)\/[\w./-]+\.(?:[cm]?[jt]sx?|json|css|html)$/.test(e.path)
      : e.kind !== "issue" || !exact(e, "kind,number,quote") || !positive(e.number))
  )
    throw Error("Invalid feature evidence reference");
  for (const step of proposal.steps) {
    if (
      !exact(step, "title,scope,acceptance") ||
      !title(step.title) ||
      !prose(step.scope, 30, 350) ||
      !Array.isArray(step.acceptance) ||
      step.acceptance.length < 1 ||
      step.acceptance.length > 4 ||
      step.acceptance.some((v) => !prose(v, 30, 260)) ||
      !unique(step.acceptance.map(normalized))
    )
      throw Error("Invalid feature scope or acceptance criteria");
  }
  if (!unique(proposal.steps.map((s) => normalized(s.title))))
    throw Error("Duplicate feature stage");
  if (proposal.size === "minor" && proposal.steps[0].title !== proposal.title)
    throw Error("A minor proposal must have one matching issue title");
  return proposal;
}
const proposalKey = (proposal) => digest(normalized(proposal.title));
const evidenceKey = (proposal) =>
  digest([
    proposal.evidence.kind,
    proposal.evidence.path || proposal.evidence.number,
    normalized(proposal.evidence.quote),
    normalized(proposal.problem),
  ]);
const issueTitles = (proposal) =>
  new Set([normalized(proposal.title), ...proposal.steps.map((s) => normalized(s.title))]);
function validatePlan(proposals) {
  if (!Array.isArray(proposals) || proposals.length > 6) throw Error("Invalid weekly feature plan");
  const counts = { major: 0, minor: 0 };
  const titles = [];
  for (const proposal of proposals) {
    validateProposal(proposal);
    if (++counts[proposal.size] > LIMITS[proposal.size])
      throw Error("Weekly feature limit exceeded");
    titles.push(...issueTitles(proposal));
  }
  if (!unique(titles) || !unique(proposals.map(evidenceKey)))
    throw Error("Duplicate feature in weekly plan");
  return proposals;
}
function producerOK(value) {
  return (
    exact(value, "mode,head,runId") &&
    ["pilot", "live"].includes(value.mode) &&
    SHA.test(value.head || "") &&
    typeof value.runId === "string" &&
    RUN.test(value.runId)
  );
}
const emptyRegistry = () => ({ version: 1, records: {} });
const receiptStatusOK = (v, phases) =>
  exact(v, "phase,issue") &&
  phases.includes(v.phase) &&
  (v.phase === "intent" ? v.issue === null : positive(v.issue));

function validateRegistry(state) {
  if (
    !exact(state, "version,records") ||
    state.version !== 1 ||
    !record(state.records) ||
    Object.keys(state.records).length > 180
  )
    throw Error("Invalid weekly feature registry");
  const knownIssues = [];
  const plans = new Map();
  for (const [key, row] of Object.entries(state.records)) {
    if (
      !exact(row, "week,producer,proposal,parent,stages") ||
      !validWeek(row.week) ||
      !producerOK(row.producer) ||
      !Array.isArray(row.stages)
    )
      throw Error("Invalid feature record");
    validateProposal(row.proposal);
    const staged = row.proposal.size === "major";
    if (
      key !== proposalKey(row.proposal) ||
      row.stages.length !== row.proposal.steps.length ||
      (row.parent !== null && (!staged || !receiptStatusOK(row.parent, ["intent", "linked"]))) ||
      row.stages.some(
        (v, i) =>
          v !== null &&
          (!receiptStatusOK(v, ["intent", "created", "ready"]) ||
            (staged && row.parent?.phase !== "linked") ||
            (i > 0 && row.stages[i - 1]?.phase !== "ready"))
      )
    )
      throw Error("Invalid feature publication receipt");
    const plan = plans.get(row.week) || [];
    plan.push(row.proposal);
    plans.set(row.week, plan);
    knownIssues.push(...[row.parent, ...row.stages].filter((v) => v?.issue).map((v) => v.issue));
  }
  for (const plan of plans.values()) validatePlan(plan);
  if (!unique(knownIssues)) throw Error("Duplicate weekly feature issue receipt");
  return state;
}

const marker = (key, index) => "<!-- factory-feature:" + key + ":" + index + " -->";
const marked = (issue) => /<!--\s*factory-feature:/i.test(issue?.body || "");
function issueFields(key, row, index) {
  const { proposal, producer } = row;
  const step = proposal.steps[index];
  const e = proposal.evidence;
  const reference =
    e.kind === "source"
      ? "Repository observation at " + producer.head + " in " + e.path + "."
      : "Maintainer evidence in issue #" + e.number + ".";
  const heading = step?.title || proposal.title;
  const title = index < 0 ? heading : row.parent ? heading : proposal.title;
  const body = [
    index < 0 ? "Weekly feature tracking issue" : "Weekly feature implementation ticket",
    "",
    "## User problem",
    "",
    proposal.problem,
    "",
    "## Expected benefit",
    "",
    proposal.benefit,
    "",
    reference,
    "",
    ...(index < 0
      ? ["## Planned stages", "", ...proposal.steps.map((s) => "- " + s.title)]
      : [
          ...(row.parent ? ["Part of #" + row.parent.issue + ".", ""] : []),
          "## Scope",
          "",
          step.scope,
          "",
          "## Acceptance criteria",
          "",
          ...step.acceptance.map((a) => "- " + a),
        ]),
    "",
    marker(key, index),
  ].join("\n");
  return { title, body };
}
function receiptFor(key, row, index) {
  const fields = issueFields(key, row, index);
  return {
    key,
    index,
    issue: row.stages[index]?.issue,
    head: row.producer.head,
    runId: row.producer.runId,
    mode: row.producer.mode,
    criteriaHash: digest([fields.title, fields.body]),
  };
}
function validateReceipt(receipt) {
  if (
    !exact(receipt, "key,index,issue,head,runId,mode,criteriaHash") ||
    !["pilot", "live"].includes(receipt.mode) ||
    !HASH.test(receipt.key || "") ||
    !Number.isInteger(receipt.index) ||
    receipt.index < 0 ||
    receipt.index > 4 ||
    !positive(receipt.issue) ||
    !SHA.test(receipt.head || "") ||
    typeof receipt.runId !== "string" ||
    !RUN.test(receipt.runId) ||
    !HASH.test(receipt.criteriaHash || "")
  )
    throw Error("Invalid typed feature origin");
  return receipt;
}
function issueMatches(issue, key, row, index, ready = false, allowClosed = false) {
  const entry = index < 0 ? row.parent : row.stages[index];
  const fields = issueFields(key, row, index);
  return Boolean(
    positive(issue?.number) &&
      !issue.pull_request &&
      (issue.state === "open" || (allowClosed && issue.state === "closed")) &&
      Object.entries(BOT).every(([attr, v]) => issue.user?.[attr] === v) &&
      (!entry?.issue || entry.issue === issue.number) &&
      issue.title === fields.title &&
      issue.body === fields.body &&
      Boolean(issue.labels?.some((label) => label.name === READY)) === ready
  );
}

module.exports = {
  TIMEZONE,
  WORKFLOW,
  READY,
  LIMITS,
  RUN,
  BOT,
  digest,
  exact,
  evidenceKey,
  normalized,
  issueTitles,
  marker,
  marked,
  producerOK,
  validWeek,
  weekKey,
  validateProposal,
  validatePlan,
  proposalKey,
  emptyRegistry,
  validateRegistry,
  issueFields,
  receiptFor,
  validateReceipt,
  issueMatches,
};
