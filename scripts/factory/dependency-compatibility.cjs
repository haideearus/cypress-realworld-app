const path = require("node:path");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { ROOT } = require("./github.cjs");
const { SHA, branch, prOK } = require("./dependency-contract.cjs");
const { inspectUpdate, toolsAt } = require("./dependency-analysis.cjs");

const MANIFEST = "package.json";
const LOCK = "yarn.lock";
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
const SECTION_SET = new Set(["dependencies", "devDependencies"]);
const sourceLimit = { [MANIFEST]: 65536, [LOCK]: 2097152 };
const selectorPattern = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(.+)$/i;

function parserTools() {
  return toolsAt(path.join(__dirname, "dependency-tools"));
}

function parseManifest(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > sourceLimit[MANIFEST])
    throw new Error("Invalid dependency compatibility manifest size");
  const manifest = JSON.parse(raw);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("Invalid dependency compatibility manifest");
  return manifest;
}

function parseLock(raw, lockfile) {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > sourceLimit[LOCK] ||
    /\0|(?:^|\n)\s*["']?(?:__proto__|constructor|prototype)["']?(?:\s|:)/.test(raw)
  )
    throw new Error("Unsafe dependency compatibility lockfile");
  const result = lockfile.parse(raw);
  if (result.type !== "success" || !result.object || Object.keys(result.object).length > 10000)
    throw new Error("Invalid dependency compatibility lockfile");
  return result.object;
}

function dependencies(object, key) {
  if (!Object.hasOwn(object, key)) return [];
  const section = object[key];
  if (!section || typeof section !== "object" || Array.isArray(section))
    throw new Error("Invalid dependency compatibility graph");
  return Object.entries(section).map(([name, range]) => {
    const selector = name + "@" + range;
    if (typeof range !== "string" || !selectorPattern.test(selector))
      throw new Error("Invalid dependency compatibility selector");
    return selector;
  });
}

function graph(lock, roots, stop = new Set()) {
  const visited = new Set();
  const pending = [...roots];
  while (pending.length) {
    const selector = pending.pop();
    if (visited.has(selector) || stop.has(selector)) continue;
    const entry = Object.hasOwn(lock, selector) && lock[selector];
    if (!entry || typeof entry !== "object" || typeof entry.version !== "string")
      throw new Error("Incomplete dependency compatibility lockfile graph");
    visited.add(selector);
    pending.push(
      ...dependencies(entry, "dependencies"),
      ...dependencies(entry, "optionalDependencies")
    );
    if (pending.length > 50000)
      throw new Error("Dependency compatibility lock graph exceeds limit");
  }
  return visited;
}

function targetRoots(manifest, lock, name, version = undefined) {
  return [
    ...graph(
      lock,
      SECTIONS.flatMap((key) => dependencies(manifest, key))
    ),
  ].filter(
    (selector) =>
      selectorPattern.exec(selector)?.[1] === name &&
      (version === undefined || lock[selector].version === version)
  );
}

