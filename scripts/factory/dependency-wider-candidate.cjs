const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { PublicEvidenceError, checkAvailability } = require("./dependency-evidence-http.cjs");

const REGISTRY = "https://registry.npmjs.org";
const ROOT_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
const MAX_ROOT_CHANGES = 4;
const MAX_ROOTS_TO_SEARCH = 24;
const MAX_ATTEMPTS = 64;
const MAX_RELEASE_CHOICES = 12;
const MAX_ADDED_SELECTORS = 100;
const MAX_REGISTRY_REQUESTS = 48;
const MAX_LOCK_SELECTORS = 10000;
const MAX_RELEASES = 16000;
const MAX_RANGE_BYTES = 256;

class CandidateHold extends Error {}
class SearchLimit extends CandidateHold {}

function requireCandidate(condition) {
  if (!condition) throw new CandidateHold("Unsupported dependency candidate");
}

const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const safeNamePart = /^[a-z0-9][a-z0-9._-]*$/;
const reservedName = (name) => ["constructor", "prototype", "__proto__"].includes(name);
const validName = (name) => {
  if (typeof name !== "string" || name.length > 214) return false;
  const parts = name.startsWith("@") ? name.slice(1).split("/") : [name];
  return (
    parts.length === (name.startsWith("@") ? 2 : 1) &&
    parts.every((part) => safeNamePart.test(part) && !/[\r\n]/.test(part) && !reservedName(part))
  );
};
const validRange = (range, semver) =>
  typeof range === "string" &&
  range.length > 0 &&
  range.length <= MAX_RANGE_BYTES &&
  !/[\x00-\x1f\x7f]/.test(range) &&
  Boolean(range.trim()) &&
  Boolean(semver.validRange(range));
const stable = (version, semver) =>
  typeof version === "string" &&
  /^\d+\.\d+\.\d+$/.test(version) &&
  !/[\r\n]/.test(version) &&
  semver.valid(version) === version;
