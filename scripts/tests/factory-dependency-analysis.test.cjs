const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  inspectUpdate,
  queryOsv,
  validateReport,
  reportFor,
} = require("../factory/dependency-analysis.cjs");
const tools = require("../factory/dependency-analysis.cjs").toolsAt(
  require("node:path").resolve(__dirname, "../factory/dependency-tools")
);
const sri = "sha512-" + Buffer.alloc(64, 1).toString("base64");
const manifest = (version = "^1.0.0", extra = {}) =>
  JSON.stringify({
    name: "demo",
    scripts: { test: "vitest" },
    dependencies: { foo: version },
    ...extra,
  });
const lock = (version = "1.0.0", edges = "") =>
  '"foo@^1.0.0":\n  version "' +
  version +
  '"\n  resolved "https://registry.npmjs.org/foo/-/foo-' +
  version +
  '.tgz"\n  integrity ' +
  sri +
  "\n" +
  edges;
const inspect = (a = lock(), b = lock("1.0.1"), ma = manifest(), mb = ma) =>
  inspectUpdate(ma, mb, a, b, tools);

test("changed parent selector cannot hide a major child edge", () => {
  const children =
    '\n"bar@^1.0.0":\n  version "1.0.0"\n  resolved "https://registry.npmjs.org/bar/-/bar-1.0.0.tgz"\n  integrity ' +
    sri +
    '\n\n"bar@^2.0.0":\n  version "2.0.0"\n  resolved "https://registry.npmjs.org/bar/-/bar-2.0.0.tgz"\n  integrity ' +
    sri +
    "\n";
  const old = lock("1.0.0", '  dependencies:\n    bar "^1.0.0"\n') + children;
  const next =
    lock("1.1.0", '  dependencies:\n    bar "^2.0.0"\n').replace("foo@^1.0.0", "foo@^1.1.0") +
    children;
  assert.throws(() => inspect(old, next, manifest(), manifest("^1.1.0")), /major|edge/i);
});
test("registry URL must name the claimed package and new packages cannot be prereleases", () => {
  assert.throws(
    () => inspect(lock(), lock("1.0.1").replace("/foo/-/foo-", "/wrong/-/wrong-")),
    /registry|source/i
  );
  const pre =
    '\n"bar@*":\n  version "1.0.0-beta.1"\n  resolved "https://registry.npmjs.org/bar/-/bar-1.0.0-beta.1.tgz"\n  integrity ' +
    sri +
    "\n";
  assert.throws(() => inspect(lock(), lock("1.0.1") + pre), /version/i);
});
test("new selectors remain compatible when an unrelated legacy alias exists", () => {
  const alias =
    '\n"legacy@npm:bar@^1.0.0":\n  version "1.0.0"\n  resolved "https://registry.npmjs.org/bar/-/bar-1.0.0.tgz"\n  integrity ' +
    sri +
    "\n";
  assert.equal(
    inspect(
      lock() + alias,
      lock("1.1.0").replace("foo@^1.0.0", "foo@^1.1.0") + alias,
      manifest(),
      manifest("^1.1.0")
    ).changed,
    2
  );
});
test("unchanged legacy npm aliases do not block unrelated security patches", () => {
  const alias =
    '\n"legacy@npm:bar@^1.0.0":\n  version "1.0.0"\n  resolved "https://registry.npmjs.org/bar/-/bar-1.0.0.tgz"\n  integrity ' +
    sri +
    "\n";
  assert.equal(inspect(lock() + alias, lock("1.0.1") + alias).queries.length, 2);
});
test("lock-only patch produces actual added and removed version queries", () => {
  const r = inspect();
  assert.deepEqual(r.queries, [
    { name: "foo", version: "1.0.0", side: "removed" },
    { name: "foo", version: "1.0.1", side: "added" },
  ]);
});
test("root scripts, names and unsupported major or downgrade cannot enter review", () => {
  assert.throws(() => inspect(lock(), lock("2.0.0")), /major|version/i);
  assert.throws(() => inspect(lock("1.0.1"), lock()), /downgrade/i);
  assert.throws(
    () =>
      inspect(
        lock(),
        lock("1.0.1"),
        manifest(),
        manifest("^1.0.0", { scripts: { test: "steal" } })
      ),
    /manifest/i
  );
  assert.throws(
    () =>
      inspect(lock(), lock(), manifest(), JSON.stringify({ dependencies: { injected: "1.0.0" } })),
    /manifest/i
  );
});
test("new lock entries need trusted registry and integrity", () => {
  assert.throws(
    () => inspect(lock(), lock("1.0.1").replace("registry.npmjs.org", "evil.invalid")),
    /registry/i
  );
  assert.throws(() => inspect(lock(), lock("1.0.1").replace(sri, "missing")), /integrity/i);
  assert.throws(
    () => inspect(lock(), lock("1.0.1") + '\n__proto__:\n  polluted "yes"\n'),
    /unsafe|lock/i
  );
});
test("changed dependency edge cannot hide a major already elsewhere in the graph", () => {
  const old =
    lock("1.0.0", '  dependencies:\n    bar "^1.0.0"\n') +
    '\n"bar@^1.0.0":\n  version "1.0.0"\n  resolved "https://registry.npmjs.org/bar/-/bar-1.0.0.tgz"\n  integrity ' +
    sri +
    '\n\n"bar@^2.0.0":\n  version "2.0.0"\n  resolved "https://registry.npmjs.org/bar/-/bar-2.0.0.tgz"\n  integrity ' +
    sri +
    "\n";
  assert.throws(() => inspect(old, old.replace('bar "^1.0.0"', 'bar "^2.0.0"')), /major|edge/i);
});
test("OSV response binds each package and rejects affected added versions", async () => {
  const q = inspect().queries;
  const transport = async (url, options) => {
    assert.equal(url, "https://api.osv.dev/v1/querybatch");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(JSON.parse(options.body).queries[0].version, "1.0.0");
    return new Response(JSON.stringify({ results: [{ vulns: [{ id: "CVE-2026-12345" }] }, {}] }));
  };
  assert.deepEqual((await queryOsv(q, transport)).fixed, ["CVE-2026-12345"]);
  await assert.rejects(
    queryOsv(
      q,
      async () =>
        new Response(JSON.stringify({ results: [{}, { vulns: [{ id: "GHSA-aaaa-bbbb-cccc" }] }] }))
    ),
    /vulnerab/i
  );
});
test("OSV missing, partial, oversized and unavailable evidence fail closed", async () => {
  for (const body of [
    { results: [] },
    { results: [{}, { next_page_token: "more" }] },
    { results: [{}, { vulns: "bad" }] },
  ])
    await assert.rejects(
      queryOsv(inspect().queries, async () => new Response(JSON.stringify(body))),
      /OSV|partial|response/i
    );
  await assert.rejects(
    queryOsv(inspect().queries, async () => new Response("", { status: 503 })),
    /OSV/i
  );
  await assert.rejects(
    queryOsv(inspect().queries, async () => {
      throw Error("private transport secret");
    }),
    /OSV/
  );
});
const identity = {
  repository: "haideearus/cypress-realworld-app",
  pr: 52,
  base: "a".repeat(40),
  head: "b".repeat(40),
  workflowSha: "c".repeat(40),
  runId: "123",
  runAttempt: 1,
  stage: "analysis",
  toolDigest: "d".repeat(64),
};
test("report cannot be replayed for another PR, stage, producer or stale time", () => {
  const r = reportFor(identity, { changed: 2, fixed: [] }, new Date("2026-11-15T10:00:00Z"));
  assert.equal(validateReport(r, identity, new Date("2026-11-15T10:01:00Z")).head, identity.head);
  for (const changes of [
    { pr: 53 },
    { stage: "premerge" },
    { runId: "456" },
    { toolDigest: "e".repeat(64) },
  ])
    assert.throws(() =>
      validateReport(r, { ...identity, ...changes }, new Date("2026-11-15T10:01:00Z"))
    );
  assert.throws(() => validateReport(r, identity, new Date("2026-11-15T10:06:00Z")), /stale|time/i);
});
