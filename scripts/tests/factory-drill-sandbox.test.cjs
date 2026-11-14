const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");

function implementation(name) {
  const target = path.join(__dirname, "../factory", name);
  assert.ok(fs.existsSync(target), `Missing drill implementation: ${name}`);
  return require(target);
}
const HEAD = "a".repeat(40);
const WORKFLOW = "b".repeat(40);
const GRANT = "12345678-1234-4234-8234-123456789abc";
const SOURCE =
  'module.exports = (available) => ({ statusCode: available ? 200 : 503, body: { status: available ? "ok" : "unavailable" } });\n';
const identity = {
  grantId: GRANT,
  head: HEAD,
  seedSha: HEAD,
  workflowSha: WORKFLOW,
  runId: "1234",
  runAttempt: 1,
};
const makeBundle = () => ({
  kind: "code",
  grantId: GRANT,
  base: HEAD,
  files: [{ path: "backend/factory-drill/readiness.cjs", mode: "100644", content: SOURCE }],
  evidence: "Trusted verifier supplies measured results.",
});
const observation = (healthy) => ({
  healthy,
  checks: {
    health: "ok",
    readiness: healthy ? "ok" : "failed",
    frontend: "ok",
    regression: healthy ? "ok" : "failed",
  },
  attempts: 1,
  release: HEAD,
});

test("bundle verification binds exactly one regular implementation to its grant and base", () => {
  const { verifyBundle } = implementation("drill-verify.cjs");
  const bundle = makeBundle();
  assert.deepEqual(verifyBundle({ bundle, grantId: GRANT, head: HEAD }), {
    source: SOURCE,
    bundleSha256: createHash("sha256").update(JSON.stringify(bundle)).digest("hex"),
  });
});

test("bundle verification rejects changed tests, extra files, links, deletions and forged identity", () => {
  const { verifyBundle } = implementation("drill-verify.cjs");
  const changes = [
    (b) => b.files.push({ ...b.files[0], path: "src/__tests__/factory-drill-readiness.test.ts" }),
    (b) => (b.files[0].path = "src/__tests__/factory-drill-readiness.test.ts"),
    (b) => (b.files[0].mode = "120000"),
    (b) => (b.files[0].deleted = true),
    (b) => (b.files[0].extra = "forged"),
    (b) => (b.files[0].content = "x\0y"),
    (b) => (b.files[0].content = "\uFFFD"),
    (b) => (b.files[0].content = "\ud800"),
    (b) => (b.files[0].content = "x".repeat(32769)),
    (b) => (b.files[0].content = ""),
    (b) => (b.files[0].content = "github_pat_" + "a".repeat(40)),
    (b) => (b.base = WORKFLOW),
    (b) => (b.grantId = "wrong"),
    (b) => (b.kind = "review"),
    (b) => (b.healthy = true),
    (b) => (b.evidence = "x".repeat(20001)),
  ];
  for (const change of changes) {
    const bundle = makeBundle();
    change(bundle);
    assert.throws(() => verifyBundle({ bundle, grantId: GRANT, head: HEAD }));
  }
});

test("repair measures baseline before candidate and never treats model evidence as a result", async () => {
  const { verifyRepair, validateReport } = implementation("drill-verify.cjs");
  const { brokenSource } = implementation("drill-fixture.cjs");
  const calls = [];
  const bundle = makeBundle();
  const report = await verifyRepair({
    ...identity,
    bundle,
    check: async (source, options) => {
      calls.push({ source, release: options.release });
      return observation(calls.length === 2);
    },
    now: () => "2026-11-14T12:00:00.000Z",
  });
  assert.deepEqual(calls, [
    { source: brokenSource, release: HEAD },
    { source: SOURCE, release: HEAD },
  ]);
  assert.deepEqual(report, {
    version: 1,
    synthetic: true,
    runId: "1234",
    runAttempt: 1,
    workflowSha: WORKFLOW,
    seedSha: HEAD,
    grantId: GRANT,
    bundleSha256: createHash("sha256").update(JSON.stringify(bundle)).digest("hex"),
    baseline: observation(false),
    candidate: observation(true),
    healthy: true,
    startedAt: "2026-11-14T12:00:00.000Z",
    finishedAt: "2026-11-14T12:00:00.000Z",
  });
  assert.deepEqual(
    validateReport(report, { ...identity, bundleSha256: report.bundleSha256 }),
    report
  );
});

