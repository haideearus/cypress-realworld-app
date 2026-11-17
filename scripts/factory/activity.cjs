const c = require("./activity-contract.cjs");
const { ROOT, Ledger } = require("./github.cjs");
const { ActivityStore } = require("./activity-store.cjs");
const { REPOSITORY, OWNER, BOT, BOT_ID } = require("./wake-contract.cjs");
async function verifyActivityProducer(
  api,
  event,
  vars = JSON.parse(process.env.FACTORY_VARIABLES || "{}")
) {
  c.validateEvent(event);
  const p = event.producer;
  const { verifiedRun } = require("./wake-controller.cjs");
  const r = await verifiedRun(api, p.runId, p.runAttempt, p.workflow, {
    terminal: false,
    success: false,
  });
  if (r.head_sha !== p.workflowSha || r.actor?.login !== p.actor)
    throw Error("Activity producer identity changed");
  const owner = r.actor?.login === OWNER && r.actor.id === 101267861;
  const bot = r.actor?.login === BOT && r.actor.id === BOT_ID;
  const dependabot = r.actor?.login === "dependabot[bot]" && r.actor.id === 49699333;
  const app =
    typeof vars.FACTORY_GITHUB_APP_SLUG === "string" &&
    r.actor?.login === `${vars.FACTORY_GITHUB_APP_SLUG}[bot]` &&
    r.actor.type === "Bot";
  if (!owner && !bot && !dependabot && !app) throw Error("Activity actor is not trusted");
  if (
    p.workflow === "factory-activity.yml" &&
    !(
      (event.kind === "issue" && r.event === "issues" && owner) ||
      (event.kind === "stop" && ["issues", "workflow_run"].includes(r.event)) ||
      (["monitor-stale", "monitor-recovered"].includes(event.kind) &&
        p.phase === "freshness" &&
        ["issues", "workflow_run"].includes(r.event))
    )
  )
    throw Error("Activity observer cannot notify about itself");
  if (event.kind === "stop")
    await require("./activity-controls.cjs").verifyControlEvent(api, event);
  if (p.workflow !== "factory-ci.yml" && r.head_branch !== "main")
    throw Error("Activity requires trusted main source");
  if (bot && ["factory-automatic.yml", "factory-dependencies.yml"].includes(p.workflow)) {
    try {
      await require("./trusted-wake.cjs").loadWakeContext(
        api,
        {
          repository: REPOSITORY,
          actor: BOT,
          triggeringActor: BOT,
          ref: "refs/heads/main",
          event: r.event,
          workflowRef: `${REPOSITORY}/.github/workflows/${p.workflow}@refs/heads/main`,
          workflowSha: r.head_sha,
          runId: String(r.id),
          runAttempt: r.run_attempt,
        },
        {}
      );
    } catch (e) {
      if (
        !(e instanceof require("./trusted-wake.cjs").PendingWakeBinding) ||
        r.status !== "completed" ||
        event.kind !== "queue" ||
        event.state !== "held" ||
        p.phase !== "binding-held" ||
        event.summary !==
          "Receiver finished without a verified wake binding; no model or review outcome is asserted."
      )
        throw e;
    }
  }
  return r;
}
async function journal(api, number) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw Error("Approved activity journal number required");
  const issue = await api.request("GET", `${ROOT}/issues/${number}`);
  if (
    issue.number !== number ||
    issue.state !== "open" ||
    issue.pull_request ||
    issue.user?.login !== OWNER ||
    issue.user.id !== 101267861 ||
    !Array.isArray(issue.labels) ||
    issue.labels.length
  )
    throw Error("Activity journal must be an open unlabelled owner issue");
  if ((await new Ledger(api).read()).state.tickets[String(number)])
    throw Error("Activity journal cannot be an admitted maintenance ticket");
  return issue;
}
async function enqueueActivity({ api, event, store = new ActivityStore(api) }) {
  c.validateEvent(event);
  await verifyActivityProducer(api, event);
  return store.update((state) => {
    c.validateActivity(state);
    if (!state.events[event.id]) {
      if (Object.keys(state.events).length >= c.MAX_EVENTS)
        throw Error("Activity registry full; owner archival required");
      state.events[event.id] = { event, status: "queued", commentId: null };
    }
    return { state };
  });
}
async function findComment(api, number, event) {
  const marker = `<!-- factory-activity:${event.id} -->`;
  for (let page = 1; page <= 10; page++) {
    const rows = await api.request(
      "GET",
      `${ROOT}/issues/${number}/comments?per_page=100&page=${page}`
    );
    if (!Array.isArray(rows) || rows.length > 100) throw Error("Invalid journal lookup");
    const found = rows.filter(
      (r) => r.body?.startsWith(marker) && r.user?.login === BOT && r.user.id === BOT_ID
    );
    if (found.length > 1) throw Error("Duplicate journal receipt requires owner inspection");
    if (found.length === 1) return found[0];
    if (rows.length < 100) return null;
  }
  throw Error("Journal lookup bound reached; publication held");
}
async function publishActivity({
  api,
  event,
  journalIssue,
  store = new ActivityStore(api),
  scan = (body) => require("./secret-scan.cjs").scanText(body),
}) {
  const body = c.renderEvent(event);
  const scanned = await scan(body);
  if (scanned?.clean !== true) throw Error("Activity body scan failed closed");
  await verifyActivityProducer(api, event);
  await journal(api, journalIssue);
  let { state } = await store.read();
  c.validateActivity(state);
  const old = state.events[event.id];
  if (old?.status === "published") return { outcome: "duplicate", commentId: old.commentId };
  if (old?.status === "intent") {
    const found = await findComment(api, journalIssue, event);
    if (!found) return { outcome: "uncertain" };
    await store.update((s) => {
      s.events[event.id].status = "published";
      s.events[event.id].commentId = found.id;
      return { state: s };
    });
    return { outcome: "reconciled", commentId: found.id };
  }
  const claim = await store.update((s) => {
    c.validateActivity(s);
    const old = s.events[event.id];
    if (old && old.status !== "queued") return { state: s, mine: false };
    if (!old && Object.keys(s.events).length >= c.MAX_EVENTS)
      throw Error("Activity registry full; owner maintenance required");
    s.events[event.id] = { event, status: "intent", commentId: null };
    return { state: s, mine: true };
  });
  if (!claim.mine) return { outcome: "duplicate" };
  let comment;
  try {
    comment = await api.request("POST", `${ROOT}/issues/${journalIssue}/comments`, { body });
  } catch {
    return { outcome: "uncertain" };
  }
  if (!Number.isSafeInteger(comment?.id) || comment.id < 1) return { outcome: "uncertain" };
  await store.update((s) => {
    s.events[event.id].status = "published";
    s.events[event.id].commentId = comment.id;
    return { state: s };
  });
  return { outcome: "published", commentId: comment.id };
}
function monitorFreshness(state, now, completion) {
  if (
    completion &&
    (!state.lastMonitor || Date.parse(completion.at) > Date.parse(state.lastMonitor.at))
  ) {
    const recovered = state.staleFor !== null;
    state.lastMonitor = completion;
    state.staleFor = null;
    if (now.getTime() - Date.parse(completion.at) >= 90 * 60 * 1000) {
      state.staleFor = completion.runId;
      return "monitor-stale";
    }
    return recovered ? "monitor-recovered" : null;
  }
  if (
    state.lastMonitor &&
    now.getTime() - Date.parse(state.lastMonitor.at) >= 90 * 60 * 1000 &&
    state.staleFor !== state.lastMonitor.runId
  ) {
    state.staleFor = state.lastMonitor.runId;
    return "monitor-stale";
  }
  return null;
}
async function recordResult(api, context, result, env = process.env) {
  const vars = JSON.parse(env.FACTORY_VARIABLES || "{}");
  if (vars.FACTORY_ACTIVITY_LOG_ENABLED !== "true") return;
  // Notification errors never alter a reservation, approval, outcome or model count.
  try {
    const workflow = context.workflowRef?.split("/").at(-1)?.split("@")[0];
    const op = env.FACTORY_OPERATION;
    const allowed = [
      "auto_pick",
      "auto_merge",
      "dep_select",
      "dep_analysis",
      "dep_accept",
      "dep_ci",
      "dep_reserve",
      "dep_assess",
      "dep_premerge",
      "dep_merge",
      "dep_finalize",
      "admit",
      "admit_pr",
      "publish",
      "ci",
      "review",
      "assess",
      "assess_pr",
      "cancel",
    ];
    if (!allowed.includes(op) || !c.WORKFLOWS.includes(workflow)) return;
    const subject = Number(result.ticket || JSON.parse(env.FACTORY_INPUTS || "{}").ticket || 1);
    const kind = /limit|budget|allowance/i.test(result.reason || "")
      ? "budget"
      : /merge/.test(op)
        ? "merge"
        : /assess|review|reserve/.test(op)
          ? "review"
          : /ci/.test(op)
            ? "ci"
            : /pick|select/.test(op)
              ? "queue"
              : "coding";
    const status =
      result.reviewed === true
        ? "passed"
        : result.passed === false
          ? "failure"
          : /No eligible|empty queue/i.test(result.reason || "")
            ? "idle"
            : result.ready === false
              ? "held"
              : "completed";
    let summary = JSON.stringify(
      Object.fromEntries(
        Object.entries(result).filter(
          ([k, v]) =>
            [
              "ready",
              "reviewed",
              "passed",
              "retry",
              "ticket",
              "pr",
              "head",
              "mode",
              "kind",
              "reason",
            ].includes(k) && ["string", "boolean", "number"].includes(typeof v)
        )
      )
    );
    if (Array.isArray(result.holds))
      summary = JSON.stringify({
        result: JSON.parse(summary),
        holds: result.holds.slice(0, 5).map((h) => ({ pr: h.pr, code: h.code })),
      });
    const event = c.buildActivityEvent({
      producer: {
        runId: context.runId,
        runAttempt: context.runAttempt,
        workflow,
        workflowSha: context.workflowSha,
        phase: op,
        actor: context.actor,
      },
      kind,
      state: status,
      subject,
      head: result.head && /^[a-f0-9]{40}$/.test(result.head) ? result.head : context.workflowSha,
      summary: summary || "Trusted operation completed",
      links: [
        `https://github.com/${REPOSITORY}/actions/runs/${context.runId}`,
        ...(Array.isArray(result.holds)
          ? result.holds.slice(0, 4).map((h) => `https://github.com/${REPOSITORY}/pull/${h.pr}`)
          : []),
      ],
    });
    await enqueueActivity({ api, event });
  } catch {
    if (env.GITHUB_STEP_SUMMARY)
      require("node:fs").appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        "\nActivity notification enqueue failed; inspect the activity workflow. The work result and usage history are unchanged.\n"
      );
  }
}
async function recordMonitorResult(api, context, result, env = process.env) {
  const vars = JSON.parse(env.FACTORY_VARIABLES || "{}");
  if (vars.FACTORY_ACTIVITY_LOG_ENABLED !== "true" || !result.observation) return;
  try {
    const observation = require("./monitor.cjs").validateObservation(result.observation);
    const event = c.buildActivityEvent({
      producer: {
        runId: context.runId,
        runAttempt: context.runAttempt,
        workflow: "factory-monitor.yml",
        workflowSha: context.workflowSha,
        phase: "monitor-result",
        actor: context.actor,
      },
      kind: "monitor",
      state: observation.healthy ? "healthy" : "unhealthy",
      subject: result.issue || Number(context.runId),
      head: observation.release || context.workflowSha,
      summary: JSON.stringify({ outcome: result.outcome, observation }),
      links: [`https://github.com/${REPOSITORY}/actions/runs/${context.runId}`],
    });
    await enqueueActivity({ api, event });
    if (result.issue)
      await enqueueActivity({
        api,
        event: c.buildActivityEvent({
          producer: { ...event.producer, phase: "monitor-incident" },
          kind: "issue",
          state: result.outcome === "incident_created" ? "queued" : "held",
          subject: result.issue,
          head: event.head,
          summary: `Receipt-backed monitor incident ${result.issue}: ${result.outcome}.`,
          links: [`https://github.com/${REPOSITORY}/issues/${result.issue}`],
        }),
      });
  } catch {
    if (env.GITHUB_STEP_SUMMARY)
      require("node:fs").appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        "\nMonitor activity enqueue failed; observe the activity workflow. Probe and incident results are unchanged.\n"
      );
  }
}
module.exports = {
  ...c,
  verifyActivityProducer,
  journal,
  enqueueActivity,
  publishActivity,
  findComment,
  monitorFreshness,
  recordResult,
  recordMonitorResult,
};
