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

const childLock = (range, version) =>
  `\n"bar@${range}":\n  version "${version}"\n  resolved "https://registry.npmjs.org/bar/-/bar-${version}.tgz"\n  integrity ${sri}\n`;

test("deduplication queries the retained candidate version as well as removed identities", () => {
  const previous =
    lock("1.0.0", '  dependencies:\n    bar "^1.0.0"\n') +
    childLock("^1.0.0", "1.0.0") +
    childLock("~1.0.1", "1.0.1");
  const candidate =
    lock("1.0.1", '  dependencies:\n    bar "~1.0.1"\n') + childLock("~1.0.1", "1.0.1");
  const result = inspect(previous, candidate);
  assert.ok(
    result.queries.some((q) => q.name === "bar" && q.version === "1.0.1" && q.side === "retained"),
    "retained replacement missing from candidate advisory checks"
  );
  assert.equal(result.candidateVersions, 2);
});

test("a root transition between existing versions still requires candidate checks", () => {
  const both = lock() + lock("1.1.0").replace("foo@^1.0.0", "foo@^1.1.0");
  const result = inspect(both, both, manifest(), manifest("^1.1.0"));
  assert.ok(result.changed > 0);
  assert.deepEqual(
    result.queries.map((q) => [q.name, q.version, q.side]),
    [
      ["foo", "1.0.0", "baseline"],
      ["foo", "1.1.0", "retained"],
    ]
  );
});

test("all remaining versions of an affected name are checked, while unrelated baseline packages stay out of scope", () => {
  const unrelated = childLock("^1.0.0", "1.0.0");
  const otherFoo = lock("1.1.0").replace("foo@^1.0.0", "foo@^1.1.0");
  const result = inspect(lock() + otherFoo + unrelated, lock("1.0.1") + otherFoo + unrelated);
  assert.ok(
    result.queries.some((q) => q.name === "foo" && q.version === "1.1.0" && q.side === "baseline")
  );
  assert.ok(!result.queries.some((q) => q.name === "bar"));
});

test("retargeting an edge to an already locked child rechecks the child even when no identity disappears", () => {
  const children = childLock("^1.0.0", "1.0.0") + childLock("~1.0.1", "1.0.1");
  const result = inspect(
    lock("1.0.0", '  dependencies:\n    bar "^1.0.0"\n') + children,
    lock("1.0.1", '  dependencies:\n    bar "~1.0.1"\n') + children
  );
  assert.ok(
    result.queries.some((q) => q.name === "bar" && q.version === "1.0.1" && q.side === "retained")
  );
});

test("retargeting a reused root or parent follows reused descendants and blocks vulnerable nested targets", async () => {
  const entry = (name, range, version, children = "") =>
    `\n"${name}@${range}":\n  version "${version}"\n  resolved "https://registry.npmjs.org/${name}/-/${name}-${version}.tgz"\n  integrity ${sri}\n${children}`;
  const branches = ["1.0.0", "1.1.0"]
    .map(
      (v) =>
        entry("foo", "^" + v, v, `  dependencies:\n    bar "^${v}"\n`) +
        entry("bar", "^" + v, v, `  dependencies:\n    baz "^${v}"\n`) +
        entry("baz", "^" + v, v)
    )
    .join("");
  for (const rootTransition of [true, false]) {
    const base = rootTransition
      ? branches
      : lock("1.0.0", '  dependencies:\n    bar "^1.0.0"\n') +
        branches.replace(/\n"foo@[\s\S]*?(?=\n"bar@)/g, "");
    const head = rootTransition ? base : base.replace('bar "^1.0.0"', 'bar "^1.1.0"');
    const inventory = inspect(
      base,
      head,
      manifest(),
      rootTransition ? manifest("^1.1.0") : manifest()
    );
    assert.ok(
      inventory.queries.some(
        (q) => q.name === "baz" && q.version === "1.1.0" && q.side === "retained"
      ),
      "nested reused target was not selected for advisory checks"
    );
    assert.ok(
      inventory.queries.some(
        (q) => q.name === "baz" && q.version === "1.0.0" && q.side === "baseline"
      )
    );
    await assert.rejects(
      queryOsv(
        inventory.queries,
        async (_, options) =>
          new Response(
            JSON.stringify({
              results: JSON.parse(options.body).queries.map((q) =>
                q.package.name === "baz" && q.version === "1.1.0"
                  ? { vulns: [{ id: "CVE-2026-12345" }] }
                  : {}
              ),
            })
          )
      ),
      /vulnerab/i
    );
  }
});

