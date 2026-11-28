const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { test } = require("node:test");
const { toolsAt } = require("../factory/dependency-analysis.cjs");
const { ROOT } = require("../factory/github.cjs");

const tools = toolsAt(path.resolve(__dirname, "../factory/dependency-tools"));
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const NEW = "c".repeat(40);
const TREE = "d".repeat(40);
const BLOB = "e".repeat(40);
const NEW_TREE = "f".repeat(40);
const ref = "dependabot/npm_and_yarn/example-2.0.0";
const repo = { full_name: "haideearus/cypress-realworld-app" };
const pr = {
  number: 427,
  state: "open",
  draft: false,
  user: { type: "Bot", id: 49699333, login: "dependabot[bot]" },
  head: { sha: HEAD, ref, repo },
  base: { sha: BASE, ref: "main", repo },
};
const manifest = (range) =>
  JSON.stringify({
    scripts: { build: "vite build" },
    dependencies: { example: range, independent: "1.0.0" },
  });
const entry = (name, version, range = version) =>
  `${name}@${range}:\n  version "${version}"\n  resolved "https://registry.yarnpkg.com/${name}/-/${name}-${version}.tgz"\n  integrity sha512-${Buffer.alloc(64, 1).toString("base64")}\n`;
const lock = (version, independent = "1.0.0") =>
  entry("example", version) + "\n" + entry("independent", independent, "1.0.0");
const source = {
  baseManifest: manifest("1.0.0"),
  headManifest: manifest("2.0.0"),
  baseLock: lock("1.0.0"),
  headLock: lock("2.0.0"),
  ref,
  tools,
};
const appPatch = [
  { path: "src/example.ts", mode: "100644", content: "export const ready = true;\n" },
];

function publisher() {
  return require("../factory/dependency-compatibility.cjs");
}
function fakeGitHub({
  lost = false,
  raced = false,
  entryMode = "100644",
  proposedLock = source.headLock,
} = {}) {
  const requests = [];
  let currentHead = HEAD;
  return {
    requests,
    async request(method, url, body) {
      requests.push({ method, url, body });
      const route = url.slice(ROOT.length);
      if (method === "GET") {
        if (route === "/pulls/427") return { ...pr, head: { ...pr.head, sha: currentHead } };
        if (route === "/git/ref/heads/main") return { object: { sha: BASE } };
        if (route === "/git/ref/heads/" + ref)
          return { object: { sha: raced ? "1".repeat(40) : currentHead } };
        if (route === `/compare/${BASE}...${HEAD}?per_page=1`)
          return { status: "ahead", behind_by: 0, merge_base_commit: { sha: BASE } };
        const match = /^\/contents\/(package\.json|yarn\.lock)\?ref=([a-f0-9]{40})$/.exec(route);
        if (match) {
          const [, file, sha] = match;
          const original = sha === HEAD;
          const raw =
            file === "package.json"
              ? original
                ? source.headManifest
                : source.baseManifest
              : original
                ? proposedLock
                : source.baseLock;
          return {
            type: "file",
            path: file,
            encoding: "base64",
            size: Buffer.byteLength(raw),
            content: Buffer.from(raw).toString("base64"),
          };
        }
        if (route === "/git/commits/" + HEAD) return { sha: HEAD, tree: { sha: TREE } };
        if (route === "/git/commits/" + NEW)
          return { sha: NEW, tree: { sha: TREE }, parents: [{ sha: HEAD }] };
        if (route === "/git/trees/" + TREE + "?recursive=1")
          return {
            sha: TREE,
            truncated: false,
            tree: [
              { path: "src/example.ts", sha: BLOB, type: "blob", mode: entryMode },
              { path: "package.json", sha: BLOB, type: "blob", mode: "100644" },
              { path: "yarn.lock", sha: BLOB, type: "blob", mode: "100644" },
            ],
          };
      }
      if (method === "POST" && route === "/git/blobs") return { sha: BLOB };
      if (method === "POST" && route === "/git/trees") return { sha: NEW_TREE };
      if (method === "POST" && route === "/git/commits") return { sha: NEW };
      if (method === "PATCH" && route === "/git/refs/heads/" + ref) {
        currentHead = body.sha;
        if (lost) throw Object.assign(new Error("GitHub 502 after write"), { status: 502 });
        return { object: { sha: body.sha } };
      }
      throw new Error(`Unexpected GitHub request ${method} ${url}`);
    },
  };
}
const input = (api, files = appPatch) => ({
  api,
  pr,
  expectedBase: BASE,
  expectedHead: HEAD,
  bundle: { files },
  tools,
});

