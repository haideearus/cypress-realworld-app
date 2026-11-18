const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const c = require("../factory/discovery-contract.cjs");
const o = require("../factory/discovery-oracles.cjs");
const { diagnostic } = require("../factory/discovery-diagnostics.cjs");
const source = require("./fixtures/discovery-recovery-source.json");
let assessCandidates;
try {
  ({ assessCandidates } = require("../factory/discovery-replay.cjs"));
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
const image = `sha256:${"a".repeat(64)}`;
function temp(t) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-replay-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(output)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(output).startsWith("discovery-replay-test-"));
    fs.rmSync(output, { recursive: true, force: true });
  });
  return output;
}
function oneFinding() {
  const bundle = structuredClone(source);
  bundle.report.findings = [bundle.report.findings[1]];
  return bundle;
}
function observation(oracle) {
  const expected =
    oracle.kind === "bank-account-isolation"
      ? {
          id: "account",
          userId: "owner",
          bankName: "Synthetic bank",
          accountNumber: "1234",
          routingNumber: "5678",
          isDeleted: false,
        }
      : {
          id: "transaction",
          senderId: "sender",
          receiverId: "receiver",
          privacyLevel: "private",
          amount: 100,
          description: "Synthetic payment",
        };
  const owners = expected.userId ? [expected.userId] : [expected.senderId, expected.receiverId];
  return o.observe(oracle, 200, {
    expected,
    readerId: "reader",
    controls: owners.map((userId) => ({ userId, status: 200, resource: expected })),
    result: { present: true, denial: null, resource: expected },
  });
}
function fakeRun(calls, change = () => {}) {
  return async (args) => {
    calls.push(args);
    if (args.oracle) {
      const result = { image, networkIsolated: true, observation: observation(args.oracle) };
      change(result, calls.length);
      return result;
    }
    const log = "Synthetic isolated assertion failed";
    const result = {
      version: 1,
      image,
      mode: args.request.mode,
      file: args.request.file,
      code: 1,
      exitState: { status: "exited", exitCode: 1, oomKilled: false },
      log,
      logHash: c.digest(log),
      networkIsolated: true,
    };
    change(result, calls.length);
    return result;
  };
}
test("saved source selects corrected latest batch and preserves every report and batch hash", async (t) => {
  const bundle = structuredClone(source),
    saved = JSON.stringify(bundle),
    calls = [];
  const result = await assessCandidates({
    bundle,
    image,
    output: temp(t),
    run: fakeRun(calls),
    now: () => 1000,
  });
  assert.equal(result.findings.length, 2);
  assert.deepEqual(
    result.findings.map((x) => x.original.number),
    [1, 3]
  );
  assert.equal(
    result.findings[1].original.testHash,
    "de6178f6cbe689c0faefc7fa04367a2e93bf1db3569c2cb5b61776aecdc72f85"
  );
  assert.deepEqual(
    result.findings.map((x) => x.status),
    ["verified", "verified"]
  );
  assert.equal(calls.length, 8);
  assert.equal(JSON.stringify(bundle), saved);
  assert.deepEqual(result.report, source.report);
  assert.deepEqual(
    result.actualBatches.map((x) => x.number),
    [1, 2, 3]
  );
  assert.deepEqual(
    result.actualBatches.map((x) => x.testHash),
    source.batches.map((x) => x.testHash)
  );
  assert.equal(result.coverageComplete, false);
  assert.equal(result.publication, "not-installed");
  assert.equal(result.source, "claude-subscription");
  assert.equal(result.fixture, false);
  for (const call of calls.filter((x) => x.request)) {
    const original = result.findings.find((x) => x.finding.test === call.request.file).original;
    assert.equal(fs.readFileSync(path.join(call.tests, call.request.file), "utf8"), original.test);
  }
});
test("latest batch is determined by execution number even when records are reordered", async (t) => {
  const bundle = oneFinding();
  bundle.batches.reverse();
  const result = await assessCandidates({ bundle, image, output: temp(t), run: fakeRun([]) });
  assert.equal(result.findings[0].original.number, 3);
});
test("a latest passing, timed-out, OOM or unisolated revision cannot reuse older RED", async (t) => {
  for (const patch of [
    { code: 0 },
    { code: 124 },
    { code: -1 },
    { code: "1" },
    { networkIsolated: false },
    { exitState: { status: "exited", exitCode: 1, oomKilled: true } },
  ]) {
    const bundle = oneFinding(),
      calls = [];
    Object.assign(bundle.batches[2].result, patch);
    await assert.rejects(assessCandidates({ bundle, image, output: temp(t), run: fakeRun(calls) }));
    assert.equal(calls.length, 0);
  }
});
test("invalid test or result log hashes and missing execution numbers fail before any run", async (t) => {
  for (const mutate of [
    (b) => {
      b.batches[2].test += "// changed";
    },
    (b) => {
      b.batches[2].result.log += "changed";
    },
    (b) => {
      delete b.batches[2].number;
    },
    (b) => {
      b.report.head = "b".repeat(40);
    },
    (b) => {
      b.report.grantId = "wrong";
    },
    (b) => {
      b.report.findings[0].test = "../escape.api.test.cjs";
    },
  ]) {
    const bundle = oneFinding(),
      calls = [];
    mutate(bundle);
    await assert.rejects(assessCandidates({ bundle, image, output: temp(t), run: fakeRun(calls) }));
    assert.equal(calls.length, 0);
  }
});
test("all four runs share a five-minute per-finding deadline and check before every run", async (t) => {
  const calls = [];
  let clock = 1000,
    admissions = 0;
  const run = fakeRun(calls, () => {
    clock += 1000;
  });
  await assessCandidates({
    bundle: oneFinding(),
    image,
    output: temp(t),
    now: () => clock,
    before: async () => {
      admissions++;
    },
    run,
  });
  assert.equal(admissions, 4);
  assert.deepEqual(
    calls.map((x) => x.deadlineAt),
    [301000, 301000, 301000, 301000]
  );
  assert.equal(calls.filter((x) => x.request).length, 2);
  assert.equal(calls.filter((x) => x.oracle).length, 2);
});
test("admission veto fails closed during proposal and oracle replay", async (t) => {
  for (const stopAt of [1, 3, 4]) {
    let admissions = 0;
    const calls = [],
      error = new Error("stop");
    await assert.rejects(
      assessCandidates({
        bundle: oneFinding(),
        image,
        output: temp(t),
        run: fakeRun(calls),
        before: async () => {
          if (++admissions === stopAt) throw error;
        },
      }),
      (caught) => {
        assert.equal(caught, error);
        assert.equal(
          diagnostic("discovery", caught).stage,
          stopAt < 3 ? "proposal-replay" : "oracle-replay"
        );
        return true;
      }
    );
    assert.equal(calls.length, stopAt - 1);
  }
});
test("expired shared deadline prevents any further run", async (t) => {
  const calls = [];
  let clock = 1000;
  await assert.rejects(
    assessCandidates({
      bundle: oneFinding(),
      image,
      output: temp(t),
      now: () => clock,
      run: fakeRun(calls, () => {
        clock += 300000;
      }),
    }),
    /deadline/i
  );
  assert.equal(calls.length, 1);
});
test("proposal code remains inert on the host and existing per-finding paths are never overwritten", async (t) => {
  const output = temp(t),
    marker = path.join(output, "host-ran"),
    bundle = oneFinding();
  bundle.batches[2].test = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`;
  bundle.batches[2].testHash = c.digest(bundle.batches[2].test);
  await assessCandidates({ bundle, image, output, run: fakeRun([]) });
  assert.equal(fs.existsSync(marker), false);
  const calls = [];
  await assert.rejects(assessCandidates({ bundle, image, output, run: fakeRun(calls) }));
  assert.equal(calls.length, 0);
});
test("non-failing or unsafe proposal replays are held without oracle executions", async (t) => {
  for (const patch of [
    { code: 0 },
    { code: 124 },
    { networkIsolated: false },
    { exitState: { status: "exited", exitCode: 1, oomKilled: true } },
  ]) {
    const calls = [];
    const result = await assessCandidates({
      bundle: oneFinding(),
      image,
      output: temp(t),
      run: fakeRun(calls, (value) => Object.assign(value, patch)),
    });
    assert.equal(result.findings[0].status, "held");
    assert.equal(calls.length, 2);
  }
});
test("unisolated trusted oracle responses cannot verify a finding", async (t) => {
  const result = await assessCandidates({
    bundle: oneFinding(),
    image,
    output: temp(t),
    run: fakeRun([], (value) => {
      if (value.observation) value.networkIsolated = false;
    }),
  });
  assert.equal(result.findings[0].status, "held");
});