test("an unrelated older parent does not turn an unchanged child path into a new selection", async () => {
  const entry = (name, range, version, children = "") =>
    `\n"${name}@${range}":\n  version "${version}"\n  resolved "https://registry.npmjs.org/${name}/-/${name}-${version}.tgz"\n  integrity ${sri}\n${children}`;
  const older =
    entry("keep", "^1.0.0", "1.0.0", '  dependencies:\n    foo "^1.0.0"\n') +
    lock("1.0.0", '  dependencies:\n    bar "^1.0.0"\n') +
    childLock("^1.0.0", "1.0.0") +
    childLock("^1.1.0", "1.1.0");
  const base = older + entry("foo", "^1.1.0", "1.1.0", '  dependencies:\n    bar "^1.1.0"\n');
  const head = older + entry("foo", "^1.2.0", "1.2.0", '  dependencies:\n    bar "^1.1.0"\n');
  const inventory = inspect(
    base,
    head,
    manifest("^1.1.0", { dependencies: { foo: "^1.1.0", keep: "^1.0.0" } }),
    manifest("^1.2.0", { dependencies: { foo: "^1.2.0", keep: "^1.0.0" } })
  );
  assert.ok(!inventory.queries.some((q) => q.name === "bar" && q.side === "retained"));
  await queryOsv(
    inventory.queries,
    async (_, options) =>
      new Response(
        JSON.stringify({
          results: JSON.parse(options.body).queries.map((q) =>
            q.package.name === "bar" ? { vulns: [{ id: "CVE-2026-12345" }] } : {}
          ),
        })
      )
  );
});

test("reused dependency cycles terminate and excessive path comparisons are held", () => {
  const entry = (name, version, child, childVersion) =>
    `\n"${name}@^${version}":\n  version "${version}"\n  resolved "https://registry.npmjs.org/${name}/-/${name}-${version}.tgz"\n  integrity ${sri}\n  dependencies:\n    ${child} "^${childVersion}"\n`;
  const cyclic = ["1.0.0", "1.1.0"]
    .map((v) => entry("foo", v, "bar", v) + entry("bar", v, "foo", v))
    .join("");
  const result = inspect(cyclic, cyclic, manifest(), manifest("^1.1.0"));
  assert.ok(
    result.queries.some((q) => q.name === "bar" && q.version === "1.1.0" && q.side === "retained")
  );
  const chain = ["1.0.0", "1.1.0"]
    .map((v) =>
      Array.from({ length: 501 }, (_, i) =>
        entry(i ? "node" + i : "foo", v, i === 500 ? "foo" : "node" + (i + 1), v)
      ).join("")
    )
    .join("");
  assert.throws(() => inspect(chain, chain, manifest(), manifest("^1.1.0")), /selection.*limit/i);
});

test("OSV refuses a retained vulnerable replacement instead of claiming its advisory cleared", async () => {
  await assert.rejects(
    queryOsv(
      [
        { name: "bar", version: "1.0.0", side: "removed" },
        { name: "bar", version: "1.0.1", side: "retained" },
      ],
      async () =>
        new Response(
          JSON.stringify({
            results: [
              { vulns: [{ id: "GHSA-hmw2-7cc7-3qxx" }] },
              { vulns: [{ id: "GHSA-hmw2-7cc7-3qxx" }] },
            ],
          })
        )
    ),
    /vulnerab/i
  );
});

test("an advisory on an unchanged baseline copy is reported as remaining, never cleared", async () => {
  const result = await queryOsv(
    [
      { name: "foo", version: "1.0.0", side: "removed" },
      { name: "foo", version: "1.1.0", side: "baseline" },
      { name: "foo", version: "1.2.0", side: "added" },
    ],
    async () =>
      new Response(
        JSON.stringify({
          results: [
            { vulns: [{ id: "GHSA-aaaa-bbbb-cccc" }, { id: "CVE-2026-12345" }] },
            { vulns: [{ id: "GHSA-aaaa-bbbb-cccc" }] },
            {},
          ],
        })
      ),
    true
  );
  assert.deepEqual(result.cleared, ["CVE-2026-12345"]);
  assert.deepEqual(result.remainingBaseline, ["GHSA-aaaa-bbbb-cccc"]);
  assert.equal(result.candidateVersions, 2);
  assert.deepEqual(result.packages[1].vulnerabilities, [
    { id: "GHSA-aaaa-bbbb-cccc", modified: undefined },
  ]);
});

test("new proof uses a strengthened schema and does not accept an old fixed-only report", () => {
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
  const now = new Date("2026-11-15T10:00:00Z");
  const report = reportFor(
    identity,
    { changed: 2, candidateVersions: 1, cleared: ["CVE-2026-12345"], remainingBaseline: [] },
    now
  );
  assert.equal(report.version, 2);
  assert.equal(validateReport(report, identity, now).result.cleared[0], "CVE-2026-12345");
  for (const bad of [
    { ...report.result, remainingBaseline: ["CVE-2026-12345"] },
    { ...report.result, remainingBaseline: ["bad/id"] },
    { ...report.result, remainingBaseline: ["CVE-2026-11111", "CVE-2026-11111"] },
    { ...report.result, candidateVersions: 501 },
  ])
    assert.throws(() => validateReport({ ...report, result: bad }, identity, now), /report/i);
  assert.throws(
    () =>
      validateReport(
        { ...report, version: 1, result: { changed: 2, fixed: ["CVE-2026-12345"] } },
        identity,
        now
      ),
    /report/i
  );
});