const tarballPath = (name, version) => `/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
function selectorName(selector) {
  const divider = selector.indexOf("@", 1);
  return divider < 0 ? "" : selector.slice(0, divider);
}
const selectorRange = (selector) => selector.slice(selector.indexOf("@", 1) + 1);
const majorStep = (before, after, semver) =>
  stable(before, semver) &&
  stable(after, semver) &&
  semver.gte(after, before) &&
  semver.major(after) - semver.major(before) <= 1;

function entriesOf(section) {
  if (section === undefined) return [];
  requireCandidate(record(section));
  const entries = Object.entries(section);
  requireCandidate(entries.length <= 500);
  return entries;
}

function edgeMap(entry) {
  requireCandidate(record(entry));
  const edges = new Map(entriesOf(entry.dependencies));
  for (const [name, range] of entriesOf(entry.optionalDependencies)) {
    requireCandidate(!edges.has(name) || edges.get(name) === range);
    edges.set(name, range);
  }
  for (const [name, range] of edges) {
    requireCandidate(
      name &&
        !reservedName(name) &&
        typeof range === "string" &&
        range.length > 0 &&
        range.length <= 1024 &&
        !/[\x00-\x1f\x7f]/.test(range)
    );
  }
  return edges;
}

function readBase(manifestText, lockText, tools) {
  const { lockfile } = tools;
  requireCandidate(
    typeof manifestText === "string" &&
      Buffer.byteLength(manifestText) <= 65536 &&
      typeof lockText === "string" &&
      Buffer.byteLength(lockText) <= 2097152 &&
      !/\0|(?:^|\n)\s*["']?(?:__proto__|constructor|prototype)["']?(?:\s|:)/.test(lockText)
  );
  let manifest;
  let parsed;
  try {
    manifest = JSON.parse(manifestText);
    parsed = lockfile.parse(lockText);
  } catch {
    throw new CandidateHold("Invalid manifest or lockfile");
  }
  requireCandidate(record(manifest) && parsed.type === "success" && record(parsed.object));
  const old = parsed.object;
  requireCandidate(Object.keys(old).length <= MAX_LOCK_SELECTORS);

  const resolutions = new Set();
  for (const [name, range] of entriesOf(manifest.resolutions)) {
    requireCandidate(validName(name) && validRange(range, tools.semver));
    resolutions.add(name);
  }
  const roots = ROOT_SECTIONS.flatMap((section) =>
    entriesOf(manifest[section]).map(([name, range]) => {
      requireCandidate(validName(name) && typeof range === "string" && range.length <= 1024);
      return { section, name, range, selector: name + "@" + range };
    })
  );
  requireCandidate(roots.length <= 500);

  const edges = new Map();
  const parents = new Map();
  const pending = roots.map((root) => root.selector);
  for (let i = 0; i < pending.length; i++) {
    const selector = pending[i];
    if (edges.has(selector)) continue;
    requireCandidate(Object.hasOwn(old, selector));
    const range = selectorRange(selector);
    const { semver } = tools;
    requireCandidate(
      semver.valid(old[selector]?.version) &&
        (!validRange(range, semver) || semver.satisfies(old[selector].version, range))
    );
    const children = edgeMap(old[selector]);
    edges.set(selector, children);
    for (const [name, range] of children) {
      const child = name + "@" + range;
      if (!parents.has(child)) parents.set(child, new Set());
      parents.get(child).add(selector);
      pending.push(child);
    }
    requireCandidate(pending.length <= 40000);
  }
  return { manifest, old, roots, edges, parents, resolutions };
}

function readEvidence(group, plan, base, semver) {
  const evidence = plan?.upgradeEvidence;
  const name = group?.name;
  requireCandidate(
    validName(name) &&
      (!plan.package || plan.package === name) &&
      Array.isArray(evidence?.excluded) &&
      evidence.excluded.length <= 1000 &&
      evidence.excluded.every((range) => validRange(range, semver)) &&
      Array.isArray(evidence.releases) &&
      evidence.releases.length <= MAX_RELEASES &&
      evidence.releases.every((version) => stable(version, semver)) &&
      Array.isArray(group.alerts) &&
      group.alerts.length > 0 &&
      group.alerts.length <= 500 &&
      group.alerts.every(
        (alert) => validRange(alert?.range, semver) && semver.valid(alert.patched)
      ) &&
      Array.isArray(group.entries) &&
      group.entries.length > 0 &&
      group.entries.length <= 500 &&
      group.entries.every(
        (entry) => validRange(entry?.selector, semver) && stable(entry.version, semver)
      )
  );
  const alerts = group.alerts.map(({ range, patched }) => ({
    range: new semver.Range(range),
    patched,
  }));
  const excluded = [
    ...evidence.excluded.map((range) => new semver.Range(range)),
    ...alerts.map(({ range }) => range),
  ];
  const vulnerability = new Map();
  function isVulnerable(version) {
    if (!vulnerability.has(version)) {
      const parsed = new semver.SemVer(version);
      vulnerability.set(
        version,
        excluded.some((range) => range.test(parsed))
      );
    }
    return vulnerability.get(version);
  }
  const affected = new Map();
  for (const [selector, entry] of Object.entries(base.old)) {
    const range = selectorRange(selector);
    const alias = range.startsWith("npm:") ? range.slice(4) : undefined;
    if (
      selectorName(selector) !== name &&
      (!alias || (alias !== name && selectorName(alias) !== name))
    )
      continue;
    requireCandidate(validRange(range, semver) && stable(entry?.version, semver));
    requireCandidate(semver.satisfies(entry.version, range));
    if (isVulnerable(entry.version)) affected.set(selector, entry.version);
  }
  for (const { selector, version } of group.entries) {
    requireCandidate(affected.get(name + "@" + selector) === version && stable(version, semver));
  }
  const releases = [...new Set(evidence.releases)]
    .sort(semver.compare)
    .filter((v) => !isVulnerable(v));
  const cachedOptions = new Map();
  function options(range, previous) {
    const key = range + "\0" + (previous || "");
    if (!cachedOptions.has(key)) {
      const constraint = new semver.Range(range);
      const applicable = !previous ? [] : alerts.filter(({ range }) => range.test(previous));
      cachedOptions.set(
        key,
        releases.filter(
          (version) =>
            constraint.test(version) &&
            (!previous || majorStep(previous, version, semver)) &&
            applicable.every(({ patched }) => semver.gte(version, patched))
        )
      );
    }
    return cachedOptions.get(key);
  }
  return { name, affected, options, isVulnerable };
}

async function readRegistryJSON(transport, url, limit, signal, accept) {
  let response;
  try {
    response = await transport(url, {
      method: "GET",
      headers: { Accept: accept },
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
    });
  } catch {
    throw new PublicEvidenceError("public_service_unavailable", "npm");
  }
  requireCandidate(response);
  checkAvailability(response, "npm");
  if (response.status === 408 || (response.status >= 500 && response.status <= 599))
    throw new PublicEvidenceError("public_service_unavailable", "npm");
  requireCandidate(response.ok && !response.redirected && response.body?.getReader);
  requireCandidate(!response.url || response.url === url);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      requireCandidate(size + value.length <= limit);
      size += value.length;
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof CandidateHold) throw error;
    throw new PublicEvidenceError("public_service_unavailable", "npm");
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CandidateHold("Malformed npm response");
  }
}

function validIntegrity(integrity) {
  const match =
    typeof integrity === "string" &&
    /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match || match[0] !== integrity) return false;
  const bytes = Buffer.from(match[2], "base64");
  return (
    bytes.length === { sha512: 64, sha384: 48, sha256: 32, sha1: 20 }[match[1]] &&
    bytes.toString("base64") === match[2]
  );
}

function validateLockedSource(entry, name) {
  const path = tarballPath(name, entry.version);
  const normalized = typeof entry.resolved === "string" && entry.resolved.split("#");
  requireCandidate(
    normalized &&
      normalized.length <= 2 &&
      [REGISTRY + path, "https://registry.yarnpkg.com" + path].includes(normalized[0]) &&
      (normalized.length === 1 ||
        (/^[a-f0-9]{40}$/.test(normalized[1]) && normalized[1].length === 40)) &&
      validIntegrity(entry.integrity) &&
      Object.keys(entry).every((key) =>
        ["version", "resolved", "integrity", "dependencies", "optionalDependencies"].includes(key)
      )
  );
}

function registryFor(base, transport, signal, semver) {
  const requests = new Map();
  const identities = new Map();
  for (const [selector, entry] of Object.entries(base.old)) {
    const name = selectorName(selector);
    if (!validName(name) || !validRange(selectorRange(selector), semver) || !entry?.version)
      continue;
    const key = name + "@" + entry.version;
    if (!identities.has(key)) identities.set(key, entry);
    else if (!isDeepStrictEqual(identities.get(key), entry)) identities.set(key, null);
  }

  function get(name, version) {
    requireCandidate(validName(name) && (!version || stable(version, semver)));
    const key = version ? name + "@" + version : name;
    if (!requests.has(key)) {
      if (requests.size >= MAX_REGISTRY_REQUESTS || signal.aborted)
        throw new SearchLimit("npm lookup limit reached");
      requests.set(
        key,
        readRegistryJSON(
          transport,
          REGISTRY + "/" + encodeURIComponent(name) + (version ? "/" + version : ""),
          version ? 262144 : 8388608,
          signal,
          version ? "application/json" : "application/vnd.npm.install-v1+json"
        )
      );
    }
    return requests.get(key);
  }

  return {
    async versions(name) {
      const body = await get(name);
      requireCandidate(body?.name === name && record(body.versions));
      const versions = Object.keys(body.versions);
      requireCandidate(versions.length <= MAX_RELEASES);
      return versions.filter((version) => stable(version, semver)).sort(semver.compare);
    },
    async entry(name, version) {
      const key = name + "@" + version;
      if (identities.has(key)) {
        const existing = identities.get(key);
        requireCandidate(existing);
        validateLockedSource(existing, name);
        return existing;
      }
      const release = await get(name, version);
      const dist = release?.dist;
      const tarball = REGISTRY + tarballPath(name, version);
      requireCandidate(
        release?.name === name &&
          release.version === version &&
          dist?.tarball === tarball &&
          validIntegrity(dist.integrity) &&
          typeof dist.shasum === "string" &&
          dist.shasum.length === 40 &&
          /^[a-f0-9]{40}$/.test(dist.shasum) &&
          [release.bundleDependencies, release.bundledDependencies].every(
            (list) =>
              list === undefined || list === false || (Array.isArray(list) && list.length === 0)
          )
      );
      const entry = { version, resolved: tarball + "#" + dist.shasum, integrity: dist.integrity };
      for (const field of ["dependencies", "optionalDependencies"]) {
        const dependencies = entriesOf(release[field]);
        requireCandidate(
          dependencies.every(([child, range]) => validName(child) && validRange(range, semver))
        );
        if (dependencies.length) entry[field] = Object.fromEntries(dependencies);
      }
      return entry;
    },
  };
}

function rootChoices(base, evidence, semver) {
  function ancestors(selectors, stop) {
    const reached = new Set();
    const pending = [...selectors];
    for (let i = 0; i < pending.length; i++) {
      const selector = pending[i];
      if (reached.has(selector) || stop.has(selector)) continue;
      reached.add(selector);
      for (const parent of base.parents.get(selector) || []) pending.push(parent);
    }
    return reached;
  }
  const fixable = new Set();
  const blocked = new Set();
  for (const [selector, version] of evidence.affected) {
    (evidence.options(selectorRange(selector), version).length ? fixable : blocked).add(selector);
  }
  const reachable = ancestors(evidence.affected.keys(), new Set());
  const forced = ancestors(blocked, fixable);
  requireCandidate(
    !base.roots.some((root) => root.section === "optionalDependencies" && forced.has(root.selector))
  );
  const roots = base.roots.filter(
    (root) => root.section !== "optionalDependencies" && reachable.has(root.selector)
  );
  return {
    required: roots.filter((root) => forced.has(root.selector)),
    optional: roots.filter((root) => !forced.has(root.selector)),
  };
}

function* rootSets(required, optional, size, start = 0) {
  if (required.length === size) {
    yield required;
    return;
  }
  for (let i = start; i <= optional.length - (size - required.length); i++)
    yield* rootSets([...required, optional[i]], optional, size, i + 1);
}

function choose(options, decisions, tried) {
  const count = Math.min(options.length, MAX_RELEASE_CHOICES);
  const index = decisions[tried.length] || 0;
  requireCandidate(index < count);
  tried.push({ index, count });
  return options[index];
}

function nextDecisions(tried) {
  for (let i = tried.length - 1; i >= 0; i--) {
    if (tried[i].index + 1 < tried[i].count)
      return [...tried.slice(0, i).map((choice) => choice.index), tried[i].index + 1];
  }
  return null;
}

async function materialize(base, evidence, registry, pins, decisions, tried, input) {
  const { semver, lockfile } = input.tools;
  const manifest = JSON.parse(input.manifest);
  const pinSet = new Set(pins);
  const pending = [];
  let manifestChanged = false;
  for (const root of base.roots) {
    let selector = root.selector;
    if (pinSet.has(root)) {
      const previous = base.old[selector].version;
      requireCandidate(
        !base.resolutions.has(root.name) &&
          validRange(root.range, semver) &&
          stable(previous, semver) &&
          semver.satisfies(previous, root.range)
      );
      const releases =
        root.name === evidence.name
          ? evidence.options("*", previous)
          : await registry.versions(root.name);
      const versions = releases.filter(
        (version) => semver.gt(version, previous) && majorStep(previous, version, semver)
      );
      const version = choose(versions, decisions, tried);
      selector = root.name + "@" + version;
      manifest[root.section][root.name] = version;
      manifestChanged = true;
    }
    pending.push([selector, root.selector]);
  }

  const next = { ...base.old };
  const selected = new Set();
  const replaced = new Set();
  const visited = new Set();
  let additions = 0;
  let changedPaths = 0;
  for (let i = 0; i < pending.length; i++) {
    const [selector, previousSelector] = pending[i];
    const pair = selector + "\0" + (previousSelector || "");
    if (visited.has(pair)) continue;
    visited.add(pair);
    const previous = previousSelector ? base.old[previousSelector] : undefined;
    const original = base.old[selector];
    const name = selectorName(selector);
    const range = selectorRange(selector);
    const mustReplace =
      name === evidence.name && original && evidence.isVulnerable(original.version);
    if (!selected.has(selector) && (!original || mustReplace)) {
      requireCandidate(validName(name) && validRange(range, semver) && !base.resolutions.has(name));
      if (original) validateLockedSource(original, name);
      const priorVersion = original?.version || previous?.version;
      const versions =
        name === evidence.name
          ? evidence.options(range, priorVersion)
          : (stable(range, semver) ? [range] : await registry.versions(name)).filter(
              (version) =>
                semver.satisfies(version, range) &&
                (!priorVersion || majorStep(priorVersion, version, semver))
            );
      const version = choose(versions, decisions, tried);
      next[selector] = await registry.entry(name, version);
      if (!original) requireCandidate(++additions <= MAX_ADDED_SELECTORS);
    }
    const entry = next[selector];
    selected.add(selector);
    if (previousSelector !== selector || entry !== previous) {
      requireCandidate(
        ++changedPaths <= 500 &&
          validName(name) &&
          validRange(range, semver) &&
          !base.resolutions.has(name) &&
          stable(entry.version, semver) &&
          semver.satisfies(entry.version, range) &&
          (!previous || majorStep(previous.version, entry.version, semver))
      );
      validateLockedSource(entry, name);
      if (previous) {
        requireCandidate(validRange(selectorRange(previousSelector), semver));
        validateLockedSource(previous, name);
      }
      if (name === evidence.name) {
        requireCandidate(evidence.options(range, previous?.version).includes(entry.version));
        replaced.add(entry.version);
      }
    }
    const oldEdges = previous ? base.edges.get(previousSelector) || edgeMap(previous) : new Map();
    for (const [name, range] of entry === previous ? oldEdges : edgeMap(entry)) {
      const priorRange = oldEdges.get(name);
      const child = name + "@" + range;
      const prior = priorRange && name + "@" + priorRange;
      requireCandidate(!prior || Object.hasOwn(base.old, prior));
      pending.push([child, prior]);
    }
    requireCandidate(pending.length <= 40000);
  }
  for (const selector of base.edges.keys()) {
    if (selected.has(selector)) continue;
    const name = selectorName(selector);
    requireCandidate(
      validName(name) &&
        validRange(selectorRange(selector), semver) &&
        stable(base.old[selector].version, semver) &&
        !base.resolutions.has(name)
    );
    validateLockedSource(base.old[selector], name);
    delete next[selector];
  }
  const retained = Object.entries(next)
    .filter(([selector]) => selectorName(selector) === evidence.name)
    .map(([, entry]) => entry.version);
  requireCandidate(retained.every((version) => !evidence.isVulnerable(version)));
  const removed = retained.length === 0;
  const versions = replaced.size
    ? [...replaced]
    : removed
      ? [...evidence.affected.values()]
      : retained;
  const version = versions.sort(semver.compare)[0];
  const lock = lockfile.stringify(next);
  requireCandidate(
    lock !== input.lock &&
      Buffer.byteLength(lock) <= 2097152 &&
      Object.keys(next).length <= MAX_LOCK_SELECTORS
  );
  const suffix = input.manifest.match(/\r?\n$/)?.[0] || "";
  const indent = input.manifest.match(/\r?\n([ \t]+)"/)?.[1] || "";
  const serialized = JSON.stringify(manifest, null, indent);
  return {
    manifest: manifestChanged
      ? serialized.replaceAll("\n", suffix === "\r\n" ? "\r\n" : "\n") + suffix
      : input.manifest,
    lock,
    version,
    ...(removed && { removed: true }),
  };
}

async function buildWiderCandidate(input) {
  const { group, plan, tools, transport = fetch, version, accept = async () => true } = input;
  if (!plan?.upgradeEvidence) return null;
  const signal = AbortSignal.timeout(20000);
  try {
    const base = readBase(input.manifest, input.lock, tools);
    const evidence = readEvidence(group, plan, base, tools.semver);
    const registry = registryFor(base, transport, signal, tools.semver);
    const { required, optional } = rootChoices(base, evidence, tools.semver);
    let attempts = 0;
    const triedCandidates = new Set();
    for (let size = required.length; size <= MAX_ROOT_CHANGES; size++) {
      if (size > required.length && required.length + optional.length > MAX_ROOTS_TO_SEARCH) break;
      for (const pins of rootSets(required, optional, size)) {
        let decisions = [];
        do {
          if (++attempts > MAX_ATTEMPTS || signal.aborted) return null;
          const tried = [];
          let candidate;
          try {
            candidate = await materialize(base, evidence, registry, pins, decisions, tried, input);
          } catch (error) {
            if (error instanceof SearchLimit) return null;
            if (!(error instanceof CandidateHold)) throw error;
          }
          if (candidate && (!version || candidate.version === version) && !signal.aborted) {
            const key = createHash("sha256")
              .update(candidate.manifest)
              .update("\0")
              .update(candidate.lock)
              .digest("hex");
            if (!triedCandidates.has(key)) {
              triedCandidates.add(key);
              if ((await accept(candidate, signal)) && !signal.aborted) return candidate;
            }
          }
          decisions = nextDecisions(tried);
        } while (decisions);
      }
    }
    return null;
  } catch (error) {
    if (error instanceof CandidateHold) return null;
    throw error;
  }
}

module.exports = { buildWiderCandidate };
