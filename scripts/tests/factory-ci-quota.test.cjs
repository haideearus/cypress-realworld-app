const assert = require("node:assert/strict");
const test = require("node:test");
const { GitHub, Ledger, ROOT } = require("../factory/github.cjs");
const { Controller } = require("../factory/controller.cjs");
const policy = require("../factory/policy.cjs");
const { FactoryFixture, context, head, vars } = require("./helpers/factory-fixtures.cjs");

const initial = Date.parse("2026-11-19T12:15:00Z");
const list = "/actions/workflows/factory-ci.yml/runs";
const dispatch = "/actions/workflows/factory-ci.yml/dispatches";
const rate = (options = {}) =>
  new Response(
    JSON.stringify({ message: options.message ?? "API rate limit exceeded for installation." }),
    {
      status: options.status ?? 403,
      headers: {
        "x-ratelimit-remaining": options.remaining ?? "0",
        "x-ratelimit-reset": String((initial + (options.delay ?? 61000)) / 1000),
        ...(options.retryAfter ? { "retry-after": options.retryAfter } : {}),
      },
    }
  );

function clock() {
  let time = initial;
  const waits = [];
  return {
    waits,
    now: () => time,
    sleep: async (ms) => {
      waits.push(ms);
      time += ms;
    },
  };
}

test("a confirmed quota response waits past the larger of reset and Retry-After", async () => {
  const c = clock();
  let calls = 0;
  const api = new GitHub({
    token: "fixture-only",
    waitOnQuota: true,
    now: c.now,
    sleep: c.sleep,
    fetch: async () =>
      calls++ === 0 ? rate({ status: 429, retryAfter: "80" }) : Response.json({ ok: true }),
  });
  assert.deepEqual(await api.request("GET", ROOT + "/issues/10"), { ok: true });
  assert.equal(calls, 2);
  assert.ok(c.waits[0] >= 80000 && c.waits[0] < 85000);
});

test("permission failures, secondary responses, excessive waits and unrelated writes are never retried", async () => {
  for (const [method, path, response] of [
    ["GET", "/issues/10", () => rate({ message: "Resource not accessible by integration" })],
    [
      "GET",
      "/issues/10",
      () => rate({ status: 429, remaining: "22", message: "secondary rate limit" }),
    ],
    ["GET", "/issues/10", () => rate({ delay: 90 * 60000 })],
    ["POST", "/issues", () => rate()],
    ["POST", dispatch, () => rate()],
  ]) {
    let calls = 0;
    const c = clock();
    const api = new GitHub({
      token: "fixture-only",
      waitOnQuota: true,
      now: c.now,
      sleep: c.sleep,
      fetch: async () => {
        calls++;
        return response();
      },
    });
    await assert.rejects(
      api.request(method, ROOT + path),
      /GitHub (request failed|API quota wait budget)/
    );
    assert.equal(calls, 1);
    assert.deepEqual(c.waits, []);
  }
});

async function ownerReview(intercept) {
  const fixture = new FactoryFixture();
  const branch = "agent/owner-harness";
  fixture.branchHeads.set(branch, head);
  fixture.prs.push({ number: 30, branch, state: "open", user: { login: policy.OWNER } });
  const c = clock();
  const requests = [];
  const api = new GitHub({
    token: "fixture-only",
    waitOnQuota: true,
    now: c.now,
    sleep: c.sleep,
    fetch: async (url, options) => {
      const path = url.pathname.slice(ROOT.length);
      requests.push([options.method, path, options.body]);
      return (await intercept?.({ url, path, options, fixture, c })) || fixture.fetch(url, options);
    },
  });
  const ledger = new Ledger(api);
  await ledger.initialize();
  const config = policy.readConfig(vars);
  const controller = new Controller(api, config, context, { sleep: async () => {}, maxPolls: 3 });
  const grant = await controller.admitPR(10, 30);
  return { api, config, controller, fixture, ledger, grant, requests, c };
}

test("quota exhaustion during CI polling resumes the exact run and keeps one review reservation", async () => {
  let rejected = false;
  const f = await ownerReview(({ path }) => {
    if (path === list && !rejected) {
      rejected = true;
      return rate();
    }
  });
  const before = (await f.ledger.read()).state;
  const ci = await f.controller.ci(10);
  assert.equal(ci.passed, true);
  assert.equal(f.fixture.runs.length, 1);
  assert.equal(f.fixture.runs[0].display_title, `Factory CI / ${ci.requestId}`);
  const after = (await f.ledger.read()).state;
  assert.deepEqual(after.days, before.days);
  assert.deepEqual(after.grants, before.grants);
  assert.equal(after.tickets[10].reviews, 1);
  assert.equal(after.tickets[10].coding, 0);
  assert.deepEqual(await f.controller.ci(10), ci);
  assert.equal(f.fixture.runs.length, 1);
  assert.equal(f.c.waits.length, 1);
});

test("the same owner can recover a reserved CI dispatch after an interrupted read", async () => {
  let denied = false;
  const f = await ownerReview(({ path }) => {
    if (path === list && !denied) {
      denied = true;
      return Response.json({ message: "Access denied" }, { status: 403 });
    }
  });
  await assert.rejects(f.controller.ci(10), { status: 403 });
  const draft = (await f.ledger.read()).state.tickets[10].ci;
  assert.equal(draft.runId, null);
  const wrongAttempt = new Controller(f.api, f.config, { ...context, runAttempt: 2 });
  await assert.rejects(wrongAttempt.ci(10), /active run/);
  const recovered = await f.controller.ci(10);
  assert.equal(recovered.requestId, draft.requestId);
  assert.equal(recovered.passed, true);
  assert.equal(f.fixture.runs.length, 1);
});