function getTarget({ baseManifest, headManifest, baseLock, headLock, ref, tools }) {
  const { semver } = tools;
  if (!branch(ref)) throw new Error("Untrusted native dependency target branch");
  const proposal = /^dependabot\/npm_and_yarn\/(.+)-(\d+\.\d+\.\d+)$/.exec(ref);
  if (!proposal || !semver.valid(proposal[2]))
    throw new Error("Native dependency target branch must name one published version");
  const [, branchPackage, version] = proposal;
  const roots = SECTIONS.flatMap((key) => dependencies(headManifest, key));
  const candidates = new Set();
  for (const selector of graph(headLock, roots)) {
    const name = selectorPattern.exec(selector)?.[1];
    const branchName = name?.replace(/^@/, "");
    if (
      branchName &&
      headLock[selector].version === version &&
      (branchPackage === branchName || branchPackage.endsWith("/" + branchName))
    )
      candidates.add(name);
  }
  if (candidates.size !== 1)
    throw new Error("Missing or ambiguous installed native dependency target");
  const [name] = candidates;
  const preservedManifest = (manifest) =>
    Object.fromEntries(Object.entries(manifest).filter(([key]) => !SECTION_SET.has(key)));
  if (!isDeepStrictEqual(preservedManifest(baseManifest), preservedManifest(headManifest)))
    throw new Error("Native compatibility proposal changes unrelated manifest fields");
  for (const key of SECTION_SET) {
    const before = baseManifest[key] || {};
    const after = headManifest[key] || {};
    const otherPackages = (entries) =>
      Object.fromEntries(Object.entries(entries).filter(([packageName]) => packageName !== name));
    if (
      Object.hasOwn(baseManifest, key) !== Object.hasOwn(headManifest, key) ||
      Object.hasOwn(before, name) !== Object.hasOwn(after, name) ||
      !isDeepStrictEqual(otherPackages(before), otherPackages(after))
    )
      throw new Error("Native compatibility proposal changes unrelated dependency declarations");
    for (const [manifest, lock] of [
      [before, baseLock],
      [after, headLock],
    ]) {
      if (Object.hasOwn(manifest, name)) {
        const range = manifest[name];
        if (
          !semver.validRange(range) ||
          !semver.satisfies(lock[name + "@" + range]?.version, range)
        )
          throw new Error("Native dependency target does not match its declared range");
      }
    }
  }
  const oldSelectors = targetRoots(baseManifest, baseLock, name);
  const previous = new Set(oldSelectors.map((selector) => baseLock[selector].version));
  const directSection = SECTIONS.find((key) => Object.hasOwn(baseManifest[key] || {}, name));
  const previousVersion =
    (directSection && baseLock[name + "@" + baseManifest[directSection][name]]?.version) ||
    (previous.size === 1 && [...previous][0]);
  if (
    !semver.valid(previousVersion) ||
    semver.prerelease(previousVersion) ||
    !semver.gt(version, previousVersion) ||
    (directSection && headLock[name + "@" + headManifest[directSection][name]]?.version !== version)
  )
    throw new Error("Native dependency target must be one verified version upgrade");
  return {
    name,
    version,
    previousVersion,
    major: semver.major(previousVersion) !== semver.major(version),
  };
}

function classifyNativeUpdate({
  baseManifest,
  headManifest,
  baseLock,
  headLock,
  ref,
  tools = parserTools(),
}) {
  return getTarget({
    baseManifest: parseManifest(baseManifest),
    headManifest: parseManifest(headManifest),
    baseLock: parseLock(baseLock, tools.lockfile),
    headLock: parseLock(headLock, tools.lockfile),
    ref,
    tools,
  });
}

function lockScopeChanges(baseManifest, headManifest, base, head, target, tools, restore = false) {
  const oldRoots = targetRoots(baseManifest, base, target.name, target.previousVersion);
  const newRoots = targetRoots(headManifest, head, target.name, target.version);
  if (!newRoots.length)
    throw new Error("Compatibility patch removed the requested locked dependency target");
  const oldAffected = graph(base, oldRoots);
  const newAffected = graph(head, newRoots);
  const roots = SECTIONS.flatMap((key) => dependencies(baseManifest, key));
  const unchanged = graph(base, roots, new Set(oldRoots));
  let restored = 0;
  for (const selector of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (isDeepStrictEqual(base[selector], head[selector])) continue;
    if (unchanged.has(selector) || (!oldAffected.has(selector) && !newAffected.has(selector))) {
      if (!restore) throw new Error("Compatibility patch changed an unrelated lockfile resolution");
      if (Object.hasOwn(base, selector)) head[selector] = base[selector];
      else delete head[selector];
      restored++;
      continue;
    }
    const entry = head[selector];
    if (!entry) continue;
    const [, name, range] = selectorPattern.exec(selector) || [];
    if (!name || !tools.semver.satisfies(entry.version, range))
      throw new Error("Compatibility patch added a lockfile resolution outside its range");
    const packageFile = `/${name}/-/${name.split("/").at(-1)}-${entry.version}.tgz`;
    const source = new URL(entry.resolved);
    if (
      source.protocol !== "https:" ||
      !["registry.npmjs.org", "registry.yarnpkg.com"].includes(source.host) ||
      source.username ||
      source.password ||
      source.search ||
      (source.hash && !/^#[a-f0-9]{40}$/.test(source.hash)) ||
      decodeURIComponent(source.pathname) !== packageFile ||
      !/^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity || "")
    )
      throw new Error("Compatibility patch added an unverified lockfile source");
  }
  return restored;
}