test("recognizes the version actually installed by a native major proposal", () => {
  assert.deepEqual(publisher().classifyNativeUpdate(source), {
    name: "example",
    version: "2.0.0",
    previousVersion: "1.0.0",
    major: true,
  });
  assert.throws(
    () => publisher().classifyNativeUpdate({ ...source, ref: ref.replace("2.0.0", "3.0.0") }),
    /target|branch|version/i
  );
});

test("recognizes a lock-only major bump when the retained selector permits it", () => {
  const baseManifest = manifest(">=1.0.0");
  const headManifest = baseManifest;
  assert.deepEqual(
    publisher().classifyNativeUpdate({
      ...source,
      baseManifest,
      headManifest,
      baseLock: entry("example", "1.0.0", ">=1.0.0") + "\n" + entry("independent", "1.0.0"),
      headLock: entry("example", "2.0.0", ">=1.0.0") + "\n" + entry("independent", "1.0.0"),
    }),
    { name: "example", version: "2.0.0", previousVersion: "1.0.0", major: true }
  );
});

test("reads large Contents responses through the exact verified immutable Git blob", async () => {
  const raw = source.headLock;
  const metadata = {
    type: "file",
    path: "yarn.lock",
    encoding: "none",
    size: Buffer.byteLength(raw),
    sha: createHash("sha1")
      .update(`blob ${Buffer.byteLength(raw)}\0${raw}`)
      .digest("hex"),
  };
  const routes = [];
  const api = {
    async request(method, route) {
      assert.equal(method, "GET");
      routes.push(route);
      if (route === `${ROOT}/contents/yarn.lock?ref=${HEAD}`) return metadata;
      if (route === `${ROOT}/git/blobs/${metadata.sha}`)
        return { ...metadata, encoding: "base64", content: Buffer.from(raw).toString("base64") };
      throw new Error("Unexpected source route " + route);
    },
  };
  assert.equal(await publisher().readDependencySource(api, HEAD, "yarn.lock"), raw);
  assert.equal(routes.length, 2);
  metadata.sha = "0".repeat(40);
  await assert.rejects(publisher().readDependencySource(api, HEAD, "yarn.lock"), /blob|hash/i);
});

test("rejects removing another package, reverting the target, and changing scripts", async () => {
  for (const files of [
    [{ path: "package.json", mode: "100644", content: source.baseManifest }],
    [
      {
        path: "package.json",
        mode: "100644",
        content: source.headManifest.replace("vite build", "node evil.js"),
      },
    ],
    [{ path: "yarn.lock", mode: "100644", content: lock("2.0.0", "1.0.1") }],
    [{ path: "yarn.lock", mode: "100644", content: entry("example", "2.0.0") }],
  ]) {
    const api = fakeGitHub();
    await assert.rejects(
      publisher().prepareCompatibility(input(api, files)),
      /manifest|target|lock|unrelated/i
    );
    assert.ok(api.requests.every(({ method }) => method === "GET"));
  }
});

