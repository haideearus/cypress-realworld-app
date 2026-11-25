const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../factory/dependency-contract.cjs");
const { GitHub, Ledger, ROOT } = require("../factory/github.cjs");
const { MetadataStore } = require("../factory/metadata-store.cjs");
const {
  trackNativeDependencies,
  previewNativeRecovery,
} = require("../factory/dependency-tracking.cjs");
const policy = require("../factory/policy.cjs");
const lifecycle = require("../factory/dependency-policy.cjs");
const wakes = require("../factory/wake-contract.cjs");
const { GitHubFixture, context, vars } = require("./helpers/factory-fixtures.cjs");

const label = "factory-dependency-ready";
const config = { enabled: true, automatic: true };
const ctx = { ...context, workflowRef: d.WORKFLOW, workflowSha: "a".repeat(40) };
const bot = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
const owner = { login: "haideearus", id: 101267861, type: "User" };
const repo = { full_name: d.REPOSITORY };
const ciPath = ".github/workflows/factory-ci.yml";
const mainCIEvent = {
  action: "completed",
  repository: repo,
  workflow: { id: 71, path: ciPath },
  workflow_run: {
    id: 701,
    workflow_id: 71,
    path: ciPath,
    event: "push",
    head_branch: "main",
    head_sha: "c".repeat(40),
    repository: repo,
    head_repository: repo,
    actor: owner,
    triggering_actor: owner,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
  },
};
const native = {
  number: 9,
  state: "open",
  draft: false,
  title: "Native update with an untrusted title",
  body: "A PR description the tracker must not copy",
  user: { login: "dependabot[bot]", id: 49699333, type: "Bot" },
  head: { ref: "dependabot/npm_and_yarn/example-1.2.3", sha: "b".repeat(40), repo },
  base: { ref: "main", sha: "c".repeat(40), repo },
  merged: false,
};