test("repair refuses a healthy or differently broken baseline before running candidate", async () => {
  const { verifyRepair } = implementation("drill-verify.cjs");
  for (const baseline of [
    observation(true),
    { ...observation(false), checks: { ...observation(false).checks, health: "failed" } },
  ]) {
    let calls = 0;
    await assert.rejects(
      verifyRepair({
        ...identity,
        bundle: makeBundle(),
        check: async () => {
          calls++;
          return baseline;
        },
      }),
      /baseline|observation/i
    );
    assert.equal(calls, 1);
  }
});

test("failed candidate produces a bounded unhealthy report without publishing model evidence", async () => {
  const { verifyRepair } = implementation("drill-verify.cjs");
  const report = await verifyRepair({
    ...identity,
    bundle: makeBundle(),
    check: async () => observation(false),
  });
  assert.equal(report.healthy, false);
  assert.deepEqual(report.candidate, observation(false));
  assert.equal(JSON.stringify(report).includes("Trusted verifier supplies"), false);
});

test("report validation rejects forged shape, checks, release, identity and timestamp", async () => {
  const { verifyRepair, validateReport } = implementation("drill-verify.cjs");
  let count = 0;
  const original = await verifyRepair({
    ...identity,
    bundle: makeBundle(),
    check: async () => observation(++count === 2),
    now: () => "2026-11-14T12:00:00.000Z",
  });
  const changes = [
    (r) => (r.synthetic = false),
    (r) => (r.version = 2),
    (r) => (r.runAttempt = 2),
    (r) => (r.runId = "5678"),
    (r) => (r.workflowSha = HEAD),
    (r) => (r.seedSha = WORKFLOW),
    (r) => (r.grantId = "wrong"),
    (r) => (r.bundleSha256 = "c".repeat(64)),
    (r) => (r.extra = "secret"),
    (r) => (r.startedAt = "yesterday"),
    (r) => (r.finishedAt = "2026-11-14T11:59:59.999Z"),
    (r) => (r.baseline = observation(true)),
    (r) => (r.candidate.checks.regression = "failed"),
    (r) => (r.candidate.checks.health = "maybe"),
    (r) => (r.candidate.rawOutput = "secret"),
    (r) => (r.candidate.release = WORKFLOW),
    (r) => (r.healthy = false),
  ];
  for (const change of changes) {
    const report = structuredClone(original);
    change(report);
    assert.throws(() =>
      validateReport(report, { ...identity, bundleSha256: original.bundleSha256 })
    );
  }
});

test("loopback transport rejects arbitrary destinations and forwards only safe fixed requests", async () => {
  const { createLoopbackFetch } = implementation("drill/oracle.cjs");
  const calls = [];
  const transport = createLoopbackFetch(async (url, options) => {
    calls.push({ url, options });
    return new Response("ok");
  });
  const signal = new AbortController().signal;
  await transport("https://haide-software-factory.onrender.com/healthz", {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    signal,
    headers: { Accept: "application/json" },
  });
  assert.equal(calls[0].url, "http://127.0.0.1:18765/healthz");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  for (const url of [
    "https://evil.invalid/healthz",
    "https://haide-software-factory.onrender.com/readyz?x=1",
    "http://127.0.0.1:1/",
    "https://haide-software-factory.onrender.com//healthz",
  ])
    await assert.rejects(transport(url, { method: "GET" }));
  await assert.rejects(
    transport("https://haide-software-factory.onrender.com/healthz", { method: "POST" })
  );
  assert.equal(calls.length, 1);
});

