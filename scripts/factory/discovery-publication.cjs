const f = require("./discovery-finding-contract.cjs");
const p = require("./policy.cjs");
const { ROOT } = require("./github.cjs");
const c = require("./discovery-contract.cjs");
function stageFinding(
  s,
  candidate,
  { allowRecurrence = false, recurrenceOf, eligible = () => true } = {}
) {
  f.validateCandidate(candidate);
  if (!eligible(candidate)) throw Error("Finding outside publication scope");
  if (s.records[candidate.key])
    return { status: s.records[candidate.key].status, record: candidate.key };
  const used = s.sources[candidate.source.grantId] || [];
  if (used.includes(candidate.key)) {
    const previous = Object.entries(s.records).find(
      ([, r]) => eligible(r.candidate) && r.duplicates.some((d) => d.key === candidate.key)
    );
    return { status: "duplicate", record: previous?.[0] };
  }
  if (used.length >= 2) throw Error("Discovery source finding limit reached");
  const matches = Object.values(s.records)
    .filter((r) => r.candidate.fingerprint === candidate.fingerprint)
    .sort((a, b) => b.generation - a.generation);
  const previous = matches.find((r) => eligible(r.candidate));
  if (allowRecurrence && recurrenceOf !== undefined && previous?.candidate.key !== recurrenceOf)
    throw Error("Finding recurrence state changed; retry verification");
  s.sources[candidate.source.grantId] = [...used, candidate.key];
  if (
    previous &&
    (!allowRecurrence || !["observed-resolved", "repair-merged"].includes(previous.status))
  ) {
    if (previous.duplicates.length >= 30)
      throw Error("Finding duplicate history full; owner maintenance required");
    previous.duplicates.push({ ...structuredClone(candidate), comment: null });
    return { status: "duplicate", record: previous.candidate.key };
  }
  if (Object.keys(s.records).length >= 400)
    throw Error("Finding registry full; owner maintenance required");
  s.records[candidate.key] = {
    candidate: structuredClone(candidate),
    generation: (matches[0]?.generation || 0) + 1,
    status: "verified",
    publication: null,
    duplicates: [],
    intake: null,
    resolution: null,
    resolutionClosed: false,
    resolutionHeld: false,
  };
  return { status: "verified", record: candidate.key };
}
function claimPublication(s, key, day, context, config, stopped) {
  if (!f.contextOK(context)) throw Error("Unauthorized finding publisher");
  const r = s.records[key];
  if (!r) throw Error("Finding missing");
  if (r.publication) return r;
  if (!["verified", "held-stop", "held-quota"].includes(r.status)) return r;
  if (stopped || !config.enabled || !config.automatic || !config.discovery) {
    r.status = "held-stop";
    return r;
  }
  if ((s.days[day] || []).length >= 4) {
    r.status = "held-quota";
    return r;
  }
  const text = f.issueText(r);
  r.publication = {
    day,
    context: structuredClone(context),
    confirmation: null,
    issue: null,
    writeStarted: false,
    ...text,
  };
  r.status = "publishing-intent";
  s.days[day] = [...(s.days[day] || []), key];
  return r;
}
function issueMatches(issue, r) {
  return !!(
    issue &&
    !issue.pull_request &&
    issue.user?.login === "github-actions[bot]" &&
    issue.user.id === 41898282 &&
    issue.user.type === "Bot" &&
    Number.isSafeInteger(issue.number) &&
    issue.number > 0 &&
    issue.title === r.publication.title &&
    (issue.body || "") === r.publication.body
  );
}
async function issues(api) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const rows = await api.request(
      "GET",
      `${ROOT}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`
    );
    if (!Array.isArray(rows) || rows.length > 100)
      throw Error("Invalid bounded finding issue lookup");
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw Error("Finding issue lookup bound reached; retaining intent");
}
async function publishFinding({
  api,
  store,
  ledger,
  config,
  context,
  key,
  verifySource,
  scan = require("./secret-scan.cjs").scanFiles,
  now = new Date(),
}) {
  if (!f.contextOK(context)) throw Error("Unauthorized finding publisher");
  const before = (await store.read()).state.records[key];
  if (!before) throw Error("Finding missing");
  if (!(await verifySource(before.candidate))) throw Error("Finding source no longer verified");
  if (before.status === "published") {
    const existing = await api.request("GET", `${ROOT}/issues/${before.publication.issue}`);
    if (!issueMatches(existing, before)) throw Error("Published finding issue criteria changed");
    const previous = before.publication.confirmation;
    const run =
      previous && (await api.request("GET", `${ROOT}/actions/runs/${previous.runId}/attempts/1`));
    const successful =
      run?.status === "completed" &&
      (await require("./discovery-origin.cjs").successfulJob(
        api,
        previous.runId,
        "publish",
        "Publish verified findings without a model"
      ));
    if (!previous || (run.status === "completed" && !successful))
      await store.update((s) => {
        s.records[key].publication.confirmation = structuredClone(context);
        return { state: s };
      });
    return { status: before.status, issue: before.publication.issue, key };
  }
  const day = p.dayKey(now, config.timezone);
  const stopped = Boolean((await ledger.read()).state.stop);
  const claimed = await store.update((s) => {
    const old = s.records[key].publication;
    const row = claimPublication(s, key, day, context, config, stopped);
    const created = !old && !!row.publication;
    return { state: s, record: structuredClone(row), created };
  });
  const r = claimed.record;
  if (!r.publication) return { status: r.status, key };
  let issue;
  if (r.publication.writeStarted) {
    const rows = await issues(api);
    if (rows.length > 500) throw Error("Finding issue lookup bound reached; retaining intent");
    const found = rows.filter((i) => issueMatches(i, r));
    if (found.length !== 1) throw Error("Finding publication response uncertain; retaining intent");
    issue = found[0];
  } else {
    const existing = (await issues(api)).filter((i) => issueMatches(i, r));
    if (existing.length)
      throw Error("Unexpected existing finding issue; owner reconciliation required");
    await scan([
      { path: "finding-ticket.txt", content: r.publication.title + "\n" + r.publication.body },
    ]);
    if ((await ledger.read()).state.stop || !(await verifySource(r.candidate))) {
      await store.update((s) => {
        s.records[key].status = "held-stop";
        return { state: s };
      });
      return { status: "held-stop", key };
    }
    const write = await store.update((s) => {
      const current = s.records[key].publication;
      if (current.writeStarted) return { state: s, write: false };
      current.writeStarted = true;
      current.context = structuredClone(context);
      return { state: s, write: true };
    });
    if (!write.write) throw Error("Publication already started; reconcile the retained intent");
    issue = await api.request("POST", `${ROOT}/issues`, {
      title: r.publication.title,
      body: r.publication.body,
      labels: ["factory-ready"],
    });
    if (!issueMatches(issue, r))
      throw Error("Finding publication response uncertain; retaining intent");
  }
  await store.update((s) => {
    const x = s.records[key];
    if (
      x.publication.criteriaHash !== r.publication.criteriaHash ||
      (x.publication.issue !== null && x.publication.issue !== issue.number)
    )
      throw Error("Finding publication receipt changed");
    x.publication.issue = issue.number;
    x.publication.confirmation = structuredClone(context);
    // Keep the identity of the request's producer; reconciliation is not its author.
    x.status = "published";
    return { state: s };
  });
  return { status: "published", issue: issue.number, key };
}
async function commentOnce({ api, store, key, select, body, context, ledger, config }) {
  if (!f.contextOK(context)) throw Error("Unauthorized finding comment producer");
  let record = (await store.read()).state.records[key];
  if (!record?.publication?.issue) return;
  let target = select(record);
  if (target.comment?.id) return;
  if (!target.comment) {
    if (
      (await ledger.read()).state.stop ||
      !config.enabled ||
      !config.discovery ||
      !config.automatic
    )
      return;
    await require("./secret-scan.cjs").scanFiles([{ path: "finding-comment.txt", content: body }]);
    await store.update((s) => {
      const x = select(s.records[key]);
      if (!x.comment)
        x.comment = { body, context: structuredClone(context), writeStarted: false, id: null };
      return { state: s };
    });
  }
  record = (await store.read()).state.records[key];
  target = select(record);
  const comments = [];
  for (let page = 1; page <= 5; page++) {
    const rows = await api.request(
      "GET",
      `${ROOT}/issues/${record.publication.issue}/comments?per_page=100&page=${page}`
    );
    if (!Array.isArray(rows) || rows.length > 100) throw Error("Invalid finding comment lookup");
    comments.push(...rows);
    if (rows.length < 100) break;
    if (page === 5) throw Error("Finding comment lookup bound reached");
  }
  const matches = comments.filter(
    (x) =>
      x.body === target.comment.body &&
      x.user?.id === 41898282 &&
      x.user.login === "github-actions[bot]"
  );
  let comment = matches.length === 1 ? matches[0] : null;
  if (matches.length > 1 || (!comment && target.comment.writeStarted))
    throw Error("Finding comment response uncertain; retained intent");
  if (!comment) {
    if (
      (await ledger.read()).state.stop ||
      !config.enabled ||
      !config.discovery ||
      !config.automatic
    )
      return;
    const claimed = await store.update((s) => {
      const x = select(s.records[key]).comment;
      if (x.writeStarted) return { state: s, write: false };
      x.writeStarted = true;
      x.context = structuredClone(context);
      return { state: s, write: true };
    });
    if (!claimed.write) throw Error("Finding comment already started");
    comment = await api.request("POST", `${ROOT}/issues/${record.publication.issue}/comments`, {
      body: target.comment.body,
    });
    if (
      comment.body !== target.comment.body ||
      comment.user?.id !== 41898282 ||
      !Number.isSafeInteger(comment.id)
    )
      throw Error("Finding comment response uncertain");
  }
  await store.update((s) => {
    select(s.records[key]).comment.id = comment.id;
    return { state: s };
  });
}
async function appendDuplicates(options) {
  const row = (await options.store.read()).state.records[options.key];
  for (const duplicate of row.duplicates)
    await commentOnce({
      ...options,
      select: (r) => r.duplicates.find((d) => d.key === duplicate.key),
      body: `Additional sandbox evidence for this existing finding. Original issue criteria remain unchanged.\nSource ${duplicate.source.head}; test ${duplicate.testHash}; evidence https://github.com/${c.REPOSITORY}/actions/runs/${duplicate.source.runId}.\n<!-- discovery-duplicate:${duplicate.key} -->`,
    });
}
async function noteResolution(options) {
  const row = (await options.store.read()).state.records[options.key];
  if (!["observed-resolved", "repair-merged"].includes(row.status)) return;
  await commentOnce({
    ...options,
    select: (r) => r,
    body:
      row.status === "repair-merged"
        ? `Protected repair PR #${row.resolution.pr} merged as ${row.resolution.mergeCommit}. The production closure workflow verifies the deployed repair before completing the issue.\n<!-- discovery-repair-merged:${row.candidate.key} -->`
        : `Observed resolved on tested main ${row.intake.head}: the original reproducer passed and two isolated oracle checks no longer found the violation. No factory-authored repair or production verification is claimed.\nReceipt ${row.intake.id}; evidence https://github.com/${c.REPOSITORY}/actions/runs/${row.intake.context.runId}.\n<!-- discovery-observed-resolved:${row.candidate.key} -->`,
  });
  const saved = (await options.store.read()).state.records[options.key];
  if (!saved.comment?.id || (await options.ledger.read()).state.stop) return;
  const issue = await options.api.request("GET", `${ROOT}/issues/${saved.publication.issue}`);
  if (issue.number !== saved.publication.issue || !issueMatches(issue, saved))
    throw Error("Resolved finding issue criteria changed");
  if (saved.status === "repair-merged") {
    // The production closure workflow owns the write. Reconcile the receipt only.
    if (issue.state !== "closed" || issue.state_reason !== "completed") return;
  } else {
    if (issue.state === "open")
      await options.api.request("PATCH", `${ROOT}/issues/${issue.number}`, {
        state: "closed",
        state_reason: "completed",
      });
    const confirmed = await options.api.request("GET", `${ROOT}/issues/${issue.number}`);
    if (confirmed.state !== "closed" || !issueMatches(confirmed, saved))
      throw Error("Finding closure response uncertain");
  }
  await options.store.update((s) => {
    s.records[options.key].resolutionClosed = true;
    s.records[options.key].resolutionHeld = false;
    return { state: s };
  });
}
async function recordMergedRepairs({ api, store, ledger, context, eligible = () => true }) {
  if (!f.contextOK(context)) throw Error("Untrusted merge reconciliation");
  const state = (await ledger.read()).state;
  if (state.stop) return;
  const rows = Object.values((await store.read()).state.records).filter(
    (r) => r.status === "published" && eligible(r.candidate)
  );
  for (const row of rows) {
    const t = state.tickets[String(row.publication.issue)];
    if (
      t?.merge?.status !== "merged" ||
      t.finding?.origin.key !== row.candidate.key ||
      t.finding.origin.candidateHash !== c.digest(row.candidate) ||
      t.criteriaHash !== row.publication.criteriaHash ||
      !t.approval ||
      t.approval.head !== t.head ||
      !t.ci?.passed
    )
      continue;
    const pr = await api.request("GET", `${ROOT}/pulls/${t.pr}`);
    if (
      pr.merged !== true ||
      pr.state !== "closed" ||
      pr.number !== t.pr ||
      pr.head?.sha !== t.head ||
      pr.merge_commit_sha !== t.merge.mergeCommit ||
      !c.SHA.test(pr.merge_commit_sha) ||
      pr.base?.ref !== "main" ||
      pr.base.repo?.full_name !== c.REPOSITORY ||
      pr.head.repo?.full_name !== c.REPOSITORY
    )
      continue;
    await store.update((s) => {
      const r = s.records[row.candidate.key];
      if (r.status === "published") {
        r.status = "repair-merged";
        r.resolution = {
          kind: "protected-merge",
          pr: t.pr,
          head: t.head,
          mergeCommit: pr.merge_commit_sha,
          context: structuredClone(context),
        };
      }
      return { state: s };
    });
  }
}
async function recurrenceAllowed(api, previous, candidate) {
  if (!previous || !["observed-resolved", "repair-merged"].includes(previous.status)) return false;
  const base =
    previous.status === "repair-merged" ? previous.resolution?.mergeCommit : previous.intake?.head;
  if (!c.SHA.test(base || "")) return false;
  const comparison = await api.request("GET", `${ROOT}/compare/${base}...${candidate.source.head}`);
  return (
    ["ahead", "identical"].includes(comparison.status) && comparison.merge_base_commit?.sha === base
  );
}
async function reconcileResolutions(options, { key, eligible = () => true } = {}) {
  const rows = Object.values((await options.store.read()).state.records).filter(
    (r) =>
      ["observed-resolved", "repair-merged"].includes(r.status) &&
      eligible(r.candidate) &&
      !r.resolutionClosed &&
      (key ? r.candidate.key === key : !r.resolutionHeld)
  );
  const awaitingDeployment = (row) => row.status === "repair-merged" && Boolean(row.comment?.id);
  const selected = key ? rows : rows.filter((row) => !awaitingDeployment(row));
  if (!key && selected.length < 4 && rows.some(awaitingDeployment)) {
    // Prefer unsent notes and no-code resolutions. Open deployment holds cannot
    // fill the batch, and recent completed issues can be reconciled in one read.
    let recent;
    try {
      recent = await options.api.request(
        "GET",
        `${ROOT}/issues?state=closed&labels=factory-ready&sort=updated&direction=desc&per_page=100`
      );
    } catch {
      // A temporary lookup failure leaves these receipts for a later run.
    }
    if (Array.isArray(recent) && recent.length <= 100) {
      const completed = new Set(
        recent
          .filter((issue) => issue?.state === "closed" && issue.state_reason === "completed")
          .map((issue) => issue.number)
      );
      selected.push(
        ...rows.filter((row) => awaitingDeployment(row) && completed.has(row.publication.issue))
      );
    }
  }
  for (const row of selected.slice(0, 4)) {
    try {
      if (row.status === "observed-resolved") {
        const origin = require("./discovery-origin.cjs");
        await origin.producer(options.api, row.intake.context);
        if (
          !(await origin.successfulJob(
            options.api,
            row.intake.context.runId,
            "replay",
            "Replay current main without credentials"
          ))
        )
          throw Error("Unverified resolution replay");
      }
      await noteResolution({ ...options, key: row.candidate.key });
    } catch {
      await options.store.update((s) => {
        s.records[row.candidate.key].resolutionHeld = true;
        return { state: s };
      });
    }
  }
}
module.exports = {
  fingerprintFinding: f.fingerprintFinding,
  stageFinding,
  claimPublication,
  issueMatches,
  publishFinding,
  appendDuplicates,
  noteResolution,
  recordMergedRepairs,
  recurrenceAllowed,
  reconcileResolutions,
};