async function setup() {
  const git = new GitHubFixture();
  const ledgerFetch = git.fetch;
  const fixture = {
    main: native.base.sha,
    behind: 0,
    compareReads: 0,
    notePosts: 0,
    comments: [],
    pulls: [structuredClone(native)],
    issues: [],
    issuePosts: 0,
    issuePatches: 0,
    labelExists: false,
    labelWrites: 0,
    detailedReads: 0,
    ref: null,
    wakes: null,
    mainCIRun: structuredClone(mainCIEvent.workflow_run),
  };
  const gitRef = "/git/ref/heads/factory/dependency-tracking";
  const json = (data) => Response.json(data);
  const missing = () => new Response(null, { status: 404 });
  git.fetch = async (url, request) => {
    const path = url.pathname.slice(ROOT.length);
    const data = request.body && JSON.parse(request.body);
    const { method } = request;
    if (method === "GET" && path === "/actions/runs/701/attempts/1") return json(fixture.mainCIRun);
    if (method === "GET" && path === gitRef)
      return fixture.ref ? json({ object: { sha: fixture.ref } }) : missing();
    if (method === "GET" && path === "/git/ref/heads/factory/wakes")
      return fixture.wakes ? json({ object: { sha: "a".repeat(40) } }) : missing();
    if (method === "GET" && path === "/contents/wakes.json")
      return json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(fixture.wakes)).toString("base64"),
      });
    if (method === "GET" && path === "/contents/dependency-tracking.json") {
      const commit = git.objects.get(url.searchParams.get("ref"));
      const tree = git.objects.get(commit.tree);
      const blob = git.objects.get(
        tree.tree.find((row) => row.path === "dependency-tracking.json").sha
      );
      return json({ type: "file", encoding: "base64", content: blob.content });
    }
    if (
      method === "POST" &&
      path === "/git/refs" &&
      data.ref === "refs/heads/factory/dependency-tracking"
    ) {
      if (fixture.ref) return new Response(null, { status: 422 });
      fixture.ref = data.sha;
      return json({ object: { sha: fixture.ref } });
    }
    if (method === "PATCH" && path === "/git/refs/heads/factory/dependency-tracking") {
      assert.equal(data.force, false);
      if (!git.objects.get(data.sha).parents.includes(fixture.ref))
        return new Response(null, { status: 422 });
      fixture.ref = data.sha;
      return json({ object: { sha: fixture.ref } });
    }
    if (method === "GET" && path === "/git/ref/heads/main")
      return json({ object: { sha: fixture.main } });
    if (method === "GET" && path.startsWith("/compare/")) {
      fixture.compareReads++;
      const behind = fixture.staleHeads
        ? Number(fixture.staleHeads.has(path.split("...").at(-1)))
        : fixture.behind;
      return json({
        behind_by: behind,
        merge_base_commit: { sha: behind ? "e".repeat(40) : fixture.main },
      });
    }
    const comment = /^\/issues\/(\d+)\/comments$/.exec(path);
    if (method === "GET" && comment)
      return json(fixture.comments.filter(({ number }) => number === Number(comment[1])));
    if (method === "POST" && comment) {
      const usingOwner = request.headers.Authorization === "Bearer owner-fixture";
      if (data.body === "@dependabot rebase") {
        if (!usingOwner) return new Response(null, { status: 403 });
      } else {
        fixture.notePosts++;
        if (fixture.rejectNote) return new Response(null, { status: 403 });
      }
      const created = {
        number: Number(comment[1]),
        id: 123 + fixture.comments.length,
        user: usingOwner && !fixture.untrustedRefreshAuthor ? owner : bot,
        body: data.body,
      };
      fixture.comments.push(created);
      if (data.body === "@dependabot rebase") {
        if (fixture.lostRefreshResponse) throw Error("lost comment response");
        if (fixture.mainAfterRefresh) fixture.main = fixture.mainAfterRefresh;
        if (fixture.refreshHead) {
          fixture.pulls[0].head.sha = fixture.refreshHead;
          fixture.behind = 0;
        }
      } else if (fixture.lostNoteResponse) throw Error("lost note response");
      return json(created);
    }
    if (method === "GET" && path === "/pulls")
      return json(fixture.pulls.filter((pr) => pr.state === "open"));
    const pull = /^\/pulls\/(\d+)(\/files)?$/.exec(path);
    if (method === "GET" && pull) {
      fixture.detailedReads++;
      const pr = fixture.pulls.find((row) => row.number === Number(pull[1]));
      if (!pr) return missing();
      return json(pull[2] ? pr.files || [{ filename: "yarn.lock", status: "modified" }] : pr);
    }
    if (method === "GET" && path === `/labels/${label}`)
      return fixture.labelExists ? json({ name: label }) : missing();
    if (method === "POST" && path === "/labels") {
      fixture.labelExists = true;
      fixture.labelWrites++;
      return json({ name: data.name });
    }
    if (method === "GET" && path === "/issues")
      return json(fixture.issues.filter((row) => !row.hidden));
    if (method === "POST" && path === "/issues") {
      assert.ok(fixture.labelExists);
      fixture.issuePosts++;
      if (fixture.rejectCreate) return new Response(null, { status: fixture.rejectCreate });
      const issue = {
        ...data,
        labels: data.labels.map((name) => ({ name })),
        number: 92 + fixture.issues.length,
        state: "open",
        user: bot,
      };
      fixture.issues.push(issue);
      if (fixture.lostCreateResponse) {
        issue.hidden = true;
        throw Error("lost issue response");
      }
      return json(issue);
    }
    const issueNumber = /^\/issues\/(\d+)$/.exec(path);
    if (issueNumber) {
      const issue = fixture.issues.find((row) => row.number === Number(issueNumber[1]));
      if (!issue) return missing();
      if (method === "GET") return json(issue);
      if (method === "PATCH") {
        fixture.issuePatches++;
        Object.assign(issue, data);
        if (fixture.lostCloseResponse) throw Error("lost issue close response");
        return json(issue);
      }
    }
    return ledgerFetch(url, request);
  };
  const api = new GitHub({ token: "job-fixture", fetch: git.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  return {
    api,
    fixture,
    ledger,
    track: (preview = false, refresh = false, recoveryOnly = false, mainCI) =>
      trackNativeDependencies(api, mainCI?.config || config, mainCI?.context || ctx, preview, {
        recoveryOnly,
        mainCIEvent: mainCI?.event,
        refreshApi: refresh
          ? new GitHub({
              token: "owner-fixture",
              fetch(url, request) {
                assert.equal(request.method, "POST");
                assert.match(url.pathname, new RegExp(`^${ROOT}/issues/\\d+/comments$`));
                assert.deepEqual(JSON.parse(request.body), { body: "@dependabot rebase" });
                return git.fetch(url, request);
              },
            })
          : undefined,
      }),
  };
}

test("successful current main CI requests one native refresh and preserves attempt history", async () => {
  const { fixture, ledger, track } = await setup();
  await track();
  fixture.behind = 2;
  const cfg = policy.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
    FACTORY_GITHUB_APP_SLUG: "factory-app-fixture",
  });
  await ledger.update((s) => ({ state: lifecycle.claimDependency(s, native, ctx, cfg) }));
  await ledger.update((s) => ({ state: lifecycle.finishPreparation(s, native.number, ctx) }));
  const before = await ledger.read();
  const mainCI = {
    context: { ...ctx, event: "workflow_run", workflowSha: fixture.main },
    config: { ...config, eventPickup: true },
    event: mainCIEvent,
  };
  const result = await track(false, true, true, mainCI);
  assert.deepEqual(result.links, [{ pr: 9, issue: 92, status: "Dependabot refresh requested" }]);
  await track(false, true, true, mainCI);
  assert.equal(fixture.comments.filter(({ body }) => body === "@dependabot rebase").length, 1);
  assert.equal(fixture.issuePosts, 1);
  assert.deepEqual(await ledger.read(), before);
});