test("sandbox invokes only bounded Docker with source-only read-only mount and root oracle stdin", async () => {
  const { checkFixture } = implementation("drill-sandbox.cjs");
  const calls = [];
  const output = await checkFixture(SOURCE, {
    release: HEAD,
    run: async (args, options) => {
      calls.push({ args, options });
      if (args[0] === "run") {
        const mount = args[args.indexOf("--mount") + 1];
        const sourcePath = /source=([^,]+),/.exec(mount)[1];
        assert.equal(fs.readFileSync(sourcePath, "utf8"), SOURCE);
        assert.equal(fs.statSync(sourcePath).isFile(), true);
        return { stdout: "container-id\n" };
      }
      return { stdout: args[0] === "exec" ? JSON.stringify(observation(true)) : "" };
    },
  });
  assert.deepEqual(output, observation(true));
  const args = calls[0].args;
  for (const [flag, value] of [
    ["--network", "none"],
    ["--user", "10001:10001"],
    ["--cap-drop", "ALL"],
    ["--pids-limit", "32"],
    ["--memory", "128m"],
    ["--memory-swap", "128m"],
    ["--cpus", "0.5"],
    ["--security-opt", "no-new-privileges=true"],
    ["--log-driver", "none"],
  ])
    assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes("--read-only"));
  assert.equal(args.filter((a) => a === "--mount").length, 1);
  assert.match(args[args.indexOf("--mount") + 1], /target=\/candidate\/readiness\.cjs,readonly$/);
  assert.ok(args.some((a) => /^node:22\.20\.0-alpine@sha256:[a-f0-9]{64}$/.test(a)));
  const oracle = calls.find((c) => c.args[0] === "exec");
  assert.equal(oracle.args[oracle.args.indexOf("--user") + 1], "0:0");
  assert.ok(oracle.args.includes("--interactive"));
  assert.match(oracle.options.input, /probeApp/);
  assert.ok(
    calls.every(
      (c) => c.options.timeout > 0 && c.options.timeout <= 60000 && c.options.maxBuffer <= 8192
    )
  );
  assert.ok(
    calls.every((c) =>
      Object.keys(c.options.env).every((key) =>
        ["PATH", "SystemRoot", "WINDIR", "HOME"].includes(key)
      )
    )
  );
  assert.equal(calls.at(-1).args[0], "rm");
});

test("sandbox strips invalid oracle output and always removes the container", async () => {
  const { checkFixture } = implementation("drill-sandbox.cjs");
  for (const output of [
    '{"healthy":true,"secret":"do-not-log"}',
    "do-not-log",
    JSON.stringify({ ...observation(true), extra: "do-not-log" }),
  ]) {
    const calls = [];
    const result = await checkFixture(SOURCE, {
      release: HEAD,
      run: async (args) => {
        calls.push(args);
        return { stdout: args[0] === "exec" ? output : "" };
      },
    });
    assert.equal(result.healthy, false);
    assert.equal(
      Object.values(result.checks).every((v) => v === "failed"),
      true
    );
    assert.equal(JSON.stringify(result).includes("do-not-log"), false);
    assert.equal(calls.at(-1)[0], "rm");
  }
});

test("invalid fixture source or release is rejected before Docker executes", async () => {
  const { checkFixture } = implementation("drill-sandbox.cjs");
  let calls = 0;
  const run = async () => {
    calls++;
  };
  for (const [source, release] of [
    ["", HEAD],
    ["x\0", HEAD],
    ["x".repeat(32769), HEAD],
    [SOURCE, "main"],
  ])
    await assert.rejects(checkFixture(source, { release, run }));
  assert.equal(calls, 0);
});

