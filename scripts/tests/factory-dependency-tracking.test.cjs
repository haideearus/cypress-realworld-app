const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../factory/dependency-contract.cjs");
const { GitHub, Ledger, ROOT } = require("../factory/github.cjs");
const { trackNativeDependencies } = require("../factory/dependency-tracking.cjs");
const { GitHubFixture, context } = require("./helpers/factory-fixtures.cjs");

const label = "factory-dependency-ready";
const config = { enabled: true, automatic: true };
const ctx = { ...context, workflowRef: d.WORKFLOW, workflowSha: "a".repeat(40) };
const bot = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
const repo = { full_name: d.REPOSITORY };
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
    pulls: [structuredClone(native)],
    issues: [],
    issuePosts: 0,
    issuePatches: 0,
    labelExists: false,
    labelWrites: 0,
    detailedReads: 0,
    ref: null,
  };
  const gitRef = "/git/ref/heads/factory/dependency-tracking";
  const json = (data) => Response.json(data);
  const missing = () => new Response(null, { status: 404 });
  git.fetch = async (url, request) => {
    const path = url.pathname.slice(ROOT.length);
    const data = request.body && JSON.parse(request.body);
    const { method } = request;
    if (method === "GET" && path === gitRef)
      return fixture.ref ? json({ object: { sha: fixture.ref } }) : missing();
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
    fixture,
    ledger,
    track: (preview = false) => trackNativeDependencies(api, config, ctx, preview),
  };
}

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