test("main CI recovery rejects other event sources and stops when main has advanced", async () => {
  const { fixture, ledger, track } = await setup();
  await track();
  fixture.behind = 2;
  const before = await ledger.read();
  const mainCI = {
    context: { ...ctx, event: "workflow_run", workflowSha: fixture.main },
    config: { ...config, eventPickup: true },
    event: mainCIEvent,
  };
  for (const fields of [
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { conclusion: "failure" },
    { head_repository: { full_name: "another/repo" } },
    { head_branch: "topic" },
    { head_sha: "d".repeat(40) },
  ]) {
    const event = { ...mainCIEvent, workflow_run: { ...mainCIEvent.workflow_run, ...fields } };
    await assert.rejects(track(false, true, true, { ...mainCI, event }), /Untrusted main CI/);
  }
  await assert.rejects(track(false, true, false, mainCI), /Untrusted main CI/);
  const disabled = { ...mainCI, config: { ...config, eventPickup: false } };
  await assert.rejects(track(false, true, true, disabled), /Untrusted main CI/);
  fixture.mainCIRun.conclusion = "failure";
  await assert.rejects(track(false, true, true, mainCI), /Untrusted main CI/);
  fixture.mainCIRun.conclusion = "success";
  fixture.main = "d".repeat(40);
  const result = await track(false, true, true, mainCI);
  assert.match(result.reason, /main advanced/);
  assert.deepEqual(fixture.comments, []);
  assert.deepEqual(await ledger.read(), before);
});

test("an acknowledged refresh stays recorded if main advances during the rebase request", async () => {
  const { fixture, track } = await setup();
  await track();
  fixture.behind = 2;
  fixture.mainAfterRefresh = "d".repeat(40);
  const result = await track(false, true, true, {
    context: { ...ctx, event: "workflow_run", workflowSha: fixture.main },
    config: { ...config, eventPickup: true },
    event: mainCIEvent,
  });
  assert.deepEqual(result.links, [{ pr: 9, issue: 92, status: "Dependabot refresh requested" }]);
  assert.equal(fixture.comments[0].body, "@dependabot rebase");
  assert.match(fixture.comments[1].body, /GitHub accepted/);
});