const legacyPrerelease = (version = "5.0.0-alpha.175") =>
  `\n"@mui/lab@^5.0.0-alpha.167":\n  version "${version}"\n  resolved "https://registry.npmjs.org/@mui/lab/-/lab-${version}.tgz"\n  integrity ${sri}\n`;
const manifestWithLegacyPrerelease = manifest("^1.0.0", {
  dependencies: { foo: "^1.0.0", "@mui/lab": "^5.0.0-alpha.167" },
});

test("unchanged prerelease root baseline permits an unrelated stable update", () => {
  const result = inspect(
    lock() + legacyPrerelease(),
    lock("1.0.1") + legacyPrerelease(),
    manifestWithLegacyPrerelease,
    manifestWithLegacyPrerelease
  );
  assert.deepEqual(result.queries, [
    { name: "foo", version: "1.0.0", side: "removed" },
    { name: "foo", version: "1.0.1", side: "added" },
  ]);
});

test("upgrading an existing prerelease root remains held", () => {
  assert.throws(
    () =>
      inspect(
        lock() + legacyPrerelease(),
        lock("1.0.1") + legacyPrerelease("5.0.0-alpha.176"),
        manifestWithLegacyPrerelease,
        manifestWithLegacyPrerelease
      ),
    /version/i
  );
});

test("same prerelease version does not exempt changed lock entry metadata", () => {
  const legacy = legacyPrerelease();
  const changed = [
    ["source", legacy.replace("registry.npmjs.org", "registry.yarnpkg.com")],
    ["integrity", legacy.replace(sri, "sha512-" + Buffer.alloc(64, 2).toString("base64"))],
    ["dependency edge", legacy + '  dependencies:\n    foo "^1.0.0"\n'],
  ];
  for (const [label, entry] of changed)
    assert.throws(
      () =>
        inspect(
          lock() + legacy,
          lock("1.0.1") + entry,
          manifestWithLegacyPrerelease,
          manifestWithLegacyPrerelease
        ),
      /version/i,
      label
    );
});

test("the actual app manifest and lock form a valid unchanged baseline", () => {
  const fs = require("node:fs"),
    path = require("node:path");
  const root = path.resolve(__dirname, "../..");
  const m = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const l = fs.readFileSync(path.join(root, "yarn.lock"), "utf8");
  assert.deepEqual(inspect(l, l, m, m), { changed: 0, candidateVersions: 0, queries: [] });
});

test("the application lock does not retain the known affected form-data 4.x versions", () => {
  const fs = require("node:fs"),
    path = require("node:path");
  const data = tools.lockfile.parse(
    fs.readFileSync(path.resolve(__dirname, "../../yarn.lock"), "utf8")
  ).object;
  const entries = Object.entries(data).filter(([selector]) => selector.startsWith("form-data@"));
  assert.ok(entries.length > 0);
  for (const [selector, entry] of entries)
    assert.ok(
      tools.semver.satisfies(entry.version, ">=4.0.6 <5.0.0"),
      `${selector} resolves to affected ${entry.version}`
    );
});

test("installed multipart encoding escapes field names and filenames instead of injecting headers", () => {
  const FormData = require("form-data");
  const form = new FormData();
  form.append('field"\r\nX-Factory-Test: injected', Buffer.from("synthetic payload"), {
    filename: 'file"\r\nX-Factory-Filename: injected.txt',
  });
  const body = form.getBuffer().toString("utf8");
  assert.ok(!body.includes("\r\nX-Factory-Test:"), "field name injected a multipart header");
  assert.ok(!body.includes("\r\nX-Factory-Filename:"), "filename injected a multipart header");
  assert.match(body, /%0D%0A/);
});

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
test("root edge cannot downgrade into an unchanged selector already elsewhere", () => {
  const existing = lock("1.1.0").replace("foo@^1.0.0", "foo@^1.1.0");
  assert.throws(
    () => inspect(lock("1.9.0") + "\n" + existing, existing, manifest(), manifest("^1.1.0")),
    /downgrade/i
  );
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
  const result = await queryOsv(q, transport);
  assert.deepEqual(result.cleared, ["CVE-2026-12345"]);
  assert.equal(result.candidateVersions, 1);
  assert.equal(result.fixed, undefined);
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
  const r = reportFor(
    identity,
    { changed: 2, candidateVersions: 1, cleared: [], remainingBaseline: [] },
    new Date("2026-11-15T10:00:00Z")
  );
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