function nativeLockScope(
  { baseManifest, headManifest, baseLock, headLock, ref, target, tools = parserTools() },
  restore = false
) {
  const beforeManifest = parseManifest(baseManifest);
  const afterManifest = parseManifest(headManifest);
  const beforeLock = parseLock(baseLock, tools.lockfile);
  const afterLock = parseLock(headLock, tools.lockfile);
  const verified = getTarget({
    baseManifest: beforeManifest,
    headManifest: afterManifest,
    baseLock: beforeLock,
    headLock: afterLock,
    ref,
    tools,
  });
  if (target && (target.name !== verified.name || target.version !== verified.version))
    throw new Error("Native compatibility lock target differs from the reserved target");
  const restored = lockScopeChanges(
    beforeManifest,
    afterManifest,
    beforeLock,
    afterLock,
    verified,
    tools,
    restore
  );
  if (restored)
    lockScopeChanges(beforeManifest, afterManifest, beforeLock, afterLock, verified, tools);
  return {
    target: verified,
    lock: restored ? tools.lockfile.stringify(afterLock) : headLock,
    restored,
  };
}

function verifyNativeLockScope(source) {
  return nativeLockScope(source).target;
}

function normalizeNativeLockScope(source) {
  return nativeLockScope(source, true);
}

function repairFilesOK(files) {
  const { compatibilityArtifactPath } = require("./artifacts.cjs");
  if (
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > 52 ||
    files.some(
      (file) =>
        !compatibilityArtifactPath(file?.filename) ||
        file.previous_filename !== undefined ||
        !(
          [MANIFEST, LOCK].includes(file.filename) ? ["modified"] : ["added", "modified", "removed"]
        ).includes(file.status)
    ) ||
    new Set(files.map((file) => file.filename.toLowerCase())).size !== files.length ||
    !files.some((file) => file.filename === LOCK)
  )
    throw new Error("Dependency compatibility PR changes forbidden files or exceeds scope");
}

async function readDependencySource(api, sha, file) {
  if (!SHA.test(sha || "") || !Object.hasOwn(sourceLimit, file))
    throw new Error("Invalid immutable dependency source request");
  const limit = sourceLimit[file];
  const meta = await api.request("GET", `${ROOT}/contents/${file}?ref=${sha}`);
  if (
    meta?.type !== "file" ||
    meta.path !== file ||
    !Number.isSafeInteger(meta.size) ||
    meta.size < 1 ||
    meta.size > limit
  )
    throw new Error("Invalid immutable dependency source");
  let value = meta;
  if (meta.encoding === "none") {
    requireGitSha(meta.sha);
    value = await api.request("GET", `${ROOT}/git/blobs/${meta.sha}`);
    if (value?.sha !== meta.sha || value.size !== meta.size)
      throw new Error("Immutable dependency blob metadata disagrees");
  }
  if (
    value?.encoding !== "base64" ||
    typeof value.content !== "string" ||
    value.content.length > Math.ceil(limit * 1.4)
  )
    throw new Error("Invalid immutable dependency source");
  const bytes = Buffer.from(value.content.replace(/\n/g, ""), "base64");
  const raw = bytes.toString("utf8");
  if (bytes.length !== value.size || !Buffer.from(raw, "utf8").equals(bytes) || raw.includes("\0"))
    throw new Error("Invalid immutable dependency source encoding");
  if (
    meta.sha !== undefined &&
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== meta.sha
  )
    throw new Error("Immutable dependency blob hash disagrees");
  return raw;
}

function publicationIdentity(pr, expectedBase, expectedHead) {
  prOK(pr);
  if (
    !SHA.test(expectedBase || "") ||
    !SHA.test(expectedHead || "") ||
    expectedBase === expectedHead
  )
    throw new Error("Invalid dependency compatibility head or base");
}