test("one ready native ticket survives a head refresh without changing the protected usage ledger", async () => {
  const { fixture, ledger, track } = await setup();
  const before = await ledger.read();
  const preview = await track(true);
  assert.deepEqual(preview.links, [{ pr: 9, status: "would track" }]);
  assert.equal(fixture.ref, null);
  assert.equal(fixture.issuePosts, 0);
  assert.equal(fixture.labelWrites, 0);

  const published = await track();
  assert.deepEqual(published.links, [{ pr: 9, issue: 92, status: "opened" }]);
  assert.equal(fixture.issuePosts, 1);
  const [issue] = fixture.issues;
  assert.deepEqual(issue.labels, [{ name: label }]);
  assert.match(issue.body, /https:\/\/github\.com\/haideearus\/cypress-realworld-app\/pull\/9/);
  assert.doesNotMatch(issue.body, /A PR description/);
  fixture.pulls[0].head.sha = "d".repeat(40);
  await track();
  assert.equal(fixture.issuePosts, 1);
  assert.deepEqual(await ledger.read(), before);
});

test("a native refresh awaiting Dependabot leaves other stale PRs available to the queue", async () => {
  const { api, fixture, ledger, track } = await setup();
  const later = structuredClone(native);
  later.number = 10;
  later.head.ref = "dependabot/npm_and_yarn/other-1.0.1";
  later.head.sha = "d".repeat(40);
  fixture.pulls.push(later);
  await track();
  const before = await ledger.read();
  fixture.behind = 2;
  fixture.rejectNote = true;
  assert.equal(await previewNativeRecovery(api, { ledger }), 9);
  assert.equal(fixture.comments.length, 0);
  await track(false, true, true);
  assert.equal(await previewNativeRecovery(api, { ledger }), 10);
  assert.deepEqual(
    fixture.comments
      .filter(({ body }) => body === "@dependabot rebase")
      .map(({ number }) => number),
    [9]
  );
  assert.deepEqual(await ledger.read(), before);
  await track(false, true, true);
  assert.deepEqual(
    fixture.comments
      .filter(({ body }) => body === "@dependabot rebase")
      .map(({ number }) => number),
    [9, 10]
  );
  fixture.rejectNote = false;
  await track(false, true, true);
  await track(false, true, true);
  assert.equal(await previewNativeRecovery(api, { ledger }), null);
});

test("a lost create acknowledgement cannot create another issue before reconciliation", async () => {
  const { fixture, track } = await setup();
  fixture.lostCreateResponse = true;
  await track();
  assert.equal(fixture.issuePosts, 1);
  await track();
  assert.equal(fixture.issuePosts, 1);
  const [issue] = fixture.issues;
  issue.hidden = false;
  fixture.issues.push({ ...issue, number: 99, user: { login: bot.login, id: 99, type: "Bot" } });
  fixture.pulls[0].head.sha = "d".repeat(40);
  await track();
  fixture.pulls[0].state = "closed";
  fixture.pulls[0].merged = true;
  await track();
  assert.equal(fixture.issuePosts, 1);
  assert.equal(issue.state, "closed");
  assert.equal(issue.state_reason, "completed");
  assert.equal(fixture.issues[1].state, "open");
});

test("an unmerged closure survives a lost acknowledgement and reuses its issue on reopen", async () => {
  const { fixture, track } = await setup();
  await track();
  fixture.pulls[0].state = "closed";
  fixture.lostCloseResponse = true;
  await track();
  assert.equal(fixture.issuePatches, 1);
  const [issue] = fixture.issues;
  assert.equal(issue.state, "closed");
  assert.equal(issue.state_reason, "not_planned");
  fixture.lostCloseResponse = false;
  await track();
  assert.equal(fixture.issuePatches, 1);
  fixture.pulls[0].state = "open";
  await track();
  assert.equal(issue.state, "open");
  assert.equal(fixture.issuePosts, 1);
});