test("restores unrelated proposal drift only to the exact approved main lockfile entry", async () => {
  const proposedLock = lock("2.0.0", "0.9.0");
  const api = fakeGitHub({ proposedLock });
  const operations = publisher();
  const target = operations.classifyNativeUpdate({ ...source, headLock: proposedLock });
  assert.throws(
    () => operations.verifyNativeLockScope({ ...source, headLock: proposedLock, target }),
    /unrelated|resolution/i
  );
  assert.doesNotThrow(() => operations.verifyNativeLockScope({ ...source, target }));
  const normalized = operations.normalizeNativeLockScope({
    ...source,
    headLock: proposedLock,
    target,
  });
  assert.equal(normalized.restored, 1);
  assert.deepEqual(
    tools.lockfile.parse(normalized.lock).object,
    tools.lockfile.parse(source.headLock).object
  );
  assert.deepEqual(operations.normalizeNativeLockScope({ ...source, target }), {
    target,
    lock: source.headLock,
    restored: 0,
  });
  assert.equal((await operations.prepareCompatibility(input(api))).newHead, NEW);
  assert.ok(
    api.requests.some(
      ({ method, url, body }) =>
        method === "POST" && url.endsWith("/git/blobs") && body.content === normalized.lock
    )
  );
});

test("publication prepares a one-parent commit and reconciles a lost branch update response", async () => {
  const api = fakeGitHub({ lost: true });
  const prepared = await publisher().prepareCompatibility(input(api));
  assert.equal(prepared.newHead, NEW);
  assert.equal(
    api.requests.some(({ method }) => method === "PATCH"),
    false
  );
  assert.deepEqual(api.requests.find(({ url }) => url.endsWith("/git/commits")).body.parents, [
    HEAD,
  ]);
  await publisher().applyCompatibility({ ...input(api), newHead: NEW });
  await publisher().applyCompatibility({ ...input(api), newHead: NEW });
  assert.deepEqual(
    api.requests.filter(({ method }) => method === "PATCH"),
    [{ method: "PATCH", url: ROOT + "/git/refs/heads/" + ref, body: { sha: NEW, force: false } }]
  );
});

test("publication rejects a competing branch write and refuses to modify a symlink", async () => {
  const raced = fakeGitHub({ raced: true });
  await assert.rejects(
    publisher().applyCompatibility({ ...input(raced), newHead: NEW }),
    /head|branch/i
  );
  assert.ok(raced.requests.every(({ method }) => method === "GET"));
  const linked = fakeGitHub({ entryMode: "120000" });
  await assert.rejects(publisher().prepareCompatibility(input(linked)), /regular|tree|mode/i);
  assert.ok(linked.requests.every(({ method }) => method === "GET"));
});

test("review file scope rejects workflow paths and renames on a repaired proposal", () => {
  const { repairFilesOK } = publisher();
  assert.doesNotThrow(() =>
    repairFilesOK([
      { filename: "yarn.lock", status: "modified" },
      { filename: "scripts/generateSeedData.ts", status: "modified" },
    ])
  );
  assert.throws(
    () =>
      repairFilesOK([
        { filename: "yarn.lock", status: "modified" },
        { filename: ".github/workflows/build.yml", status: "modified" },
      ]),
    /forbidden|scope/i
  );
  assert.throws(
    () =>
      repairFilesOK([
        { filename: "yarn.lock", status: "modified" },
        {
          filename: "src/example.ts",
          status: "renamed",
          previous_filename: "scripts/factory/controller.cjs",
        },
      ]),
    /forbidden|scope/i
  );
});

test("requests one native branch refresh after saving its expected head and new base", async () => {
  const base = "1".repeat(40);
  const api = refreshAPI(base);
  const claim = async (intent) => {
    assert.deepEqual(intent, { head: NEW, base });
    assert.equal(
      api.requests.some(({ method }) => method === "PUT"),
      false
    );
    return true;
  };
  const { requestCompatibilityRefresh } = publisher();
  const options = { api, pr: api.pr, expectedHead: NEW, expectedBase: base };
  assert.equal((await requestCompatibilityRefresh({ ...options, claim })).requested, true);
  assert.equal(
    (await requestCompatibilityRefresh({ ...options, claim: async () => false })).requested,
    false
  );
  assert.deepEqual(
    api.requests.filter(({ method }) => method === "PUT"),
    [{ method: "PUT", url: ROOT + "/pulls/427/update-branch", body: { expected_head_sha: NEW } }]
  );
});

