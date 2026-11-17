const f = require("./discovery-finding-contract.cjs");
const p = require("./policy.cjs");
const { ROOT } = require("./github.cjs");
const c = require("./discovery-contract.cjs");
function stageFinding(s, candidate) {
  f.validateCandidate(candidate);
  if (s.records[candidate.key])
    return { status: s.records[candidate.key].status, record: candidate.key };
  const used = s.sources[candidate.source.grantId] || [];
  if (used.includes(candidate.key)) {
    const previous = Object.entries(s.records).find(([, r]) =>
      r.duplicates.some((d) => d.key === candidate.key)
    );
    return { status: "duplicate", record: previous?.[0] };
  }
  if (used.length >= 2) throw Error("Discovery source finding limit reached");
  const previous = Object.values(s.records)
    .filter((r) => r.candidate.fingerprint === candidate.fingerprint)
    .sort((a, b) => b.generation - a.generation)[0];
  s.sources[candidate.source.grantId] = [...used, candidate.key];
  if (previous && previous.status !== "observed-resolved") {
    if (previous.duplicates.length >= 30)
      throw Error("Finding duplicate history full; owner maintenance required");
    previous.duplicates.push({ ...structuredClone(candidate), comment: null });
    return { status: "duplicate", record: previous.candidate.key };
  }
  if (Object.keys(s.records).length >= 400)
    throw Error("Finding registry full; owner maintenance required");
  s.records[candidate.key] = {
    candidate: structuredClone(candidate),
    generation: (previous?.generation || 0) + 1,
    status: "verified",
    publication: null,
    duplicates: [],
    intake: null,
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
  if (row.status !== "observed-resolved") return;
  await commentOnce({
    ...options,
    select: (r) => r,
    body: `Observed resolved on tested main ${row.intake.head}: the original reproducer passed and two isolated oracle checks no longer found the violation. No factory-authored repair or production verification is claimed.\nReceipt ${row.intake.id}; evidence https://github.com/${c.REPOSITORY}/actions/runs/${row.intake.context.runId}.\n<!-- discovery-observed-resolved:${row.candidate.key} -->`,
  });
  const saved = (await options.store.read()).state.records[options.key];
  if (!saved.comment?.id || (await options.ledger.read()).state.stop) return;
  const issue = await options.api.request("GET", `${ROOT}/issues/${saved.publication.issue}`);
  if (!issueMatches(issue, saved)) throw Error("Resolved finding issue criteria changed");
  if (issue.state === "open")
    await options.api.request("PATCH", `${ROOT}/issues/${issue.number}`, {
      state: "closed",
      state_reason: "completed",
    });
}
module.exports = {
  fingerprintFinding: f.fingerprintFinding,
  stageFinding,
  claimPublication,
  issueMatches,
  publishFinding,
  appendDuplicates,
  noteResolution,
};
