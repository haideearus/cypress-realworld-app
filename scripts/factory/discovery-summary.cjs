const { appendFileSync } = require("node:fs");
const { REPOSITORY } = require("./policy.cjs");
const functional = require("./discovery-functional.cjs");
const { failedIsolated } = require("./discovery-replay.cjs");

const repositoryUrl = `https://github.com/${REPOSITORY}`;
const charterNames = {
  "functional-feed": "Public feed pagination",
  "functional-directory": "Directory search",
  "functional-notifications": "Notifications list",
};
const notificationCases = {
  envelope: "response envelope",
  unread: "seeded unread items",
  items: "notification item display fields and types",
};
const heldReasons = {
  "baseline-failed": "The proposed test did not fail consistently in isolation",
  "unsupported-oracle": "The finding lacked a supported verifier",
  "nonreproducing-or-flaky": "The fixed verifier did not reproduce the failure consistently",
  "environment-or-startup": "The isolated verifier could not complete",
};
const findingStates = {
  verified: "Verified, publication pending",
  published: "Published",
  "held-stop": "Held by the factory controls",
  "held-quota": "Held by the publication quota",
  "publishing-intent": "Publication awaiting confirmation",
  "observed-resolved": "Failure absent on current main",
  "held-evidence": "Held because evidence is unavailable",
  "repair-merged": "Repair merged",
};

function writeSummary(env, lines) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines}\n`);
}

function issueLink(issue) {
  return Number.isSafeInteger(issue) && issue > 0
    ? `[#${issue}](${repositoryUrl}/issues/${issue})`
    : null;
}

function runLink(runId) {
  return /^[1-9]\d{0,15}$/.test(String(runId ?? ""))
    ? `[Source discovery run](${repositoryUrl}/actions/runs/${runId})`
    : null;
}

function statusText(value) {
  return typeof value === "string" && /^[a-z][a-z_-]{0,65}$/.test(value)
    ? value.replaceAll(/[_-]/g, " ")
    : "unavailable";
}

function scenarioLabel({ kind, query }) {
  // Directory inputs originate with the model and may include arbitrary alphanumeric strings.
  if (kind === "feed-pagination" && Number.isInteger(query?.page) && Number.isInteger(query?.limit))
    return `Public feed pagination (page ${query.page}, limit ${query.limit})`;
  if (kind === "unexpected-server-error" && typeof query?.q === "string")
    return `Directory search (${query.q.length}-character synthetic phrase)`;
  if (kind === "notification-list" && Object.hasOwn(notificationCases, query?.check))
    return `Notifications list (${notificationCases[query.check]})`;
  return "Functional API contract";
}