test("verification CLI checks bounded regular input files and refuses credentialed environments", async () => {
  const { main } = implementation("drill-verify.cjs");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "drill-cli-test-"));
  try {
    const input = path.join(folder, "input.json");
    const bundle = path.join(folder, "bundle.json");
    const report = path.join(folder, "report.json");
    fs.writeFileSync(input, JSON.stringify(identity));
    fs.writeFileSync(bundle, JSON.stringify(makeBundle()));
    const env = {
      FACTORY_DRILL_INPUT: input,
      FACTORY_DRILL_BUNDLE: bundle,
      FACTORY_DRILL_REPORT: report,
    };
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "DATABASE_URL",
      "TEST_DATABASE_URL",
      "RENDER_DEPLOY_HOOK",
      "RENDER_DEPLOY_HOOK_URL",
      "FACTORY_GITHUB_APP_PRIVATE_KEY",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_FEDERATION_TOKEN_FILE",
      "CLAUDE_CODE_API_KEY_HELPER",
    ]) {
      await assert.rejects(
        main({
          ...env,
          FACTORY_DRILL_INPUT: path.join(folder, "never-read.json"),
          [key]: "forbidden",
        }),
        /credential/i
      );
      assert.equal(fs.existsSync(report), false);
    }
    fs.writeFileSync(bundle, "x".repeat(80001));
    await assert.rejects(main(env), /bounded|size/i);
    assert.equal(fs.existsSync(report), false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test(
  "Docker baseline is red and a repaired fixture is green",
  { skip: process.env.FACTORY_DRILL_DOCKER_TEST !== "true", timeout: 180000 },
  async () => {
    const { checkFixture } = implementation("drill-sandbox.cjs");
    const { brokenSource } = implementation("drill-fixture.cjs");
    assert.deepEqual(await checkFixture(brokenSource, { release: HEAD }), observation(false));
    assert.deepEqual(await checkFixture(SOURCE, { release: HEAD }), observation(true));
  }
);

test(
  "Docker rejects readiness return fields that fail the seeded exact regression contract",
  { skip: process.env.FACTORY_DRILL_DOCKER_TEST !== "true", timeout: 180000 },
  async () => {
    const { checkFixture } = implementation("drill-sandbox.cjs");
    for (const source of [
      'module.exports = (available) => ({ statusCode: available ? 200 : 503, body: { status: available ? "ok" : "unavailable" }, extra: true });',
      'module.exports = (available) => ({ statusCode: available ? 200 : 503, body: { status: available ? "ok" : "unavailable", extra: true } });',
      'Object.keys = Reflect.ownKeys = (value) => value.statusCode ? ["statusCode", "body"] : ["status"]; Object.hasOwn = () => true; module.exports = (available) => ({ statusCode: available ? 200 : 503, body: { status: available ? "ok" : "unavailable" }, extra: true });',
    ]) {
      assert.deepEqual(await checkFixture(source, { release: HEAD }), observation(false));
    }
  }
);

test(
  "Docker trusted wrapper keeps its HTTP and serialization functions when candidate globals change",
  { skip: process.env.FACTORY_DRILL_DOCKER_TEST !== "true", timeout: 180000 },
  async () => {
    const { checkFixture } = implementation("drill-sandbox.cjs");
    const source = `require('node:http').createServer = () => { throw new Error('replaced'); };
JSON.stringify = () => 'forged';
Object.keys = Reflect.ownKeys = () => [];
Object.hasOwn = () => false;
Array.isArray = () => true;
globalThis.URL = class { constructor() { throw new Error('replaced'); } };
${SOURCE}`;
    assert.deepEqual(await checkFixture(source, { release: HEAD }), observation(true));
  }
);

test(
  "Docker candidate cannot forge oracle output or modify mounted evidence",
  { skip: process.env.FACTORY_DRILL_DOCKER_TEST !== "true", timeout: 180000 },
  async () => {
    const { checkFixture } = implementation("drill-sandbox.cjs");
    const malicious = `const fs = require('node:fs'); console.log(${JSON.stringify(JSON.stringify(observation(true)))}); try { fs.writeFileSync('/candidate/readiness.cjs', 'forged'); } catch {} module.exports = () => ({statusCode: 200, body: {status: 'broken'}});`;
    const result = await checkFixture(malicious, { release: HEAD });
    assert.equal(result.healthy, false);
    assert.equal(result.checks.health, "ok");
    assert.equal(result.checks.frontend, "ok");
    assert.equal(result.checks.readiness, "failed");
    assert.equal(result.checks.regression, "failed");
  }
);

test(
  "Docker candidate cannot access root oracle private proc files, signal it, or see host credentials",
  { skip: process.env.FACTORY_DRILL_DOCKER_TEST !== "true", timeout: 180000 },
  async () => {
    const { checkFixture } = implementation("drill-sandbox.cjs");
    // A containment escape makes this adversarial fixture green and fails the test.
    const source = `const fs = require('node:fs');
module.exports = (available) => {
  let escaped = process.getuid() === 0 || !!process.env.FACTORY_DRILL_SECRET_CANARY;
  escaped ||= Object.keys(require('node:os').networkInterfaces()).some(name => name !== 'lo');
  try { fs.writeFileSync('/candidate/readiness.cjs', 'forged'); escaped = true; } catch {}
  for (const pid of fs.readdirSync('/proc').filter(name => /^[0-9]+$/.test(name))) {
    try {
      if (!/^Uid:\\s+0\\s/m.test(fs.readFileSync('/proc/' + pid + '/status', 'utf8'))) continue;
      try { fs.readFileSync('/proc/' + pid + '/environ'); escaped = true; } catch {}
      try { process.kill(Number(pid), 0); escaped = true; } catch {}
      let fd;
      try { fd = fs.openSync('/proc/' + pid + '/fd/0', fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); escaped = true; } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
    } catch {}
  }
  return {statusCode: available ? 200 : 503, body: {status: available && escaped ? 'ok' : 'unavailable'}};
};`;
    const oldCanary = process.env.FACTORY_DRILL_SECRET_CANARY;
    process.env.FACTORY_DRILL_SECRET_CANARY = "must-stay-on-host";
    try {
      assert.deepEqual(await checkFixture(source, { release: HEAD }), observation(false));
    } finally {
      if (oldCanary === undefined) delete process.env.FACTORY_DRILL_SECRET_CANARY;
      else process.env.FACTORY_DRILL_SECRET_CANARY = oldCanary;
    }
  }
);

test(
  "Docker CLI writes measured success and failure reports outside the sandbox",
  { skip: process.env.FACTORY_DRILL_DOCKER_TEST !== "true", timeout: 180000 },
  async () => {
    const { main, validateReport, verifyBundle } = implementation("drill-verify.cjs");
    const { brokenSource } = implementation("drill-fixture.cjs");
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "drill-cli-integration-"));
    try {
      const inputPath = path.join(folder, "identity.json");
      const bundlePath = path.join(folder, "bundle.json");
      fs.writeFileSync(inputPath, JSON.stringify(identity));
      for (const [content, code] of [
        [SOURCE, 0],
        [brokenSource, 1],
      ]) {
        const bundle = makeBundle();
        bundle.files[0].content = content;
        fs.writeFileSync(bundlePath, JSON.stringify(bundle));
        const reportPath = path.join(folder, `report-${code}.json`);
        assert.equal(
          await main(
            {
              FACTORY_DRILL_INPUT: inputPath,
              FACTORY_DRILL_BUNDLE: bundlePath,
              FACTORY_DRILL_REPORT: reportPath,
            },
            "verify"
          ),
          code
        );
        const report = validateReport(JSON.parse(fs.readFileSync(reportPath, "utf8")), {
          ...identity,
          bundleSha256: verifyBundle({ bundle, grantId: GRANT, head: HEAD }).bundleSha256,
        });
        assert.equal(report.healthy, code === 0);
      }
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
);
