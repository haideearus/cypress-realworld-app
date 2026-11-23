const fs = require("node:fs");
const path = require("node:path");
const { digest, REPOSITORY, SHA, HASH } = require("./dependency-contract.cjs");
class VulnerableDependencyCandidate extends Error {}
const fail = (reason) => {
  throw new Error(reason);
};
function toolsAt(directory) {
  return {
    lockfile: require(path.join(directory, "node_modules/@yarnpkg/lockfile")),
    semver: require(path.join(directory, "node_modules/semver")),
  };
}
function json(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65536)
    fail("Invalid dependency manifest size");
  const o = JSON.parse(text);
  if (!o || Array.isArray(o) || typeof o !== "object") fail("Invalid dependency manifest");
  return o;
}
const canonical = (x) =>
  Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])])
        )
      : x;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function compatible(a, b, semver, wider) {
  if (!semver.valid(a) || !semver.valid(b) || semver.prerelease(a) || semver.prerelease(b))
    fail("Unsupported dependency version");
  if (!wider && semver.major(a) !== semver.major(b)) fail("Dependency major update held");
  if (semver.lt(b, a)) fail("Dependency downgrade held");
}
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const selectorParts = (selector) => /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(.+)$/i.exec(selector);
function dependencyEntries(object, section) {
  if (!Object.hasOwn(object, section)) return [];
  const map = object[section];
  if (!map || typeof map !== "object" || Array.isArray(map)) fail("Invalid dependency map");
  const entries = Object.entries(map);
  for (const [name, range] of entries)
    if (!packageName.test(name) || typeof range !== "string" || !range || range.length > 500)
      fail("Unsupported dependency selector");
  return entries;
}
function reachableSelectors(roots, lock, edgesOf, semver) {
  const visited = new Set();
  const pending = [];
  const visit = (selector) => {
    if (visited.has(selector)) return;
    const entry = lock[selector];
    if (!entry) fail("Incomplete reachable dependency edge");
    if (typeof entry !== "object" || Array.isArray(entry) || !semver.valid(entry.version))
      fail("Invalid reachable dependency version");
    const range = selectorParts(selector)?.[2];
    if (range && semver.validRange(range) && !semver.satisfies(entry.version, range))
      fail("Dependency version outside selector range");
    visited.add(selector);
    pending.push(entry);
  };
  for (const [name, range] of roots) visit(name + "@" + range);
  const traversed = new Set();
  while (pending.length) {
    const entry = pending.pop();
    if (traversed.has(entry)) continue;
    traversed.add(entry);
    for (const [name, range] of edgesOf(entry)) visit(name + "@" + range);
  }
  return visited;
}
function inspectUpdate(
  baseManifest,
  headManifest,
  baseLock,
  headLock,
  tools,
  details = false,
  options = {}
) {
  const wider = options.wider === true;
  const { lockfile, semver } = tools;
  const a = json(baseManifest),
    b = json(headManifest);
  const sections = ["dependencies", "devDependencies"];
  const other = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !sections.includes(k)));
  if (!same(other(a), other(b))) fail("Forbidden manifest configuration change");
  const manifestRange = (range) =>
    wider
      ? typeof range === "string" && semver.validRange(range)
      : /^[~^]?\d+\.\d+\.\d+$/.test(range);
  let directEdits = 0;
  for (const section of sections) {
    if (wider && Object.hasOwn(a, section) !== Object.hasOwn(b, section))
      fail("Dependency manifest sections changed");
    const before = a[section] || {},
      after = b[section] || {};
    if (!same(Object.keys(before).sort(), Object.keys(after).sort()))
      fail("Dependency manifest names changed");
    for (const name of Object.keys(before)) {
      if (before[name] === after[name]) continue;
      if (wider && ++directEdits > 4) fail("Dependency manifest exceeds direct edit limit");
      if (!manifestRange(before[name]) || !manifestRange(after[name]))
        fail("Unsupported manifest version range");
      compatible(
        semver.minVersion(before[name])?.version,
        semver.minVersion(after[name])?.version,
        semver,
        wider
      );
    }
  }
  const parse = (text) => {
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text) > 2097152 ||
      /\0|(?:^|\n)\s*["']?(?:__proto__|constructor|prototype)["']?(?:\s|:)/.test(text)
    )
      fail("Unsafe dependency lockfile");
    const r = lockfile.parse(text);
    if (r.type !== "success" || !r.object || Object.keys(r.object).length > 10000)
      fail("Invalid dependency lockfile");
    return r.object;
  };
  const old = parse(baseLock),
    next = parse(headLock);
  const retargetedNames = new Set();
  const selectedCandidateIds = new Set();
  const nameOf = (selector) => {
    const m = selectorParts(selector);
    if (!m || !semver.validRange(m[2]) || /(?:git|https?|file|link|npm):/.test(m[2]))
      fail("Unsupported dependency selector");
    return m[1];
  };
  const inventoryName = (selector) => {
    const alias = wider
      ? selectorParts(selector)?.[2]?.startsWith("npm:")
      : selector.includes("@npm:");
    const source = alias ? selector.slice(selector.indexOf("@npm:") + 5) : selector;
    if (wider) {
      if (source !== selector && packageName.test(source)) return source;
      const parts = selectorParts(source);
      if (parts && /^[a-z][a-z0-9._-]*$/i.test(parts[2])) return parts[1];
    }
    return nameOf(source);
  };
  const validateEntry = (selector, entry, baseline = false) => {
    const name = baseline ? inventoryName(selector) : nameOf(selector);
    if (
      !entry ||
      typeof entry !== "object" ||
      !semver.valid(entry.version) ||
      semver.prerelease(entry.version) ||
      Object.keys(entry).some(
        (k) =>
          !["version", "resolved", "integrity", "dependencies", "optionalDependencies"].includes(k)
      )
    )
      fail("Invalid dependency version");
    let u;
    try {
      u = new URL(entry.resolved);
    } catch {
      fail("Invalid registry source");
    }
    if (
      u.protocol !== "https:" ||
      !["registry.npmjs.org", "registry.yarnpkg.com"].includes(u.hostname) ||
      u.port ||
      u.username ||
      u.password ||
      u.search ||
      (u.hash && !/^#[a-f0-9]{40}$/.test(u.hash))
    )
      fail("Invalid registry source");
    if (
      decodeURIComponent(u.pathname) !== `/${name}/-/${name.split("/").at(-1)}-${entry.version}.tgz`
    )
      fail("Invalid registry package source");
    const m = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(entry.integrity || "");
    const sizes = { sha512: 64, sha384: 48, sha256: 32, sha1: 20 };
    if (
      !m ||
      Buffer.from(m[2], "base64").length !== sizes[m[1]] ||
      Buffer.from(m[2], "base64").toString("base64") !== m[2]
    )
      fail("Invalid dependency integrity");
    return name;
  };
  const entriesByObject = new Map();
  const edgesOf = (entry) => {
    if (!entriesByObject.has(entry)) {
      const edges = new Map(dependencyEntries(entry, "dependencies"));
      for (const [name, range] of dependencyEntries(entry, "optionalDependencies")) {
        if (edges.has(name) && edges.get(name) !== range)
          fail("Ambiguous optional dependency edge");
        edges.set(name, range);
      }
      entriesByObject.set(entry, edges);
    }
    return entriesByObject.get(entry);
  };
  const rootSections = [...sections, "optionalDependencies"];
  const rootsOf = (manifest) =>
    rootSections.flatMap((section) => dependencyEntries(manifest, section));
  const oldReachable = wider ? reachableSelectors(rootsOf(a), old, edgesOf, semver) : undefined;
  const nextReachable = wider ? reachableSelectors(rootsOf(b), next, edgesOf, semver) : undefined;
  const knownReleases = new Map();
  const contentsByObject = new Map();
  const contents = (entry) => {
    if (!contentsByObject.has(entry)) contentsByObject.set(entry, JSON.stringify(canonical(entry)));
    return contentsByObject.get(entry);
  };
  const sameEntry = wider ? (before, after) => contents(before) === contents(after) : same;
  if (wider) {
    for (const [selector, entry] of Object.entries(old)) {
      const id = inventoryName(selector) + "@" + entry.version;
      if (!knownReleases.has(id)) knownReleases.set(id, new Set());
      knownReleases.get(id).add(contents(entry));
      if (!Object.hasOwn(next, selector)) {
        if (!oldReachable.has(selector)) fail("Unreachable dependency removal held");
        nameOf(selector);
      }
    }
  }
  // Compare actual base/candidate paths. A reused node can select a new reused
  // descendant even though neither identity was added to the lock inventory.
  const oldIds = new Map(Object.values(old).map((entry, i) => [entry, i]));
  const visited = new Set(),
    selectedSelectors = new Set();
  function followSelection(previous, selector) {
    const pending = [[previous, selector]];
    while (pending.length) {
      const [before, target] = pending.pop();
      const key = (before ? oldIds.get(before) : "new") + ":" + target;
      if (visited.has(key)) continue;
      visited.add(key);
      if (visited.size > 500) fail("Dependency selection exceeds inventory limit");
      const entry = next[target];
      if (!entry) fail("Incomplete candidate dependency edge");
      const name = validateEntry(target, entry);
      if (before) compatible(before.version, entry.version, semver, wider);
      selectedSelectors.add(target);
      retargetedNames.add(name);
      selectedCandidateIds.add(name + "@" + entry.version);
      const edges = wider
        ? edgesOf(entry)
        : Object.entries({ ...entry.dependencies, ...entry.optionalDependencies });
      for (const [child, range] of edges) {
        const candidate = next[child + "@" + range];
        if (!candidate) fail("Incomplete candidate dependency edge");
        const priorRange =
          wider && before
            ? edgesOf(before).get(child)
            : before?.dependencies?.[child] || before?.optionalDependencies?.[child];
        const prior = priorRange ? old[child + "@" + priorRange] : undefined;
        if (priorRange && !prior) fail("Incomplete base dependency edge");
        const changedOptionality =
          wider &&
          priorRange &&
          Object.hasOwn(entry.optionalDependencies || {}, child) !==
            Object.hasOwn(before.optionalDependencies || {}, child);
        if (priorRange !== range || changedOptionality || !sameEntry(prior, candidate)) {
          if (wider && priorRange) nameOf(child + "@" + priorRange);
          pending.push([prior, child + "@" + range]);
        }
        if (pending.length > 500) fail("Dependency selection exceeds inventory limit");
      }
    }
  }
  for (const [selector, entry] of Object.entries(next)) {
    const before = old[selector];
    if (sameEntry(before, entry)) continue;
    if (wider && !nextReachable.has(selector)) fail("Unreachable dependency change held");
    const name = validateEntry(selector, entry);
    const id = name + "@" + entry.version;
    if (wider) {
      const known = knownReleases.get(id);
      if (before?.version === entry.version || (known && !known.has(contents(entry))))
        fail("Same dependency release metadata changed");
      if (!known) knownReleases.set(id, new Set([contents(entry)]));
    }
    selectedCandidateIds.add(id);
    if (before) followSelection(before, selector);
    else if (!wider) {
      const previous = Object.entries(old)
        .filter(([s]) => inventoryName(s) === name)
        .map(([, e]) => e.version);
      if (
        previous.length &&
        !previous.some(
          (v) => semver.major(v) === semver.major(entry.version) && semver.lte(v, entry.version)
        )
      )
        fail("Dependency major version or downgrade held");
    }
  }
  const rootChanges = wider
    ? rootSections.flatMap((section) =>
        dependencyEntries(b, section).map(([name, range]) => [name, range, a[section]?.[name]])
      )
    : Object.entries({
        ...b.dependencies,
        ...b.devDependencies,
        ...b.optionalDependencies,
      }).map(([name, range]) => [
        name,
        range,
        a.dependencies?.[name] || a.devDependencies?.[name] || a.optionalDependencies?.[name],
      ]);
  for (const [name, range, previousRange] of rootChanges) {
    const selector = name + "@" + range;
    const entry = next[selector];
    if (!entry || (!wider && !semver.satisfies(entry.version, range)))
      fail("Incomplete root dependency lock");
    const previous = old[name + "@" + previousRange];
    if (!previous) fail("Incomplete base root dependency edge");
    if (previousRange !== range || !sameEntry(previous, entry)) followSelection(previous, selector);
  }
  // New selectors must be attributable to an actual changed path; guessing from
  // every historical version both misses nested changes and mislabels baselines.
  for (const selector of Object.keys(next))
    if (!old[selector] && !selectedSelectors.has(selector))
      fail("Ambiguous dependency graph transition");
  const inventory = (obj) =>
    new Map(
      Object.entries(obj).map(([s, e]) => [
        inventoryName(s) + "@" + e.version,
        { name: inventoryName(s), version: e.version },
      ])
    );
  const oi = inventory(old),
    ni = inventory(next);
  const affectedNames = new Set(
    [...new Set([...Object.keys(old), ...Object.keys(next)])]
      .filter((s) => !sameEntry(old[s], next[s]))
      .map(inventoryName)
  );
  for (const name of retargetedNames) affectedNames.add(name);
  for (const section of sections)
    for (const name of Object.keys(b[section] || {}))
      if (a[section]?.[name] !== b[section][name]) affectedNames.add(name);
  const removed = [...oi].filter(([k]) => !ni.has(k));
  const added = [...ni].filter(([k]) => !oi.has(k));
  const queries = [
    ...removed.map(([, e]) => ({ ...e, side: "removed" })),
    ...[...ni]
      .filter(([, e]) => affectedNames.has(e.name))
      .map(([k, e]) => ({
        ...e,
        side: !oi.has(k) ? "added" : selectedCandidateIds.has(k) ? "retained" : "baseline",
      })),
  ];
  if (queries.length > 500) fail("Dependency update exceeds inventory limit");
  const result = {
    changed: removed.length + added.length || affectedNames.size,
    candidateVersions: queries.filter((q) => q.side !== "removed").length,
    queries,
  };
  if (details) {
    result.registryEntries = queries
      .filter((q) => q.side !== "removed")
      .map((q) => ({
        name: q.name,
        version: q.version,
        entries: Object.entries(next)
          .filter(([s, e]) => inventoryName(s) === q.name && e.version === q.version)
          .map(([s, e]) => {
            validateEntry(s, e, wider && !selectedSelectors.has(s) && sameEntry(old[s], e));
            return { resolved: e.resolved, integrity: e.integrity };
          }),
      }));
  }
  return result;
}
async function boundedJSON(response) {
  require("./dependency-evidence-http.cjs").checkAvailability(response, "OSV");
  if (!response.ok) fail("OSV unavailable");
  const reader = response.body?.getReader();
  if (!reader) fail("OSV response unavailable");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1048576) {
        await reader.cancel();
        fail("OSV response oversized");
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("OSV response invalid");
  } finally {
    reader.releaseLock();
  }
}
async function queryOsv(queries, transport = fetch, details = false) {
  if (
    !Array.isArray(queries) ||
    queries.length > 500 ||
    queries.some(
      (q) =>
        !q ||
        !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(q.name) ||
        typeof q.version !== "string" ||
        q.version.length > 100 ||
        !["added", "removed", "retained", "baseline"].includes(q.side)
    )
  )
    fail("Invalid OSV query");
  const old = new Set(),
    added = new Set(),
    baseline = new Set();
  const packages = [];
  for (let start = 0; start < queries.length; start += 100) {
    const batch = queries.slice(start, start + 100);
    let r;
    try {
      r = await transport("https://api.osv.dev/v1/querybatch", {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: batch.map((q) => ({
            package: { ecosystem: "npm", name: q.name },
            version: q.version,
          })),
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      fail("OSV unavailable");
    }
    const data = await boundedJSON(r);
    if (!Array.isArray(data.results) || data.results.length !== batch.length)
      fail("Invalid OSV response");
    data.results.forEach((item, i) => {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).some((k) => !["vulns", "next_page_token"].includes(k)) ||
        item.next_page_token !== undefined ||
        (item.vulns !== undefined && (!Array.isArray(item.vulns) || item.vulns.length > 500))
      )
        fail("OSV partial or malformed response");
      for (const v of item.vulns || []) {
        if (!v || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(v.id || ""))
          fail("Invalid OSV response identifier");
        (batch[i].side === "removed" ? old : batch[i].side === "baseline" ? baseline : added).add(
          v.id
        );
      }
      if (details)
        packages.push({
          ...batch[i],
          vulnerabilities: (item.vulns || []).map((v) => ({ id: v.id, modified: v.modified })),
        });
    });
  }
  if (added.size)
    throw new VulnerableDependencyCandidate(
      "Known vulnerable candidate dependency version retained or introduced"
    );
  return {
    cleared: [...old].filter((id) => !baseline.has(id)).sort(),
    remainingBaseline: [...baseline].sort(),
    candidateVersions: queries.filter((q) => q.side !== "removed").length,
    ...(details ? { packages } : {}),
  };
}
const keys = [
  "version",
  "repository",
  "pr",
  "base",
  "head",
  "workflowSha",
  "runId",
  "runAttempt",
  "stage",
  "toolDigest",
  "at",
  "result",
]
  .sort()
  .join(",");
