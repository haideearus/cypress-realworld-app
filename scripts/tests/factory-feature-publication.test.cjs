const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../factory/feature-contract.cjs");
const { publishPart, nextPart } = require("../factory/feature-publication.cjs");

const proposal = {
  size: "minor",
  title: "Name the amount range clear action",
  problem: "The amount range button gives its reset action a generic accessible name.",
  benefit: "Assistive technology users can identify which filter will be cleared.",
  evidence: { kind: "issue", number: 8, quote: "Identify the filter being reset" },
  steps: [
    {
      title: "Name the amount range clear action",
      scope: "Give the reset button a descriptive and filter-specific accessible name.",
      acceptance: ["The clear button can be found by its filter-specific accessible name."],
    },
  ],
};
const key = c.proposalKey(proposal);
const base = {
  week: "2026-11-23",
  producer: { mode: "pilot", head: "a".repeat(40), runId: "15" },
  proposal,
  parent: null,
  stages: [null],
};
function fixture({ lost = false, blocked = false } = {}) {
  let state = { version: 1, records: { [key]: structuredClone(base) } };
  const issues = [];
  const calls = [];
  const api = {
    pages: async () => issues,
    request: async (method, path, body) => {
      calls.push(method + " " + path);
      if (method === "POST" && path.endsWith("/issues")) {
        const issue = { ...body, number: 3, state: "open", user: c.BOT, labels: [] };
        issues.push(issue);
        if (lost) throw Error("Connection ended during issue creation");
        return issue;
      }
      if (method === "GET" && path.endsWith("/issues/3")) return issues[0];
      if (method === "POST" && path.endsWith("/labels")) {
        issues[0].labels = [{ name: c.READY }];
        return issues[0].labels;
      }
      throw Error("Unplanned GitHub call");
    },
  };
  const store = {
    read: async () => ({ state: structuredClone(state), commit: "a".repeat(40) }),
    update: async (fn) => {
      const result = await fn(structuredClone(state));
      state = c.validateRegistry(result.state);
      return result;
    },
  };
  return {
    calls,
    issues,
    store,
    api,
    beforeWrite: async () => {
      if (blocked) throw Error("Repair waiting");
    },
  };
}

test("an uncertain issue write is reconciled before ready promotion and never replayed", async () => {
  const f = fixture({ lost: true });
  const part = { key, index: 0 };
  await assert.rejects(() => publishPart(f, part), /connection ended/i);
  assert.deepEqual((await f.store.read()).state.records[key].stages[0], {
    phase: "intent",
    issue: null,
  });
  assert.equal(f.issues[0].labels.length, 0);
  await publishPart(f, part);
  assert.deepEqual((await f.store.read()).state.records[key].stages[0], {
    phase: "ready",
    issue: 3,
  });
  assert.equal(f.calls.filter((call) => call.endsWith("/issues")).length, 1);
  assert.equal(await nextPart(f.api, {}, (await f.store.read()).state, base.week, "pilot"), null);
});

test("a repair prevents even a publication intent and issue creation", async () => {
  const f = fixture({ blocked: true });
  await assert.rejects(() => publishPart(f, { key, index: 0 }), /repair waiting/i);
  assert.equal((await f.store.read()).state.records[key].stages[0], null);
  assert.deepEqual(f.calls, []);
});
test("major eligibility requires every stage to carry its own reviewed merge", () => {
  const { mergedMajorParents } = require("../factory/feature-publication.cjs");
  const major = {
    ...proposal,
    size: "major",
    steps: [proposal.steps[0], { ...proposal.steps[0], title: "Improve keyboard movement" }],
  };
  const id = c.proposalKey(major);
  const registry = {
    records: {
      [id]: {
        ...base,
        proposal: major,
        parent: { phase: "linked", issue: 6 },
        stages: [
          { phase: "ready", issue: 3 },
          { phase: "ready", issue: 4 },
        ],
      },
    },
  };
  const closed = (issue, index) => ({
    feature: c.receiptFor(id, registry.records[id], index),
    merge: { status: "merged" },
  });
  assert.deepEqual(mergedMajorParents(registry, { tickets: { 3: closed(3, 0) } }), []);
  assert.deepEqual(
    mergedMajorParents(registry, { tickets: { 3: closed(3, 0), 4: closed(4, 1) } }),
    [[id, registry.records[id]]]
  );
});
test("a guard failing after intent but before POST clears only the known-unsent intent", async () => {
  const f = fixture();
  let checks = 0;
  f.beforeWrite = async () => {
    if (++checks === 2) throw Error("Repair arrived while recording intent");
  };
  await assert.rejects(() => publishPart(f, { key, index: 0 }), /repair arrived/i);
  assert.equal((await f.store.read()).state.records[key].stages[0], null);
  assert.deepEqual(f.calls, []);
  assert.equal((await publishPart(f, { key, index: 0 })).phase, "ready");
});
test("an exhausted stage leaves its major unfinished while independent features progress", async () => {
  const major = {
    ...proposal,
    size: "major",
    steps: [proposal.steps[0], { ...proposal.steps[0], title: "Improve keyboard movement" }],
  };
  const id = c.proposalKey(major);
  const stage = {
    ...base,
    proposal: major,
    parent: { phase: "linked", issue: 6 },
    stages: [{ phase: "ready", issue: 3 }, null],
  };
  const independent = {
    ...proposal,
    title: "Clarify the date selection",
    steps: [{ ...proposal.steps[0], title: "Clarify the date selection" }],
  };
  const independentKey = c.proposalKey(independent);
  const state = { records: { [id]: stage, [independentKey]: { ...base, proposal: independent } } };
  const issue = {
    ...c.issueFields(id, stage, 0),
    number: 3,
    state: "open",
    labels: [{ name: c.READY }],
    user: c.BOT,
  };
  const api = { request: async () => issue };
  const feature = c.receiptFor(id, stage, 0);
  const tickets = { 3: { status: "blocked", feature } };
  assert.deepEqual(await nextPart(api, { tickets }, state, base.week, "pilot"), {
    key: independentKey,
    index: 0,
  });
  tickets[3].delayedRetry = { grantId: "waiting" };
  assert.equal(await nextPart(api, { tickets }, state, base.week, "pilot"), null);
});
test("a claimed merge without the exact feature receipt cannot advance a major", async () => {
  const major = {
    ...proposal,
    size: "major",
    steps: [proposal.steps[0], { ...proposal.steps[0], title: "Improve keyboard movement" }],
  };
  const id = c.proposalKey(major);
  const stage = {
    ...base,
    proposal: major,
    parent: { phase: "linked", issue: 6 },
    stages: [{ phase: "ready", issue: 3 }, null],
  };
  const issue = {
    ...c.issueFields(id, stage, 0),
    number: 3,
    state: "open",
    labels: [{ name: c.READY }],
    user: c.BOT,
  };
  const selected = await nextPart(
    { request: async () => issue },
    { tickets: { 3: { merge: { status: "merged" } } } },
    { records: { [id]: stage } },
    base.week,
    "pilot"
  );
  assert.equal(selected, null);
});
