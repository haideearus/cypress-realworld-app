const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { fixture, at, sha } = require("./helpers/monitor-ack-fixture.cjs");
const file = path.join(__dirname, "../factory/monitor-ack.cjs");
const ack = fs.existsSync(file) ? require(file) : {};
async function run(f, extra = {}) {
  assert.equal(typeof ack.acknowledge, "function", "acknowledgment feature must exist");
  return ack.acknowledge({ ...f.options(), ...extra });
}
test("preview is default and writes no issue, registry or ledger", async () => {
  const f = fixture(),
    before = JSON.stringify(f.registry),
    ledger = JSON.stringify(f.state);
  const result = await run(f);
  assert.equal(result.outcome, "acknowledgment_preview");
  assert.equal(JSON.stringify(f.registry), before);
  assert.equal(JSON.stringify(f.state), ledger);
  assert.ok(f.calls.every((c) => c.method === "GET"));
});
test("live acknowledgment persists intent, closes not planned, confirms, then clears only matching pointer", async () => {
  const f = fixture(),
    original = structuredClone(f.incident),
    ledger = JSON.stringify(f.state);
  const result = await run(f, { dryRun: false });
  assert.equal(result.outcome, "incident_acknowledged");
  assert.equal(f.issue.state, "closed");
  assert.equal(f.issue.state_reason, "not_planned");
  assert.equal(f.registry.active, null);
  const i = f.registry.incidents[original.id];
  assert.equal(i.acknowledgment.phase, "complete");
  assert.equal(i.acknowledgment.actor, "haideearus");
  assert.deepEqual(i.source, original.source);
  assert.equal(i.criteriaHash, original.criteriaHash);
  assert.equal(i.day, original.day);
  assert.equal(JSON.stringify(f.state), ledger);
  assert.deepEqual(
    f.calls
      .filter((c) => c.method !== "GET")
      .map((c) => (c.method === "SAVE" ? c.phase : c.method)),
    ["intent", "PATCH", "complete"]
  );
});
test("refuse wrong actor, branch, event, workflow and rerun", async () => {
  for (const change of [
    { actor: "outsider" },
    { triggeringActor: "outsider" },
    { ref: "refs/heads/other" },
    { eventName: "schedule" },
    { runAttempt: 2 },
    { workflowRef: "untrusted" },
    { sha: "b".repeat(40) },
  ]) {
    const f = fixture();
    Object.assign(f.context, change);
    await assert.rejects(run(f, { dryRun: false }));
    assert.ok(f.calls.every((c) => c.method === "GET"));
  }
});
test("refuse enabled switches, contract flag, absent stop, active or ever admitted work", async () => {
  const changes = [
    (f) => {
      f.settings.FACTORY_ENABLED = "true";
    },
    (f) => {
      f.settings.FACTORY_AUTOMATION_ENABLED = "true";
    },
    (f) => {
      f.settings.FACTORY_AUTOMERGE_ENABLED = "true";
    },
    (f) => {
      f.settings.FACTORY_FEED_CONTRACT_CHECK_ENABLED = "true";
    },
    (f) => {
      delete f.state.stop;
    },
    (f) => {
      f.state.active = { ticket: 1 };
    },
    (f) => {
      f.state.tickets[65] = {};
    },
    (f) => {
      f.state.grants.x = { status: "reserved" };
    },
    (f) => {
      f.incident.probeMode = "feed-contract";
    },
    (f) => {
      f.incident.retirement = {};
    },
    (f) => {
      f.issue.body += " edited";
    },
    (f) => {
      f.incident.source.runId = "701";
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    await assert.rejects(run(f, { dryRun: false }));
    assert.ok(f.calls.every((c) => c.method === "GET"));
  }
});
test("failed, stale, wrong-run and mixed-release reports cannot close a ticket", async () => {
  for (const change of [
    (f) => {
      f.report.at = "2026-11-15T00:00:00.000Z";
    },
    (f) => {
      f.report.runId = "901";
    },
    (f) => {
      f.report.result.releases.after = "b".repeat(40);
    },
    (f) => {
      f.report.result.checks.login = "failed";
      f.report.result.healthy = false;
    },
    (f) => {
      f.observation.release = "b".repeat(40);
    },
    (f) => {
      f.observation.healthy = false;
      f.observation.checks.readiness = "failed";
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(run(f, { dryRun: false }));
    assert.ok(f.calls.every((c) => c.method === "GET"));
  }
});
test("lost close response retains intent and new explicit run reconciles without a second close", async () => {
  const f = fixture();
  f.failClose = true;
  await assert.rejects(run(f, { dryRun: false }));
  assert.equal(f.registry.active, f.incident.id);
  assert.equal(f.registry.incidents[f.incident.id].acknowledgment.phase, "intent");
  f.failClose = false;
  f.context.runId = "901";
  f.report.runId = "901";
  await run(f, { dryRun: false });
  assert.equal(f.registry.active, null);
  assert.equal(f.calls.filter((c) => c.method === "PATCH").length, 1);
  assert.equal(f.registry.incidents[f.incident.id].acknowledgment.request.runId, "900");
  assert.equal(f.registry.incidents[f.incident.id].acknowledgment.verification.runId, "901");
});
test("lost final registry write retains intent and can be reconciled", async () => {
  const f = fixture();
  f.failFinal = true;
  await assert.rejects(run(f, { dryRun: false }));
  assert.equal(f.registry.active, f.incident.id);
  assert.equal(f.issue.state, "closed");
  f.failFinal = false;
  await run(f, { dryRun: false });
  assert.equal(f.registry.active, null);
});
test("stop or target changes after intent hold closure", async () => {
  for (const after of [
    (f) => {
      delete f.state.stop;
    },
    (f) => {
      f.issue.body = "tampered";
    },
  ]) {
    const f = fixture();
    f.afterIntent = after;
    await assert.rejects(run(f, { dryRun: false }));
    assert.equal(f.issue.state, "open");
    assert.equal(f.registry.active, f.incident.id);
  }
});
test("preexisting manual closure without matching intent cannot release registry", async () => {
  const f = fixture();
  f.issue.state = "closed";
  f.issue.state_reason = "not_planned";
  await assert.rejects(run(f, { dryRun: false }));
  assert.ok(f.calls.every((c) => c.method === "GET"));
});
test("idempotent acknowledgment preserves a newer active incident", async () => {
  const f = fixture();
  await run(f, { dryRun: false });
  const next = structuredClone(f.incident);
  next.id = "33333333-3333-4333-8333-333333333333";
  next.issue = 67;
  next.recovered = false;
  delete next.acknowledgment;
  f.registry.incidents[next.id] = next;
  f.registry.active = next.id;
  const before = JSON.stringify(f.registry);
  const result = await run(f, { dryRun: false });
  assert.equal(result.outcome, "already_acknowledged");
  assert.equal(JSON.stringify(f.registry), before);
});
test("normal monitor holds pending acknowledgment and active admission refuses its receipt", async () => {
  const f = fixture();
  f.failClose = true;
  await assert.rejects(run(f, { dryRun: false }));
  const before = JSON.stringify(f.registry);
  const result = await require("../factory/monitor.cjs").observeIncident({
    api: f.api,
    store: f.store,
    context: f.context,
    observation: f.observation,
    now: f.now,
    verifiedRetirement: true,
  });
  assert.equal(result.outcome, "acknowledgment_needs_owner_recovery");
  assert.equal(JSON.stringify(f.registry), before);
  assert.equal(
    await require("../factory/monitor-origin.cjs").verifyMonitorIssue(f.api, f.issue),
    null
  );
});
test("repair verifier rejects acknowledgment before querying repair evidence", async () => {
  const f = fixture();
  f.failClose = true;
  await assert.rejects(run(f, { dryRun: false }));
  f.calls.length = 0;
  const context = {
    ...f.context,
    workflowRef: `${f.context.repository}/.github/workflows/factory-monitor.yml@refs/heads/main`,
  };
  const observation = { ...f.observation, appChecks: { ...f.report.result, feedContract: "ok" } };
  await assert.rejects(
    require("../factory/monitor-recovery.cjs").verifyRepair({
      api: f.api,
      context,
      incident: f.registry.incidents[f.incident.id],
      issue: f.issue,
      observation,
      now: f.now,
    })
  );
  assert.equal(f.calls.length, 0);
});
test("recovered receipt remains eligible but invalid issue numbers and input types are refused", async () => {
  const f = fixture();
  f.incident.recovered = true;
  assert.equal((await run(f)).outcome, "acknowledgment_preview");
  for (const issueNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "65"]) {
    await assert.rejects(run(f, { issueNumber, dryRun: false }));
  }
  await assert.rejects(run(f, { dryRun: "false" }));
});
test("intent write failure cannot close an issue", async () => {
  const f = fixture();
  f.store.save = async () => {
    throw Error("unavailable registry");
  };
  await assert.rejects(run(f, { dryRun: false }));
  assert.equal(f.issue.state, "open");
  assert.ok(!f.calls.some((c) => c.method === "PATCH"));
});
test("expired evidence during publication holds intent and leaves issue open", async () => {
  const f = fixture();
  let time = at;
  f.now = () => time;
  f.afterIntent = () => {
    time = "2026-11-16T08:11:00.000Z";
  };
  await assert.rejects(run(f, { dryRun: false }));
  assert.equal(f.issue.state, "open");
  assert.equal(f.registry.active, f.incident.id);
});
test("a final write accepted with a lost response is read-only on retry", async () => {
  const f = fixture(),
    save = f.store.save;
  let lost = true;
  f.store.save = async (next, parent) => {
    const commit = await save(next, parent);
    if (next.active === null && lost) {
      lost = false;
      throw Error("lost accepted response");
    }
    return commit;
  };
  await assert.rejects(run(f, { dryRun: false }));
  assert.equal(f.registry.active, null);
  const writes = f.calls.filter((c) => c.method !== "GET").length;
  assert.equal((await run(f, { dryRun: false })).outcome, "already_acknowledged");
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, writes);
});
test("registry refuses mixing acknowledgments with repair or contract evidence", async () => {
  const f = fixture();
  await run(f, { dryRun: false });
  const validate = require("../factory/monitor-state.cjs").validateMonitorState;
  for (const change of [
    (i) => (i.probeMode = "feed-contract"),
    (i) => (i.retirement = {}),
    (i) => (i.criteriaHash = "0".repeat(64)),
    (i) => (i.acknowledgment.actor = "outsider"),
    (i) => (i.acknowledgment.extra = "untrusted"),
  ]) {
    const r = structuredClone(f.registry);
    change(r.incidents[f.incident.id]);
    assert.throws(() => validate(r));
  }
});
test("availability finishes before starting the shared metadata publication deadline", async () => {
  const f = fixture();
  let availabilityFinished = false;
  const request = f.api.request;
  f.api.request = async (...args) => {
    assert.equal(
      availabilityFinished,
      true,
      "metadata deadline must not include availability retries"
    );
    return request(...args);
  };
  await run(f, {
    dryRun: false,
    probe: async () => {
      availabilityFinished = true;
      return f.observation;
    },
  });
  assert.equal(f.registry.active, null);
});