test("an untrusted proposal or a forbidden file change cannot publish a native tracker", async () => {
  const { fixture, track } = await setup();
  fixture.pulls[0].user.id = 99;
  fixture.pulls.push({
    ...native,
    number: 10,
    files: [{ filename: "scripts/factory/dependencies.cjs", status: "modified" }],
  });
  await track();
  assert.equal(fixture.issuePosts, 0);
  assert.equal(fixture.labelWrites, 0);
  assert.equal(fixture.ref, null);
});

test("a definite GitHub rejection is visible on later runs without an automatic repeat", async () => {
  const { fixture, track } = await setup();
  fixture.rejectCreate = 403;
  const first = await track();
  assert.equal(first.rejected, 1);
  assert.match(first.links[0].status, /GitHub rejected issue creation \(HTTP 403\)/);
  const later = await track();
  assert.deepEqual(later.links, first.links);
  assert.equal(fixture.issuePosts, 1);
});

test("an ineligible backlog cannot consume an unbounded number of eligibility reads", async () => {
  const { fixture, track } = await setup();
  fixture.pulls = Array.from({ length: 40 }, (_, i) => ({
    ...native,
    number: i + 9,
    files: [{ filename: "scripts/factory/dependencies.cjs", status: "modified" }],
  }));
  await track();
  assert.ok(fixture.detailedReads > 0 && fixture.detailedReads <= 24);
  assert.equal(fixture.issuePosts, 0);
});

test("the durable stop prevents native issue, label and receipt writes", async () => {
  const { fixture, ledger, track } = await setup();
  await ledger.update((state) => {
    state.stop = {
      id: "1be8158e-d459-4a9a-845d-6b1546602e41",
      at: "2026-11-20T08:00:00.000Z",
      actor: "haideearus",
      reason: "Owner emergency stop",
      previous: {
        FACTORY_ENABLED: "true",
        FACTORY_AUTOMATION_ENABLED: "true",
        FACTORY_AUTOMERGE_ENABLED: "true",
      },
    };
    return { state };
  });
  assert.match((await track()).reason, /Factory stopped/);
  assert.equal(fixture.issuePosts, 0);
  assert.equal(fixture.labelWrites, 0);
  assert.equal(fixture.ref, null);
});

test("parallel first runs can claim one native issue publication intent", async () => {
  const { fixture, track } = await setup();
  fixture.labelExists = true;
  const outcomes = await Promise.allSettled([track(), track()]);
  assert.equal(
    outcomes.some((item) => item.status === "fulfilled"),
    true
  );
  assert.equal(fixture.issuePosts, 1);
  await track();
  assert.equal(fixture.issuePosts, 1);
});

test("a stale native head gets one refresh request and a tracking issue reason even after lost delivery", async () => {
  const { fixture, ledger, track } = await setup();
  await track();
  const before = await ledger.read();
  fixture.behind = 2;
  fixture.lostRefreshResponse = true;

  await track(true, true);
  assert.equal(fixture.comments.length, 0);
  await track(false, true);
  await track(false, true);
  assert.deepEqual(
    fixture.comments
      .filter(({ body }) => body === "@dependabot rebase")
      .map(({ number }) => number),
    [native.number]
  );
  const [notice] = fixture.comments.filter(({ number }) => number === 92);
  assert.match(notice.body, /behind `main`/);
  assert.match(notice.body, /could not confirm/);
  assert.equal(fixture.comments.filter(({ number }) => number === 92).length, 1);
  assert.deepEqual(await ledger.read(), before);
});