test("a definite quota rejection of CI dispatch retries once and never generates a new correlation", async () => {
  let denied = false;
  const f = await ownerReview(({ path }) => {
    if (path === dispatch && !denied) {
      denied = true;
      return rate();
    }
  });
  assert.equal((await f.controller.ci(10)).passed, true);
  const posts = f.requests.filter(([method, path]) => method === "POST" && path === dispatch);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0][2], posts[1][2]);
  assert.equal(f.fixture.runs.length, 1);
});

test("a changed PR head during the wait prevents a second CI dispatch", async () => {
  const f = await ownerReview(({ path, fixture }) => {
    if (path === dispatch) {
      fixture.prHeadOverride = "c".repeat(40);
      return rate();
    }
  });
  await assert.rejects(f.controller.ci(10), /head/i);
  assert.equal(
    f.requests.filter(([method, path]) => method === "POST" && path === dispatch).length,
    1
  );
  assert.equal(f.fixture.runs.length, 0);
});

test("a released run slot during the dispatch wait cannot restart CI", async () => {
  let f;
  f = await ownerReview(async ({ path }) => {
    if (path === dispatch) {
      const other = new Controller(f.api, f.config, { ...context, runId: "201" });
      await other.cancel();
      return rate();
    }
  });
  await assert.rejects(f.controller.ci(10), /active run/);
  assert.equal(
    f.requests.filter(([method, path]) => method === "POST" && path === dispatch).length,
    1
  );
  assert.equal((await f.ledger.read()).state.tickets[10].reviews, 1);
});

test("a CI result that changes during a quota wait on the save cannot admit a review", async () => {
  let limited = false;
  const f = await ownerReview(({ path, options, fixture }) => {
    if (
      !limited &&
      options.method === "PATCH" &&
      path === "/git/refs/heads/factory/state" &&
      fixture.runs[0]
    ) {
      limited = true;
      fixture.runs[0].conclusion = "failure";
      fixture.ciConclusion = "failure";
      return rate();
    }
  });
  await assert.rejects(f.controller.ci(10), /Saved CI outcome changed/);
  await assert.rejects(f.controller.ci(10), /Saved CI outcome changed/);
  assert.equal(f.fixture.runs.length, 1);
  assert.equal((await f.ledger.read()).state.tickets[10].reviews, 1);
});

test("an ambiguous dispatch is never replayed and its saved request can still find an accepted run", async () => {
  let first = true;
  const f = await ownerReview(async ({ url, path, options, fixture }) => {
    if (path === dispatch && first) {
      first = false;
      await fixture.fetch(url, options);
      throw new TypeError("Fixture lost the dispatch response");
    }
  });
  await assert.rejects(f.controller.ci(10), /lost the dispatch response/);
  const pending = (await f.ledger.read()).state.tickets[10].ci;
  assert.equal(pending.runId, null);
  const actual = await f.controller.ci(10);
  assert.equal(actual.requestId, pending.requestId);
  assert.equal(actual.passed, true);
  assert.equal(
    f.requests.filter(([method, path]) => method === "POST" && path === dispatch).length,
    1
  );
});

test("assessment waits for a rejected ledger write and saves the same genuine review once", async () => {
  const stateRef = "/git/refs/heads/factory/state";
  let quotaOnNextWrite = false;
  const f = await ownerReview(({ path, options }) => {
    if (quotaOnNextWrite && options.method === "PATCH" && path === stateRef) {
      quotaOnNextWrite = false;
      return rate();
    }
  });
  const ci = await f.controller.ci(10);
  quotaOnNextWrite = true;
  const afterCI = f.requests.length;
  const result = await f.controller.assessPR(
    10,
    { ci: "success", review: "success" },
    ci.runId,
    f.grant.grantId,
    {
      kind: "review",
      grantId: f.grant.grantId,
      base: head,
      result: {
        head,
        verdict: "pass",
        summary:
          "Reviewed the exact tested source revision against the issue criteria and confirmed that the regression coverage supports the required change.",
        findings: [],
      },
    }
  );
  const writes = f.requests
    .slice(afterCI)
    .filter(([method, path]) => method === "PATCH" && path === stateRef);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(result.reviewed, true);
  const state = (await f.ledger.read()).state;
  assert.equal(state.tickets[10].reviews, 1);
  assert.equal(state.tickets[10].approval.grant, f.grant.grantId);
  assert.equal(state.grants[f.grant.grantId].status, "finished");
  assert.equal(f.fixture.checks.length, 1);
});

test("polls a known CI run directly, then checks its correlation is unique before saving", async () => {
  let discoveryReads = 0;
  const f = await ownerReview(({ path, fixture }) => {
    if (path === list && ++discoveryReads === 1)
      return Response.json({ workflow_runs: [{ ...fixture.runs[0], status: "in_progress" }] });
    if (path === list)
      return Response.json({ workflow_runs: [fixture.runs[0], { ...fixture.runs[0], id: 502 }] });
  });
  await assert.rejects(f.controller.ci(10), /Ambiguous CI dispatch identity/);
  assert.equal(discoveryReads, 2);
  assert.equal(
    f.requests.some(([method, path]) => method === "GET" && path === "/actions/runs/501"),
    true
  );
  assert.equal((await f.ledger.read()).state.tickets[10].ci.runId, null);
});