function reportFor(identity, result, now = new Date()) {
  return { version: 2, ...identity, at: now.toISOString(), result };
}
function validateReport(r, expected, now = new Date()) {
  if (
    !r ||
    Object.keys(r).sort().join(",") !== keys ||
    r.version !== 2 ||
    r.repository !== REPOSITORY ||
    !Number.isSafeInteger(r.pr) ||
    r.pr < 1 ||
    !["base", "head", "workflowSha"].every((k) => SHA.test(r[k] || "")) ||
    !HASH.test(r.toolDigest || "") ||
    !/^[1-9]\d*$/.test(r.runId || "") ||
    !Number.isSafeInteger(r.runAttempt) ||
    r.runAttempt < 1 ||
    !["analysis", "premerge"].includes(r.stage) ||
    !r.result ||
    Object.keys(r.result).sort().join(",") !==
      "candidateVersions,changed,cleared,remainingBaseline" ||
    !Number.isSafeInteger(r.result.changed) ||
    r.result.changed < 1 ||
    r.result.changed > 500 ||
    !Number.isSafeInteger(r.result.candidateVersions) ||
    r.result.candidateVersions < 0 ||
    r.result.candidateVersions > 500 ||
    !Array.isArray(r.result.cleared) ||
    r.result.cleared.length > 500 ||
    new Set(r.result.cleared).size !== r.result.cleared.length ||
    r.result.cleared.some((x) => !/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(x)) ||
    !Array.isArray(r.result.remainingBaseline) ||
    r.result.remainingBaseline.length + r.result.cleared.length > 500 ||
    new Set(r.result.remainingBaseline).size !== r.result.remainingBaseline.length ||
    r.result.remainingBaseline.some(
      (x) => !/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(x) || r.result.cleared.includes(x)
    )
  )
    fail("Invalid dependency report");
  for (const [key, value] of Object.entries(expected))
    if (r[key] !== value) fail("Dependency report identity mismatch");
  const age = now.getTime() - Date.parse(r.at);
  if (!Number.isFinite(age) || new Date(r.at).toISOString() !== r.at || age < -5000 || age > 300000)
    fail("Dependency report stale time");
  return r;
}
function toolDigest() {
  return digest(
    fs.readFileSync(path.join(__dirname, "dependency-tools/package-lock.json"), "utf8")
  );
}
module.exports = {
  inspectUpdate,
  queryOsv,
  reportFor,
  validateReport,
  toolDigest,
  toolsAt,
  VulnerableDependencyCandidate,
};