test("recover a queued PR that went stale during another merge before unrelated tracked PRs", async () => {
  const { fixture, ledger, track } = await setup();
  const queued = structuredClone(native);
  queued.number = 235;
  queued.head = {
    ...queued.head,
    ref: "dependabot/npm_and_yarn/queued-1.2.3",
    sha: "d".repeat(40),
  };
  fixture.pulls.push(queued);
  await track();
  const before = await ledger.read();
  const receipt = wakes.createWake({
    signal: {
      kind: "dependency-ci",
      lane: "dependency",
      number: queued.number,
      head: queued.head.sha,
      criteriaHash: d.criteria(queued.number),
      revision: fixture.main,
      sourceRun: "45457390427",
      sourceAttempt: 1,
      actor: { login: native.user.login, id: native.user.id },
    },
    producer: {
      runId: "45459070309",
      runAttempt: 1,
      workflowSha: fixture.main,
      actor: owner,
      event: "workflow_run",
    },
  });
  fixture.wakes = wakes.emptyWakes();
  fixture.wakes.receipts[receipt.id] = receipt;

  fixture.pulls.push({ ...native, number: 244 });
  fixture.main = "f".repeat(40);
  fixture.behind = 1;
  await track(false, true, true);
  await track(false, true, true);
  fixture.main = "1".repeat(40);
  await track(false, true, true);
  await track(false, true, true);

  assert.deepEqual(
    fixture.comments
      .filter(({ body }) => body === "@dependabot rebase")
      .map(({ number }) => number),
    [235, 9, 235, 9]
  );
  assert.equal(fixture.issuePosts, 2);
  assert.deepEqual(await ledger.read(), before);
});

test("a full queue of current PRs leaves an inspection slot for unrelated stale PRs", async () => {
  const { api, fixture, track } = await setup();
  fixture.wakes = wakes.emptyWakes();
  for (let number = 235; number < 247; number++) {
    const pr = structuredClone(native);
    pr.number = number;
    pr.head.sha = number.toString(16).padStart(40, "d");
    pr.head.ref = `dependabot/npm_and_yarn/queued-${number}`;
    fixture.pulls.push(pr);
    const receipt = wakes.createWake({
      signal: {
        kind: "dependency-ci",
        lane: "dependency",
        number,
        head: pr.head.sha,
        criteriaHash: d.criteria(number),
        revision: fixture.main,
        sourceRun: String(number),
        sourceAttempt: 1,
        actor: { login: native.user.login, id: native.user.id },
      },
      producer: {
        runId: "100",
        runAttempt: 1,
        workflowSha: fixture.main,
        actor: owner,
        event: "workflow_run",
      },
    });
    fixture.wakes.receipts[receipt.id] = receipt;
  }
  // Recovery starts with existing tracking records. Creating those records
  // through live intake would make setup depend on the hourly scan rotation.
  const records = {};
  for (const [index, pr] of fixture.pulls.entries()) {
    const issue = 900 + index;
    fixture.issues.push({
      number: issue,
      state: "open",
      user: bot,
      labels: [{ name: label }],
      title: `Dependency maintenance for Dependabot PR #${pr.number}`,
      body:
        `Track [Dependabot PR #${pr.number}](https://github.com/${d.REPOSITORY}/pull/${pr.number}). Dependency maintenance verifies the current proposal through its protected analysis, CI, review and merge workflow.\n\n` +
        `<!-- factory-native-dependency:${pr.number} -->`,
    });
    records[pr.number] = { branch: pr.head.ref, issue, status: "open" };
  }
  const registry = new MetadataStore(
    api,
    "dependency-tracking",
    () => ({}),
    (state) => state
  );
  await registry.save({ version: 1, records }, null);

  fixture.staleHeads = new Set([native.head.sha]);
  await track(false, true, true);
  assert.deepEqual(
    fixture.comments
      .filter(({ body }) => body === "@dependabot rebase")
      .map(({ number }) => number),
    [9]
  );
  assert.equal(fixture.issuePosts, 0);
});

test("a failed dependency preparation gets one bound blocker notice without changing the ledger", async () => {
  const { fixture, ledger, track } = await setup();
  await track();
  const cfg = policy.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
    FACTORY_GITHUB_APP_SLUG: "factory-app-fixture",
  });
  await ledger.update((s) => ({ state: lifecycle.claimDependency(s, native, ctx, cfg) }));
  await ledger.update((s) => ({ state: lifecycle.finishPreparation(s, native.number, ctx) }));
  const before = await ledger.read();

  await track();
  await track();
  assert.equal(fixture.comments.length, 1);
  assert.equal(fixture.comments[0].number, 92);
  assert.match(fixture.comments[0].body, /preparation stopped/);
  assert.match(fixture.comments[0].body, new RegExp(native.head.sha));
  assert.deepEqual(await ledger.read(), before);
});