async function refs(api, pr) {
  const [current, base, head] = await Promise.all([
    api.request("GET", `${ROOT}/pulls/${pr.number}`),
    api.request("GET", `${ROOT}/git/ref/heads/main`),
    api.request("GET", `${ROOT}/git/ref/heads/${pr.head.ref}`),
  ]);
  prOK(current);
  if (current.number !== pr.number || current.head.ref !== pr.head.ref)
    throw new Error("Native dependency PR or branch identity changed");
  return { prHead: current.head.sha, base: base?.object?.sha, head: head?.object?.sha };
}

function sameSource(refs, expectedBase, expectedHead) {
  return refs.base === expectedBase && refs.head === expectedHead && refs.prHead === expectedHead;
}

function requireSource(refs, expectedBase, expectedHead) {
  if (!sameSource(refs, expectedBase, expectedHead))
    throw new Error("Dependency compatibility head or base changed");
}

function requireGitSha(value) {
  if (!SHA.test(value || "")) throw new Error("Invalid dependency compatibility Git object");
  return value;
}

async function readTree(api, head, commit) {
  commit ||= await api.request("GET", `${ROOT}/git/commits/${head}`);
  if (commit?.sha !== head) throw new Error("Mismatched dependency compatibility parent commit");
  const treeSha = requireGitSha(commit.tree?.sha);
  const tree = await api.request("GET", `${ROOT}/git/trees/${treeSha}?recursive=1`);
  if (tree?.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree))
    throw new Error("Unverified dependency compatibility source tree");
  const byPath = new Map(tree.tree.map((entry) => [entry.path.toLowerCase(), entry]));
  if (byPath.size !== tree.tree.length)
    throw new Error("Dependency compatibility source tree has ambiguous file paths");
  return { treeSha, byPath };
}

function verifyRegularFiles(byPath, files, requirePresent = false) {
  for (const file of [MANIFEST, LOCK]) {
    const source = byPath.get(file);
    if (source?.path !== file || source.mode !== "100644" || source.type !== "blob")
      throw new Error("Dependency compatibility requires regular manifest and lockfile entries");
  }
  for (const file of files) {
    const existing = byPath.get(file.path.toLowerCase());
    if (
      (existing &&
        (existing.path !== file.path || existing.mode !== "100644" || existing.type !== "blob")) ||
      (!existing && (file.deleted || requirePresent))
    )
      throw new Error("Compatibility patch paths must name regular source files");
    const parts = file.path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const prefix = parts.slice(0, depth).join("/");
      const dir = byPath.get(prefix.toLowerCase());
      if (dir && (dir.path !== prefix || dir.type !== "tree"))
        throw new Error("Compatibility patch crosses an invalid source tree path");
    }
  }
}

async function regularTree(api, head, files) {
  const { treeSha, byPath } = await readTree(api, head);
  verifyRegularFiles(byPath, files);
  return treeSha;
}

function currentComparison(comparison, base) {
  return (
    comparison?.status === "ahead" &&
    comparison.behind_by === 0 &&
    comparison.merge_base_commit?.sha === base
  );
}