function explorationSummary({ charter, bundle, assessment }) {
  const selected = functional.assertCharter(charter);
  const alternates = functional.CHARTERS.filter((value) => value !== selected);
  const distinct = new Set();
  const checks = bundle.batches.map((batch, index) => {
    const oracle = functional.verifyProposal(selected, batch.test);
    const result = batch.result;
    const passed = result.code === 0 && result.networkIsolated === true;
    const failed =
      result.code === 1 &&
      failedIsolated(result) &&
      /^not ok 1 - approved functional scenario\r?$/m.test(result.log) &&
      (selected !== "functional-notifications" ||
        result.log.split(/\r?\n/).includes(`# ${functional.NOTIFICATION_RESPONSE}`));
    if (passed || failed) distinct.add(JSON.stringify(oracle));
    const status = passed
      ? "passed"
      : failed
        ? "exited unsuccessfully"
        : result.code === 124
          ? "timed out"
          : "incomplete runner result";
    return `- Recorded batch ${index + 1} — ${scenarioLabel(oracle)} — ${status}`;
  });
  const findings = assessment.findings.map(({ finding, status, reason }) => {
    const { oracle } = functional.describeFinding(selected, finding);
    const disposition =
      status === "verified"
        ? "Verified by two isolated replays"
        : `Held. ${Object.hasOwn(heldReasons, reason) ? heldReasons[reason] : "Verification was incomplete"}`;
    return `- ${scenarioLabel(oracle)} — ${disposition}`;
  });
  const unused = 4 - checks.length;
  return [
    "## Proactive app discovery",
    "",
    `Charter — ${charterNames[selected]}`,
    "The fixed API scenarios use a disposable app and one synthetic account.",
    "",
    "### Tested scenarios",
    "",
    `${distinct.size} distinct case${distinct.size === 1 ? "" : "s"} completed. ${distinct.size >= 3 ? "Coverage target met." : "Partial coverage; target is three distinct cases."}`,
    "",
    ...(checks.length ? checks : ["No completed API batches were retained."]),
    "",
    "### Skipped coverage",
    "",
    ...alternates.map(
      (alternate) => `- ${charterNames[alternate]} was outside this run's charter.`
    ),
    "- Further inputs, browser journeys, account-changing operations, external services and production were outside this sweep.",
    `- ${unused} unused or unrecorded API batch slots out of 4.`,
    "",
    "### Findings",
    "",
    ...(findings.length ? findings : ["No findings were submitted for replay."]),
    "",
    `Ticket publication and current-main replay run in [Verified discovery finding intake](${repositoryUrl}/actions/workflows/factory-discovery-intake.yml).`,
  ].join("\n");
}

function sweepSummary(values) {
  const source = issueLink(values.ticket);
  return [
    "## Discovery sweep status",
    "",
    `- Outcome — ${statusText(values.outcome)}`,
    ...(Object.hasOwn(charterNames, values.charter)
      ? [`- Charter — ${charterNames[values.charter]}`]
      : []),
    ...(source ? [`- Sweep audit issue — ${source}`] : []),
    ...(values.reason ? [`- ${values.reason}`] : []),
    ...(["held", "preview", "blocked", "disabled"].includes(values.outcome)
      ? ["", "No completed scenario coverage was established by this step."]
      : []),
  ].join("\n");
}

function intakeSummary(outcome, { sourceRun, findings, replayed, heldSources } = {}) {
  const source = runLink(sourceRun);
  return [
    "## Verified discovery finding intake",
    "",
    `- Outcome — ${statusText(outcome)}`,
    ...(source ? [`- Coverage and skipped scenarios — ${source}`] : []),
    ...(Number.isSafeInteger(heldSources) && heldSources > 0
      ? [`- Evidence was unavailable for ${heldSources} discovery source(s).`]
      : []),
    ...(replayed
      ? [
          "",
          "### Current-main replay",
          "",
          `- ${scenarioLabel(replayed.oracle)}`,
          "",
          "### Skipped coverage",
          "",
          "- Other source scenarios were outside this recheck.",
        ]
      : []),
    ...(findings
      ? [
          "",
          "### Findings and tickets",
          "",
          ...(findings.length
            ? findings.map(({ row, candidate = row.candidate, duplicate = false }) => {
                const ticket = issueLink(row.publication?.issue);
                const ready = outcome === "ready" && row.intake?.outcome === "ready";
                const state = ready
                  ? "Ready for coding"
                  : row.intake?.outcome === "held" && outcome === "held"
                    ? "Held after current-main replay"
                    : (Object.hasOwn(findingStates, row.status) && findingStates[row.status]) ||
                      "Publication pending";
                return [
                  `- ${scenarioLabel(candidate.oracle)}`,
                  duplicate ? "Duplicate" : null,
                  state,
                  ticket || "No ticket",
                ]
                  .filter(Boolean)
                  .join(" — ");
              })
            : ["No verified findings were eligible for publication."]),
        ]
      : []),
  ].join("\n");
}

module.exports = {
  writeSummary,
  issueLink,
  statusText,
  explorationSummary,
  sweepSummary,
  intakeSummary,
};
