const fs = require("node:fs");
const path = require("node:path");
const { digest, REPOSITORY, SHA, HASH } = require("./dependency-contract.cjs");
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
function compatible(a, b, semver) {
  if (!semver.valid(a) || !semver.valid(b) || semver.prerelease(a) || semver.prerelease(b))
    fail("Unsupported dependency version");
  if (semver.major(a) !== semver.major(b)) fail("Dependency major update held");
  if (semver.lt(b, a)) fail("Dependency downgrade held");
}
function inspectUpdate(baseManifest, headManifest, baseLock, headLock, tools, details = false) {
  const { lockfile, semver } = tools;
  const a = json(baseManifest),
    b = json(headManifest);
  const sections = ["dependencies", "devDependencies"];
  const other = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !sections.includes(k)));
  if (!same(other(a), other(b))) fail("Forbidden manifest configuration change");
  for (const section of sections) {
    const before = a[section] || {},
      after = b[section] || {};
    if (!same(Object.keys(before).sort(), Object.keys(after).sort()))
      fail("Dependency manifest names changed");
    for (const name of Object.keys(before)) {
      if (before[name] === after[name]) continue;
      if (!/^[~^]?\d+\.\d+\.\d+$/.test(before[name]) || !/^[~^]?\d+\.\d+\.\d+$/.test(after[name]))
        fail("Unsupported manifest version range");
      compatible(
        semver.minVersion(before[name]).version,
        semver.minVersion(after[name]).version,
        semver
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
  const nameOf = (selector) => {
    const m = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(.+)$/i.exec(selector);
    if (!m || !semver.validRange(m[2]) || /(?:git|https?|file|link|npm):/.test(m[2]))
      fail("Unsupported dependency selector");
    return m[1];
  };
  const inventoryName = (selector) =>
    selector.includes("@npm:")
      ? nameOf(selector.slice(selector.indexOf("@npm:") + 5))
      : nameOf(selector);
  const validateEntry = (selector, entry) => {
    const name = nameOf(selector);
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
  };
  for (const [selector, entry] of Object.entries(next)) {
    const before = old[selector];
    if (same(before, entry)) continue;
    validateEntry(selector, entry);
    if (before) compatible(before.version, entry.version, semver);
    else {
      const previous = Object.entries(old)
        .filter(([s]) => inventoryName(s) === nameOf(selector))
        .map(([, e]) => e.version);
      if (
        previous.length &&
        !previous.some(
          (v) => semver.major(v) === semver.major(entry.version) && semver.lte(v, entry.version)
        )
      )
        fail("Dependency major version or downgrade held");
    }
    for (const [child, range] of Object.entries({
      ...entry.dependencies,
      ...entry.optionalDependencies,
    })) {
      const resolved = next[child + "@" + range];
      if (!resolved) fail("Incomplete dependency lock edge");
      validateEntry(child + "@" + range, resolved);
      const predecessors = before
        ? [before]
        : Object.entries(old)
            .filter(
              ([s, e]) =>
                inventoryName(s) === nameOf(selector) &&
                semver.major(e.version) === semver.major(entry.version)
            )
            .map(([, e]) => e);
      for (const predecessor of predecessors) {
        const priorRange =
          predecessor.dependencies?.[child] || predecessor.optionalDependencies?.[child];
        if (!priorRange) continue;
        const prior = old[child + "@" + priorRange];
        if (!prior) fail("Incomplete base dependency edge");
        compatible(prior.version, resolved.version, semver);
      }
    }
  }
  for (const [name, range] of Object.entries({
    ...b.dependencies,
    ...b.devDependencies,
    ...b.optionalDependencies,
  })) {
    const e = next[name + "@" + range];
    if (!e || !semver.satisfies(e.version, range)) fail("Incomplete root dependency lock");
    const previousRange =
      a.dependencies?.[name] || a.devDependencies?.[name] || a.optionalDependencies?.[name];
    const previous = old[name + "@" + previousRange];
    if (!previous) fail("Incomplete base root dependency edge");
    // Existing prerelease baselines may stay unchanged. New/changed entries are
    // validated above; changed root resolutions still need the full version gate.
    if (previous.version !== e.version) compatible(previous.version, e.version, semver);
  }
  const inventory = (obj) =>
    new Map(
      Object.entries(obj).map(([s, e]) => [
        inventoryName(s) + "@" + e.version,
        { name: inventoryName(s), version: e.version },
      ])
    );
  const oi = inventory(old),
    ni = inventory(next);
  const queries = [
    ...[...oi].filter(([k]) => !ni.has(k)).map(([, e]) => ({ ...e, side: "removed" })),
    ...[...ni].filter(([k]) => !oi.has(k)).map(([, e]) => ({ ...e, side: "added" })),
  ];
  if (queries.length > 500) fail("Dependency update exceeds inventory limit");
  const result = { changed: queries.length, queries };
  if (details) {
    result.registryEntries = queries
      .filter((q) => q.side === "added")
      .map((q) => ({
        name: q.name,
        version: q.version,
        entries: Object.entries(next)
          .filter(([s, e]) => inventoryName(s) === q.name && e.version === q.version)
          .map(([s, e]) => {
            validateEntry(s, e);
            return { resolved: e.resolved, integrity: e.integrity };
          }),
      }));
  }
  return result;
}
async function boundedJSON(response) {
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
        !["added", "removed"].includes(q.side)
    )
  )
    fail("Invalid OSV query");
  const old = new Set(),
    added = new Set();
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
        (batch[i].side === "added" ? added : old).add(v.id);
      }
      if (details)
        packages.push({
          ...batch[i],
          vulnerabilities: (item.vulns || []).map((v) => ({ id: v.id, modified: v.modified })),
        });
    });
  }
  if (added.size) fail("Known vulnerable dependency version introduced");
  return { fixed: [...old].sort(), ...(details ? { packages } : {}) };
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
  return { version: 1, ...identity, at: now.toISOString(), result };
}
function validateReport(r, expected, now = new Date()) {
  if (
    !r ||
    Object.keys(r).sort().join(",") !== keys ||
    r.version !== 1 ||
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
    Object.keys(r.result).sort().join(",") !== "changed,fixed" ||
    !Number.isSafeInteger(r.result.changed) ||
    r.result.changed < 1 ||
    r.result.changed > 500 ||
    !Array.isArray(r.result.fixed) ||
    r.result.fixed.length > 500 ||
    r.result.fixed.some((x) => !/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(x))
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
module.exports = { inspectUpdate, queryOsv, reportFor, validateReport, toolDigest, toolsAt };