async function prepareCompatibility({
  api,
  pr,
  expectedBase,
  expectedHead,
  bundle,
  target: expectedTarget,
  tools = parserTools(),
}) {
  const { validateCompatibilityChanges } = require("./artifacts.cjs");
  publicationIdentity(pr, expectedBase, expectedHead);
  if (bundle?.base !== undefined && bundle.base !== expectedHead)
    throw new Error("Compatibility patch was generated for another head");
  const files = validateCompatibilityChanges(bundle?.files);
  requireSource(await refs(api, pr), expectedBase, expectedHead);
  const [baseManifest, headManifest, baseLock, headLock, treeSha, comparison] = await Promise.all([
    readDependencySource(api, expectedBase, MANIFEST),
    readDependencySource(api, expectedHead, MANIFEST),
    readDependencySource(api, expectedBase, LOCK),
    readDependencySource(api, expectedHead, LOCK),
    regularTree(api, expectedHead, files),
    api.request("GET", `${ROOT}/compare/${expectedBase}...${expectedHead}?per_page=1`),
  ]);
  if (!currentComparison(comparison, expectedBase))
    throw new Error("Dependency compatibility head is behind the expected base");
  const beforeManifest = parseManifest(baseManifest);
  const manifest = parseManifest(headManifest);
  const beforeLock = parseLock(baseLock, tools.lockfile);
  const originalLock = parseLock(headLock, tools.lockfile);
  const target = getTarget({
    baseManifest: beforeManifest,
    headManifest: manifest,
    baseLock: beforeLock,
    headLock: originalLock,
    ref: pr.head.ref,
    tools,
  });
  if (
    expectedTarget &&
    (target.name !== expectedTarget.name || target.version !== expectedTarget.version)
  )
    throw new Error("Native compatibility publication target differs from the reserved target");
  const manifestEdit = files.find((file) => file.path === MANIFEST);
  if (manifestEdit && manifestEdit.content !== headManifest)
    throw new Error("Compatibility patch changed the native dependency manifest");
  const lockEdit = files.find((file) => file.path === LOCK);
  const originalTargets = targetRoots(manifest, originalLock, target.name, target.version);
  const finalLock = lockEdit ? parseLock(lockEdit.content, tools.lockfile) : originalLock;
  const restored = lockScopeChanges(
    beforeManifest,
    manifest,
    beforeLock,
    finalLock,
    target,
    tools,
    !lockEdit
  );
  const finalTargets = targetRoots(manifest, finalLock, target.name, target.version);
  if (originalTargets.some((selector) => !finalTargets.includes(selector)))
    throw new Error("Compatibility patch removed the requested locked dependency target");
  let finalText = lockEdit ? lockEdit.content : headLock;
  let patch = files;
  if (restored) {
    lockScopeChanges(beforeManifest, manifest, beforeLock, finalLock, target, tools);
    finalText = tools.lockfile.stringify(finalLock);
    patch = validateCompatibilityChanges([
      ...files,
      { path: LOCK, mode: "100644", content: finalText },
    ]);
  }
  inspectUpdate(baseManifest, headManifest, baseLock, finalText, tools, false, {
    wider: true,
    nativeTarget: target,
  });
  const entries = [];
  for (const file of patch) {
    const sha = file.deleted
      ? null
      : requireGitSha(
          (
            await api.request("POST", `${ROOT}/git/blobs`, {
              content: file.content,
              encoding: "utf-8",
            })
          )?.sha
        );
    entries.push({ path: file.path, mode: "100644", type: "blob", sha });
  }
  const tree = await api.request("POST", `${ROOT}/git/trees`, {
    base_tree: treeSha,
    tree: entries,
  });
  const newTree = requireGitSha(tree?.sha);
  if (newTree === treeSha) throw new Error("Compatibility patch does not change the source tree");
  const commit = await api.request("POST", `${ROOT}/git/commits`, {
    message: `Factory compatibility repair for Dependabot PR #${pr.number}`,
    tree: newTree,
    parents: [expectedHead],
  });
  const newHead = requireGitSha(commit?.sha);
  if (newHead === expectedHead) throw new Error("Invalid unchanged dependency compatibility head");
  return { newHead, target };
}

async function applyCompatibility({ api, pr, expectedBase, expectedHead, newHead }) {
  publicationIdentity(pr, expectedBase, expectedHead);
  if (requireGitSha(newHead) === expectedHead)
    throw new Error("Invalid unchanged dependency compatibility head");
  const commit = await api.request("GET", `${ROOT}/git/commits/${newHead}`);
  if (
    commit?.sha !== newHead ||
    commit.parents?.length !== 1 ||
    commit.parents[0]?.sha !== expectedHead
  )
    throw new Error("Dependency compatibility commit has a different parent");
  const before = await refs(api, pr);
  const applied = ({ head, prHead }) =>
    head === newHead && [expectedHead, newHead].includes(prHead);
  if (applied(before)) return { newHead, reconciled: true };
  requireSource(before, expectedBase, expectedHead);
  try {
    await api.request("PATCH", `${ROOT}/git/refs/heads/${pr.head.ref}`, {
      sha: newHead,
      force: false,
    });
  } catch (error) {
    if (!applied(await refs(api, pr))) throw error;
    return { newHead, reconciled: true };
  }
  if (!applied(await refs(api, pr)))
    throw new Error("Dependency compatibility branch did not retain the published commit");
  return { newHead, reconciled: false };
}