test("admits only the original repaired head and latest main as ordered refresh parents", async () => {
  const base = "1".repeat(40);
  const refreshed = "2".repeat(40);
  const { validCompatibilityRefresh } = publisher();
  const api = refreshAPI(base, { refreshed });
  const identity = { originalHead: NEW, base, originalBase: BASE };
  assert.equal(await validCompatibilityRefresh({ api, pr: api.pr, ...identity }), true);
  for (const changes of [
    { parents: [base, NEW] },
    { parents: [NEW, "3".repeat(40)] },
    { file: ".github/workflows/factory-ci.yml" },
    { file: "src/other-file.ts" },
    { priorApplicationBlob: "4".repeat(40) },
    { originalMode: "100755" },
  ]) {
    const candidate = refreshAPI(base, { refreshed, ...changes });
    assert.equal(
      await validCompatibilityRefresh({ api: candidate, pr: candidate.pr, ...identity }),
      false
    );
  }
});

test("can verify a durable refresh after main advances, without treating stale work as current", async () => {
  const base = "1".repeat(40);
  const refreshed = "2".repeat(40);
  const api = refreshAPI(base, { refreshed, latestBase: "3".repeat(40) });
  const options = { api, pr: api.pr, originalHead: NEW, base, originalBase: BASE };
  const { validCompatibilityRefresh } = publisher();
  assert.equal(await validCompatibilityRefresh(options), false);
  assert.equal(await validCompatibilityRefresh({ ...options, allowAdvancedBase: true }), true);
});

function refreshAPI(
  base,
  {
    refreshed,
    parents = [NEW, base],
    file = "src/example.ts",
    latestBase = base,
    priorApplicationBlob = BLOB,
    originalMode = "100644",
  } = {}
) {
  const requests = [];
  const head = refreshed || NEW;
  const currentPR = { ...pr, head: { ...pr.head, sha: head }, base: { ...pr.base, sha: base } };
  const files = [
    { filename: "yarn.lock", status: "modified" },
    { filename: file, status: "modified" },
  ];
  return {
    requests,
    pr: currentPR,
    async request(method, url, body) {
      requests.push({ method, url, body });
      const route = url.slice(ROOT.length);
      if (method === "PUT" && route === "/pulls/427/update-branch") return {};
      if (method !== "GET") throw new Error("Unexpected refresh method " + method);
      if (route === "/pulls/427") return currentPR;
      if (route === "/git/ref/heads/main") return { object: { sha: latestBase } };
      if (route === "/git/ref/heads/" + ref) return { object: { sha: head } };
      if (route === "/git/commits/" + head)
        return { sha: head, tree: { sha: TREE }, parents: parents.map((sha) => ({ sha })) };
      if (route === "/git/commits/" + NEW)
        return { sha: NEW, tree: { sha: NEW_TREE }, parents: [{ sha: HEAD }] };
      if (route === "/git/trees/" + TREE + "?recursive=1")
        return {
          sha: TREE,
          truncated: false,
          tree: ["package.json", "yarn.lock", file].map((path) => ({
            path,
            type: "blob",
            mode: "100644",
            sha: BLOB,
          })),
        };
      if (route === "/git/trees/" + NEW_TREE + "?recursive=1")
        return {
          sha: NEW_TREE,
          truncated: false,
          tree: ["package.json", "yarn.lock", "src/example.ts"].map((path) => ({
            path,
            type: "blob",
            mode: path === "src/example.ts" ? originalMode : "100644",
            sha: path === "src/example.ts" ? priorApplicationBlob : BLOB,
          })),
        };
      if (route === `/compare/${base}...${latestBase}?per_page=1`)
        return { status: "ahead", behind_by: 0, merge_base_commit: { sha: base } };
      if (route === `/compare/${base}...${head}?per_page=1`)
        return { status: "ahead", behind_by: 0, merge_base_commit: { sha: base }, files };
      if (route === `/compare/${BASE}...${NEW}?per_page=1`)
        return {
          status: "ahead",
          behind_by: 0,
          merge_base_commit: { sha: BASE },
          files: [files[0], { filename: "src/example.ts", status: "modified" }],
        };
      throw new Error("Unexpected refresh route " + route);
    },
  };
}