test("the tracker does not request a stale-head refresh for an active or untrusted proposal", async () => {
  const { fixture, ledger, track } = await setup();
  await track();
  fixture.behind = 1;
  const cfg = policy.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
    FACTORY_GITHUB_APP_SLUG: "factory-app-fixture",
  });
  await ledger.update((s) => ({ state: lifecycle.claimDependency(s, native, ctx, cfg) }));
  await track(false, true);
  assert.equal(fixture.comments.length, 0);

  await ledger.update((s) => ({ state: lifecycle.finishPreparation(s, native.number, ctx) }));
  fixture.pulls[0].files = [{ filename: "scripts/factory/dependencies.cjs", status: "modified" }];
  await track(false, true);
  assert.equal(fixture.comments.length, 0);
});

test("a fresh commit arriving during a requested rebase still records the old head on its issue", async () => {
  const { fixture, track } = await setup();
  await track();
  fixture.main = "f".repeat(40);
  fixture.behind = 1;
  fixture.refreshHead = "d".repeat(40);

  const result = await track(false, true);
  assert.equal(result.links[0].status, "Dependabot refresh requested");
  const note = fixture.comments.find(({ number }) => number === 92);
  assert.match(note.body, new RegExp(native.head.sha));
  assert.match(note.body, /GitHub accepted the Dependabot rebase request/);
  assert.equal(fixture.pulls[0].head.sha, fixture.refreshHead);
  await track();
  assert.equal(fixture.comments.length, 2);
});

test("without the owner credential, record one manual action and reconsider when it is configured", async () => {
  const { fixture, track } = await setup();
  await track();
  fixture.behind = 1;

  await track();
  const compared = fixture.compareReads;
  await track();
  assert.equal(fixture.comments.length, 1);
  assert.equal(fixture.comments[0].number, 92);
  assert.match(fixture.comments[0].body, /FACTORY_DEPENDABOT_REBASE_TOKEN/);
  assert.match(fixture.comments[0].body, /@dependabot rebase/);
  assert.equal(fixture.compareReads, compared);

  await track(false, true);
  assert.deepEqual(
    fixture.comments.map(({ user }) => user),
    [bot, owner, bot]
  );
  assert.equal(fixture.comments[1].number, native.number);
  assert.equal(fixture.comments[1].body, "@dependabot rebase");
});

test("a rebase response must be authored by the configured owner", async () => {
  const { fixture, track } = await setup();
  await track();
  fixture.behind = 1;
  fixture.untrustedRefreshAuthor = true;

  const result = await track(false, true);
  assert.match(result.links[0].status, /delivery unconfirmed/);
  assert.match(fixture.comments[1].body, /could not confirm/);
  await track(false, true);
  assert.equal(fixture.comments.length, 2);
});

test("a rejected tracking note retries and a lost note acknowledgement reconciles without repetition", async () => {
  const { fixture, track } = await setup();
  await track();
  fixture.behind = 1;
  fixture.rejectNote = true;
  await track(false, true);

  assert.equal(fixture.comments.length, 1);
  assert.equal(fixture.notePosts, 1);
  assert.equal(fixture.comments[0].body, "@dependabot rebase");
  fixture.rejectNote = false;
  fixture.lostNoteResponse = true;
  await track(false, true);

  assert.equal(fixture.comments.length, 2);
  assert.equal(fixture.notePosts, 2);
  assert.equal(fixture.comments[1].number, 92);
  await track(false, true);
  await track(false, true);
  assert.equal(fixture.comments.length, 2);
  assert.equal(fixture.notePosts, 2);
});
