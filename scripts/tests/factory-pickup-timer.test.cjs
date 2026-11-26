const { test } = require("node:test");
const assert = require("node:assert/strict");
const { OWNER, OWNER_ID, REPOSITORY } = require("../factory/wake-contract.cjs");

const tick = Date.UTC(2026, 10, 26, 10, 3);
const context = {
  repository: REPOSITORY,
  actor: OWNER,
  triggeringActor: OWNER,
  ref: "refs/heads/main",
  event: "workflow_dispatch",
  workflowRef: `${REPOSITORY}/.github/workflows/factory-automatic.yml@refs/heads/main`,
  workflowSha: "a".repeat(40),
  runId: "12345",
  runAttempt: 1,
};
const vars = {
  FACTORY_EXTERNAL_PICKUP_ENABLED: "true",
  FACTORY_MAX_CONCURRENT_TICKETS: "1",
};
const inputs = { operation: "run", dry_run: false, timer_tick: String(tick) };
const actor = { login: OWNER, id: OWNER_ID };
const run = {
  id: 12345,
  run_attempt: 1,
  event: context.event,
  path: ".github/workflows/factory-automatic.yml",
  repository: { full_name: REPOSITORY },
  head_repository: { full_name: REPOSITORY },
  head_branch: "main",
  head_sha: context.workflowSha,
  actor,
  triggering_actor: actor,
  display_title: `Automatic factory / timer ${tick}`,
  created_at: new Date(tick + 1000).toISOString(),
  status: "in_progress",
};

function metadata(current, others = []) {
  return {
    async request(method, path) {
      assert.equal(method, "GET");
      if (path.endsWith(`/actions/runs/${current.id}`)) return current;
      const source = others.find((run) =>
        path.endsWith(`/actions/runs/${run.id}/attempts/1/jobs?per_page=15`)
      );
      if (source)
        return {
          jobs: [
            {
              name: "pick",
              run_id: source.id,
              head_sha: source.head_sha,
              steps: [
                {
                  name: "Select eligible factory work",
                  conclusion: source.pickConclusion || "success",
                },
              ],
            },
          ],
        };
      assert.match(path, /factory-automatic\.yml\/runs\?branch=main/);
      return { total_count: others.length + 1, workflow_runs: [current, ...others] };
    },
  };
}

test("a timer dispatch must be opted in and use the single-ticket limit", async () => {
  const { checkPickupTick } = require("../factory/pickup-timer.cjs");
  const disabled = await checkPickupTick(null, { context, inputs, vars: {} });
  assert.equal(disabled.allowed, false);
  const unsafe = await checkPickupTick(null, {
    context,
    inputs,
    vars: { ...vars, FACTORY_MAX_CONCURRENT_TICKETS: "2" },
  });
  assert.equal(unsafe.allowed, false);
});

test("native pickup still runs when the external timer's single-ticket setting is invalid", async () => {
  const { checkPickupTick } = require("../factory/pickup-timer.cjs");
  const native = { ...run, event: "schedule", display_title: "Automatic factory" };
  const result = await checkPickupTick(metadata(native), {
    context: { ...context, event: "schedule" },
    inputs: {},
    vars: { ...vars, FACTORY_MAX_CONCURRENT_TICKETS: "2" },
  });
  assert.equal(result.allowed, true);
});

test("a timer cannot invoke owner recovery operations or run from another branch", async () => {
  const { checkPickupTick } = require("../factory/pickup-timer.cjs");
  for (const args of [
    { context, inputs: { ...inputs, operation: "retry-finding", ticket: "97" } },
    { context: { ...context, ref: "refs/heads/other" }, inputs },
    { context: { ...context, runAttempt: 2 }, inputs },
  ]) {
    const result = await checkPickupTick(null, { ...args, vars });
    assert.equal(result.allowed, false);
  }
});

test("the first valid timer run in a window is admitted", async () => {
  const { checkPickupTick } = require("../factory/pickup-timer.cjs");
  const result = await checkPickupTick(metadata(run), { context, inputs, vars });
  assert.equal(result.allowed, true);
});

test("a GitHub schedule and Cloudflare tick share one polling window", async () => {
  const { checkPickupTick } = require("../factory/pickup-timer.cjs");
  const native = { ...run, id: 12344, event: "schedule", display_title: "Automatic factory" };
  const external = await checkPickupTick(metadata(run, [native]), { context, inputs, vars });
  assert.equal(external.outcome, "duplicate");
  const laterNative = { ...native, id: 12346 };
  const fallback = await checkPickupTick(metadata(laterNative, [run]), {
    context: { ...context, event: "schedule", runId: String(laterNative.id) },
    inputs: {},
    vars,
  });
  assert.equal(fallback.outcome, "duplicate");
});

test("a preceding skipped or queued run is no proof the queue was checked", async () => {
  const { checkPickupTick } = require("../factory/pickup-timer.cjs");
  const other = { ...run, id: 12344, status: "completed", pickConclusion: "skipped" };
  assert.equal(
    (await checkPickupTick(metadata(run, [other]), { context, inputs, vars })).allowed,
    true
  );
  assert.equal(
    (
      await checkPickupTick(metadata(run, [{ ...other, status: "queued" }]), {
        context,
        inputs,
        vars,
      })
    ).allowed,
    true
  );
});

test("a timer title is trusted only for owner dispatches created in its window", () => {
  const { timerRun } = require("../factory/pickup-timer.cjs");
  assert.equal(timerRun(run), true);
  assert.equal(timerRun({ ...run, triggering_actor: { ...actor, id: 42 } }), false);
  assert.equal(timerRun({ ...run, created_at: new Date(tick - 1000).toISOString() }), false);
  assert.equal(timerRun({ ...run, display_title: "Automatic factory" }), false);
});

test("Cloudflare requests only the fixed main pickup workflow, once per invocation", async () => {
  const { dispatchPickup } = await import("../../ops/cloudflare-pickup/worker.mjs");
  const calls = [];
  const receipt = await dispatchPickup(
    tick,
    { GITHUB_DISPATCH_TOKEN: "fixture" },
    async (...args) => {
      calls.push(args);
      return { status: 204 };
    }
  );
  assert.equal(receipt.outcome, "requested");
  assert.equal(calls.length, 1);
  assert.match(
    calls[0][0],
    /\/repos\/haideearus\/cypress-realworld-app\/actions\/workflows\/factory-automatic\.yml\/dispatches$/
  );
  assert.equal(calls[0][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[0][1].body), { ref: "main", inputs });
});

test("Cloudflare reports a rejected request without retrying", async () => {
  const { dispatchPickup } = await import("../../ops/cloudflare-pickup/worker.mjs");
  let calls = 0;
  await assert.rejects(
    dispatchPickup(tick, { GITHUB_DISPATCH_TOKEN: "fixture" }, async () => {
      calls += 1;
      return { status: 403 };
    }),
    /403/
  );
  assert.equal(calls, 1);
});