async function requestCompatibilityRefresh({ api, pr, expectedHead, expectedBase, claim }) {
  publicationIdentity(pr, expectedBase, expectedHead);
  if (typeof claim !== "function")
    throw new Error("A durable dependency compatibility refresh claim is required");
  requireSource(await refs(api, pr), expectedBase, expectedHead);
  if ((await claim({ head: expectedHead, base: expectedBase })) !== true)
    return { requested: false, reason: "compatibility_refresh_already_requested" };
  requireSource(await refs(api, pr), expectedBase, expectedHead);
  try {
    await api.request("PUT", `${ROOT}/pulls/${pr.number}/update-branch`, {
      expected_head_sha: expectedHead,
    });
  } catch (error) {
    if ([409, 422].includes(error.status))
      return { requested: false, reason: "compatibility_refresh_rejected" };
    throw error;
  }
  return { requested: true };
}

function compatibilityAppFiles(files) {
  return files
    .filter(({ filename }) => filename !== MANIFEST && filename !== LOCK)
    .map(({ filename, status }) => [filename, status])
    .sort(([a], [b]) => a.localeCompare(b));
}

async function validCompatibilityRefresh({
  api,
  pr,
  originalHead,
  base,
  originalBase,
  allowAdvancedBase = false,
}) {
  publicationIdentity(pr, base, originalHead);
  const head = pr.head.sha;
  if (head === originalHead || head === base) return false;
  if (originalBase !== undefined && (!SHA.test(originalBase) || originalBase === base))
    return false;
  const current = await refs(api, pr);
  if (current.head !== head || current.prHead !== head) return false;
  if (current.base !== base) {
    if (allowAdvancedBase !== true || !SHA.test(current.base || "")) return false;
    const advanced = await api.request(
      "GET",
      `${ROOT}/compare/${base}...${current.base}?per_page=1`
    );
    if (!currentComparison(advanced, base)) return false;
  }
  const commit = await api.request("GET", `${ROOT}/git/commits/${head}`);
  if (
    commit?.sha !== head ||
    !isDeepStrictEqual(
      commit.parents?.map(({ sha }) => sha),
      [originalHead, base]
    )
  )
    return false;
  const candidate = await api.request("GET", `${ROOT}/compare/${base}...${head}?per_page=1`);
  if (!currentComparison(candidate, base)) return false;
  try {
    repairFilesOK(candidate.files);
  } catch {
    return false;
  }
  if (originalBase) {
    const source = await api.request(
      "GET",
      `${ROOT}/compare/${originalBase}...${originalHead}?per_page=1`
    );
    if (
      !currentComparison(source, originalBase) ||
      !Array.isArray(source.files) ||
      !isDeepStrictEqual(
        compatibilityAppFiles(source.files),
        compatibilityAppFiles(candidate.files)
      )
    )
      return false;
  }
  const [previousTree, refreshedTree] = await Promise.all([
    readTree(api, originalHead),
    readTree(api, head, commit),
  ]);
  const present = candidate.files
    .filter(({ status }) => status !== "removed")
    .map(({ filename: path }) => ({ path }));
  try {
    verifyRegularFiles(refreshedTree.byPath, present, true);
    for (const [file, status] of compatibilityAppFiles(candidate.files)) {
      const before = previousTree.byPath.get(file.toLowerCase());
      const after = refreshedTree.byPath.get(file.toLowerCase());
      if (status === "removed") {
        if (before || after) return false;
      } else {
        verifyRegularFiles(previousTree.byPath, [{ path: file }], true);
        if (!SHA.test(before?.sha || "") || before.sha !== after?.sha) return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

module.exports = {
  classifyNativeUpdate,
  verifyNativeLockScope,
  normalizeNativeLockScope,
  readDependencySource,
  repairFilesOK,
  prepareCompatibility,
  applyCompatibility,
  requestCompatibilityRefresh,
  validCompatibilityRefresh,
};
