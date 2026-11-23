const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { inspectUpdate, toolsAt } = require("../factory/dependency-analysis.cjs");
const { buildWiderCandidate } = require("../factory/dependency-wider-candidate.cjs");
const tools = toolsAt(path.resolve(__dirname, "../factory/dependency-tools"));

const integrity = "sha512-" + Buffer.alloc(64, 11).toString("base64");
const shasum = "ab".repeat(20);
const tarball = (name, version) =>
  `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
const entry = (name, version, dependencies) => ({
  version,
  resolved: tarball(name, version) + "#" + shasum,
  integrity,
  ...(dependencies && { dependencies }),
});
const release = (name, version, dependencies, fields = {}) => ({
  name,
  version,
  dist: { tarball: tarball(name, version), integrity, shasum },
  ...(dependencies && { dependencies }),
  ...fields,
});
function fixture(
  dependencies,
  entries,
  releases,
  affected = [{ selector: "1.0.0", version: "1.0.0" }]
) {
  const alerts = [{ number: 1, range: "<1.1.0", patched: "1.1.0" }];
  const group = { name: "foo", entries: affected, alerts };
  const plan = {
    package: "foo",
    upgradeEvidence: { excluded: ["<1.1.0"], releases: Object.keys(releases.foo || {}) },
  };
  const manifest =
    JSON.stringify(
      {
        name: "fixture",
        scripts: { test: "exit 23", postinstall: "exit 41" },
        dependencies,
        optionalDependencies: { "optional-existing": "^1" },
      },
      null,
      2
    ) + "\n";
  const lock = tools.lockfile.stringify({
    ...entries,
    "optional-existing@^1": entry("optional-existing", "1.0.0"),
  });
  const transport = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://registry.npmjs.org");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(init.headers.Authorization, undefined);
    assert.ok(init.signal);
    const [name, version] = url.pathname.slice(1).split("/").map(decodeURIComponent);
    const pkg = releases[name];
    const payload = version ? pkg?.[version] : pkg && { name, versions: pkg };
    return payload
      ? new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } })
      : new Response(null, { status: 404 });
  };
  return { group, plan, manifest, lock, tools, transport };
}
function read(candidate, input) {
  assert.ok(candidate);
  assert.ok(
    inspectUpdate(input.manifest, candidate.manifest, input.lock, candidate.lock, tools, true, {
      wider: true,
    }).changed
  );
  return tools.lockfile.parse(candidate.lock).object;
}

test("an exact direct pin advances to the smallest verified stable release", async () => {
  const input = fixture(
    { foo: "1.0.0", unrelated: "^1" },
    {
      "foo@1.0.0": entry("foo", "1.0.0"),
      "unrelated@^1": entry("unrelated", "1.4.0"),
      "historical@^2": entry("historical", "2.9.0"),
    },
    { foo: { "1.1.2": release("foo", "1.1.2"), "1.1.0": release("foo", "1.1.0") } }
  );
  const candidate = await buildWiderCandidate(input);
  const lock = read(candidate, input);
  assert.equal(candidate.version, "1.1.0");
  const expected = JSON.parse(input.manifest);
  expected.dependencies.foo = "1.1.0";
  assert.deepEqual(JSON.parse(candidate.manifest), expected);
  assert.equal(lock["foo@1.0.0"], undefined);
  assert.equal(lock["foo@1.1.0"].version, "1.1.0");
  assert.equal(lock["historical@^2"].version, "2.9.0");
  assert.equal(lock["unrelated@^1"].version, "1.4.0");
});

test("split release lines update different selectors and resolve changed child ranges", async () => {
  const input = fixture(
    { foo: "^1", parent: "^1" },
    {
      "foo@^1": entry("foo", "1.0.0", { child: "^1" }),
      "foo@^2": entry("foo", "2.0.0"),
      "child@^1": entry("child", "1.0.0"),
      "parent@^1": entry("parent", "1.0.0", { foo: "^2" }),
    },
    {
      foo: {
        "1.1.0": release("foo", "1.1.0", { child: "^1.2" }),
        "2.1.0": release("foo", "2.1.0"),
      },
      child: { "1.2.0": release("child", "1.2.0"), "1.5.0": release("child", "1.5.0") },
    },
    [
      { selector: "^1", version: "1.0.0" },
      { selector: "^2", version: "2.0.0" },
    ]
  );
  input.group.alerts.push({ number: 2, range: ">=2.0.0 <2.1.0", patched: "2.1.0" });
  input.plan.upgradeEvidence.excluded.push(">=2.0.0 <2.1.0");
  const candidate = await buildWiderCandidate(input);
  const lock = read(candidate, input);
  assert.equal(candidate.manifest, input.manifest);
  assert.equal(candidate.version, "1.1.0");
  assert.equal(lock["foo@^1"].version, "1.1.0");
  assert.equal(lock["foo@^2"].version, "2.1.0");
  assert.equal(lock["child@^1.2"].version, "1.2.0");
  assert.equal(lock["child@^1"], undefined);
});

test("a blocked nested selector advances only the roots that still need a new range", async () => {
  const input = fixture(
    { alpha: "^1", bravo: "^1", unrelated: "^1" },
    {
      "alpha@^1": entry("alpha", "1.0.0", { nested: "^1" }),
      "nested@^1": entry("nested", "1.0.0", { foo: "1.0.0" }),
      "bravo@^1": entry("bravo", "1.3.0", { foo: "^1" }),
      "foo@1.0.0": entry("foo", "1.0.0"),
      "foo@^1": entry("foo", "1.0.0"),
      "unrelated@^1": entry("unrelated", "1.0.0"),
    },
    {
      foo: { "1.1.0": release("foo", "1.1.0") },
      alpha: {
        "1.1.0": release("alpha", "1.1.0", { nested: "^1" }),
        "2.0.0": release("alpha", "2.0.0", { nested: "^2" }),
      },
      nested: { "2.0.1": release("nested", "2.0.1", { foo: "^1" }) },
    },
    [
      { selector: "1.0.0", version: "1.0.0" },
      { selector: "^1", version: "1.0.0" },
    ]
  );
  const candidate = await buildWiderCandidate(input);
  const lock = read(candidate, input);
  assert.deepEqual(JSON.parse(candidate.manifest).dependencies, {
    alpha: "2.0.0",
    bravo: "^1",
    unrelated: "^1",
  });
  assert.equal(lock["nested@^2"].version, "2.0.1");
  assert.equal(lock["nested@^1"], undefined);
  assert.equal(lock["foo@1.0.0"], undefined);
  assert.equal(lock["foo@^1"].version, "1.1.0");
});

test("a verified parent update may remove the vulnerable package entirely", async () => {
  const input = fixture(
    { parent: "^1" },
    {
      "parent@^1": entry("parent", "1.0.0", { foo: "1.0.0" }),
      "foo@1.0.0": entry("foo", "1.0.0"),
    },
    { parent: { "1.0.1": release("parent", "1.0.1") } }
  );
  const candidate = await buildWiderCandidate(input);
  assert.equal(read(candidate, input)["foo@1.0.0"], undefined);
  assert.equal(candidate.removed, true);
  assert.equal(candidate.version, "1.0.0");
});

test("an evidence rejection tries the next stable release and a transient failure stops", async () => {
  const input = fixture(
    { foo: "1.0.0" },
    { "foo@1.0.0": entry("foo", "1.0.0") },
    { foo: { "1.1.0": release("foo", "1.1.0"), "1.1.1": release("foo", "1.1.1") } }
  );
  const seen = [];
  const candidate = await buildWiderCandidate({
    ...input,
    accept: async (selected) => {
      seen.push(selected.version);
      return selected.version === "1.1.1";
    },
  });
  assert.equal(candidate?.version, "1.1.1");
  assert.deepEqual(seen, ["1.1.0", "1.1.1"]);
  await assert.rejects(
    buildWiderCandidate({
      ...input,
      accept: async () => {
        throw Error("public evidence unavailable");
      },
    }),
    /public evidence unavailable/
  );
});

test("a repair never downgrades a selected child or takes two major steps", async () => {
  const input = fixture(
    { foo: "1.0.0" },
    {
      "foo@1.0.0": entry("foo", "1.0.0", { child: "^2" }),
      "child@^2": entry("child", "2.3.0"),
      "child@^1": entry("child", "1.8.0"),
    },
    { foo: { "1.1.0": release("foo", "1.1.0", { child: "^1" }), "3.0.0": release("foo", "3.0.0") } }
  );
  assert.equal(await buildWiderCandidate(input), null);
});

test("unsupported sources, malformed release metadata, and absent advisory evidence hold", async () => {
  for (const unsafe of [
    release("foo", "1.1.0", { child: "npm:other@^1" }),
    release("foo", "1.1.0", { child: "https://registry.npmjs.org/child/-/child-1.0.0.tgz" }),
    release(
      "foo",
      "1.1.0",
      {},
      { dist: { tarball: "https://example.com/foo.tgz", integrity, shasum } }
    ),
    release(
      "foo",
      "1.1.0",
      {},
      { dist: { tarball: tarball("foo", "1.1.0"), integrity: "sha512-stale", shasum } }
    ),
  ]) {
    const input = fixture(
      { foo: "1.0.0" },
      { "foo@1.0.0": entry("foo", "1.0.0") },
      { foo: { "1.1.0": unsafe } }
    );
    assert.equal(await buildWiderCandidate(input), null);
  }
  const valid = fixture(
    { foo: "1.0.0" },
    { "foo@1.0.0": entry("foo", "1.0.0") },
    { foo: { "1.1.0": release("foo", "1.1.0") } }
  );
  assert.equal(await buildWiderCandidate({ ...valid, plan: {} }), null);
});

test("a locked historical target cannot be deleted or changed to clear an alert", async () => {
  const input = fixture(
    { foo: "^1" },
    { "foo@^1": entry("foo", "1.0.0"), "foo@~1": entry("foo", "1.0.0") },
    { foo: { "1.1.0": release("foo", "1.1.0") } },
    [
      { selector: "^1", version: "1.0.0" },
      { selector: "~1", version: "1.0.0" },
    ]
  );
  assert.equal(await buildWiderCandidate(input), null);
});

test("wider repair preserves roots declared in immutable manifest sections", async () => {
  const input = fixture(
    {},
    { "foo@1.0.0": entry("foo", "1.0.0") },
    { foo: { "1.1.0": release("foo", "1.1.0") } }
  );
  const manifest = JSON.parse(input.manifest);
  manifest.optionalDependencies.foo = "1.0.0";
  assert.equal(await buildWiderCandidate({ ...input, manifest: JSON.stringify(manifest) }), null);
});

test("a parent update cannot prune a previously selected nonregistry alias", async () => {
  const input = fixture(
    { parent: "^1" },
    {
      "parent@^1": entry("parent", "1.0.0", { foo: "1.0.0", alias: "npm:actual@^1" }),
      "foo@1.0.0": entry("foo", "1.0.0"),
      "alias@npm:actual@^1": entry("actual", "1.0.0"),
    },
    { parent: { "1.0.1": release("parent", "1.0.1") } }
  );
  assert.equal(await buildWiderCandidate(input), null);
});

test("a verified prerelease advisory floor can be met by a stable candidate", async () => {
  const input = fixture(
    { foo: "1.0.0" },
    { "foo@1.0.0": entry("foo", "1.0.0") },
    { foo: { "1.1.0": release("foo", "1.1.0") } }
  );
  input.group.alerts[0].patched = "1.1.0-rc.1";
  assert.equal((await buildWiderCandidate(input))?.version, "1.1.0");
});

test("a direct pin can take one major step when its release line has no patch", async () => {
  const input = fixture(
    { foo: "^1" },
    { "foo@^1": entry("foo", "1.0.0") },
    { foo: { "3.0.0": release("foo", "3.0.0"), "2.1.0": release("foo", "2.1.0") } },
    [{ selector: "^1", version: "1.0.0" }]
  );
  input.group.alerts[0] = { number: 1, range: "<2.1.0", patched: "2.1.0" };
  input.plan.upgradeEvidence.excluded = ["<2.1.0"];
  const candidate = await buildWiderCandidate(input);
  assert.equal(read(candidate, input)["foo@2.1.0"].version, "2.1.0");
  assert.equal(JSON.parse(candidate.manifest).dependencies.foo, "2.1.0");
});

test("the search holds when a blocked range would require more than four root edits", async () => {
  const roots = ["alpha", "bravo", "charlie", "delta", "echo"];
  const input = fixture(
    Object.fromEntries(roots.map((name) => [name, "^1"])),
    {
      ...Object.fromEntries(
        roots.map((name) => [name + "@^1", entry(name, "1.0.0", { foo: "1.0.0" })])
      ),
      "foo@1.0.0": entry("foo", "1.0.0"),
    },
    { foo: { "1.1.0": release("foo", "1.1.0") } }
  );
  assert.equal(
    await buildWiderCandidate({
      ...input,
      transport: async () => {
        assert.fail("a forced five-root repair must not query npm");
      },
    }),
    null
  );
});

test("a transient npm failure stops the search before trying other releases", async () => {
  const input = fixture(
    { foo: "1.0.0" },
    { "foo@1.0.0": entry("foo", "1.0.0") },
    { foo: { "1.1.0": release("foo", "1.1.0"), "1.1.1": release("foo", "1.1.1") } }
  );
  let requests = 0;
  await assert.rejects(
    buildWiderCandidate({
      ...input,
      transport: async (url, init) => {
        requests++;
        return url.endsWith("/1.1.0")
          ? new Response(null, { status: 500 })
          : input.transport(url, init);
      },
    }),
    { code: "public_service_unavailable" }
  );
  assert.equal(requests, 1);
});
