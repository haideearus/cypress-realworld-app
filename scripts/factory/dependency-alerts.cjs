const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./github.cjs");
const { OWNER, REPOSITORY, SHA, assertSubscriptionEnv } = require("./policy.cjs");
const { toolsAt } = require("./dependency-analysis.cjs");

const API = "https://api.github.com";
const ALERT_PATHS = [ROOT + "/dependabot/alerts", "/repositories/1453935262/dependabot/alerts"];
const PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const SEVERITY = ["low", "medium", "high", "critical"];
const PREVIEW_LIMIT = 10;
const ranges = (range, semver) =>
  typeof range === "string" && range.trim() ? semver.validRange(range.replaceAll(",", " ")) : null;

async function readJSON(url, transport, { token, maxBytes = 1048576, accept } = {}) {
  const response = await transport(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: accept || "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } : {}),
    },
  });
  if (!response.ok || !response.body) throw Error("Dependency alert metadata unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw Error("Dependency alert metadata exceeds size limit");
    }
    chunks.push(Buffer.from(value));
  }
  return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: response.headers };
}

async function listAlerts(token, transport = fetch) {
  if (!token) throw Error("A repository-scoped Dependabot read token is required");
  const alerts = [];
  let next = API + ALERT_PATHS[0] + "?state=open&per_page=100";
  for (let page = 0; next && page < 5; page++) {
    const url = new URL(next);
    if (url.origin !== API || !ALERT_PATHS.includes(url.pathname) || url.username || url.password)
      throw Error("Invalid Dependabot pagination destination");
    const { body, headers } = await readJSON(url, transport, { token });
    if (!Array.isArray(body) || body.length > 100) throw Error("Invalid Dependabot alert page");
    alerts.push(...body);
    next = headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1];
  }
  if (next) throw Error("Dependabot preview exceeds 500 alerts");
  return alerts;
}

function groupsFor(alerts, lock, semver) {
  const groups = new Map();
  const seen = new Set();
  for (const row of alerts) {
    const dependency = row.dependency;
    const name = dependency?.package?.name;
    if (
      row.state !== "open" ||
      dependency?.manifest_path !== "yarn.lock" ||
      dependency?.package?.ecosystem !== "npm" ||
      typeof name !== "string" ||
      name.length > 214 ||
      !PACKAGE.test(name) ||
      !Number.isSafeInteger(row.number) ||
      row.number < 1 ||
      seen.has(row.number)
    )
      continue;
    seen.add(row.number);
    const vulnerability = row.security_vulnerability;
    const alert = {
      number: row.number,
      range: ranges(vulnerability?.vulnerable_version_range, semver),
      patched: vulnerability?.first_patched_version?.identifier,
      severity: SEVERITY.indexOf(vulnerability?.severity),
      runtime: dependency.scope === "runtime",
    };
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(alert);
  }
  return Array.from(groups, ([name, rows]) => {
    const entries = Object.entries(lock)
      .map(([key, value]) => [key.includes("@npm:") ? key.split("@npm:").at(-1) : key, value])
      .filter(([key]) => key.startsWith(name + "@"))
      .map(([key, value]) => ({ selector: key.slice(name.length + 1), version: value?.version }));
    const applicable = rows.filter(
      (a) => !a.range || entries.some((e) => semver.satisfies(e.version, a.range))
    );
    return {
      name,
      alerts: applicable.sort((a, b) => a.number - b.number),
      severity: Math.max(-1, ...applicable.map((a) => a.severity)),
      runtime: applicable.some((a) => a.runtime),
      entries: entries.filter((e) =>
        applicable.some((a) => a.range && semver.satisfies(e.version, a.range))
      ),
    };
  })
    .filter((g) => g.alerts.length)
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        Number(b.runtime) - Number(a.runtime) ||
        a.name.localeCompare(b.name)
    );
}

function planGroup(group, releases, knownRanges, semver) {
  const result = {
    package: group.name,
    severity: SEVERITY[group.severity] || "unknown",
    scope: group.runtime ? "runtime" : "development",
    alerts: group.alerts.map((a) => a.number),
    locked: [...new Set(group.entries.map((e) => e.version))].sort(semver.compare),
  };
  const excluded = knownRanges.map((range) => ranges(range, semver));
  if (
    excluded.some((range) => !range) ||
    group.alerts.some((a) => !a.range || a.severity < 0 || !semver.valid(a.patched))
  )
    return { ...result, status: "advisory-held" };
  const next = releases
    .filter((v) => semver.valid(v) && !semver.prerelease(v))
    .sort(semver.compare)
    .find(
      (v) =>
        group.entries.length > 0 &&
        group.entries.every(
          (e) =>
            semver.gt(v, e.version) &&
            semver.major(v) === semver.major(e.version) &&
            semver.satisfies(v, e.selector)
        ) &&
        group.alerts.every((a) => semver.gte(v, a.patched) && !semver.satisfies(v, a.range)) &&
        excluded.every((range) => !semver.satisfies(v, range))
    );
  return next
    ? { ...result, status: "compatible-candidate", candidate: next }
    : { ...result, status: "no-common-candidate" };
}

async function packagePlan(group, semver, transport) {
  const name = encodeURIComponent(group.name);
  const [advisories, registry] = await Promise.all([
    readJSON(
      new URL(`${API}/advisories?type=reviewed&ecosystem=npm&per_page=100&affects=${name}`),
      transport
    ),
    readJSON(new URL(`https://registry.npmjs.org/${name}`), transport, {
      accept: "application/vnd.npm.install-v1+json",
      maxBytes: 8388608,
    }),
  ]);
  if (
    !Array.isArray(advisories.body) ||
    advisories.headers.get("link")?.includes('rel="next"') ||
    !registry.body?.versions ||
    typeof registry.body.versions !== "object"
  )
    throw Error("Incomplete candidate metadata");
  const affected = advisories.body
    .filter((a) => !a.withdrawn_at)
    .flatMap((a) => a.vulnerabilities)
    .filter((v) => v.package?.ecosystem === "npm" && v.package.name === group.name)
    .map((v) => v.vulnerable_version_range);
  return planGroup(group, Object.keys(registry.body.versions), affected, semver);
}

async function preview(token, lockText, tools, transport = fetch) {
  if (
    typeof lockText !== "string" ||
    Buffer.byteLength(lockText) > 2097152 ||
    lockText.includes("\0")
  )
    throw Error("Invalid alert preview lockfile size");
  const parsed = tools.lockfile.parse(lockText);
  if (parsed.type !== "success" || !parsed.object || Object.keys(parsed.object).length > 10000)
    throw Error("Invalid alert preview lockfile");
  const alerts = await listAlerts(token, transport);
  const groups = groupsFor(alerts, parsed.object, tools.semver);
  const plans = [];
  for (const group of groups.slice(0, PREVIEW_LIMIT)) {
    try {
      plans.push(await packagePlan(group, tools.semver, transport));
    } catch {
      plans.push({
        package: group.name,
        alerts: group.alerts.map((a) => a.number),
        status: "metadata-held",
      });
    }
  }
  return {
    outcome: "preview",
    modelCalls: 0,
    openAlerts: alerts.length,
    groups: groups.length,
    plans,
  };
}

function publicSummary({ outcome, modelCalls, groups, plans }) {
  const compatibleCandidates = plans.filter((p) => p.status === "compatible-candidate").length;
  return {
    outcome,
    modelCalls,
    groups,
    evaluated: plans.length,
    compatibleCandidates,
    holds: plans.length - compatibleCandidates,
  };
}

async function main(env = process.env) {
  assertSubscriptionEnv(env);
  if (
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_ACTOR !== OWNER ||
    env.GITHUB_TRIGGERING_ACTOR !== OWNER ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_RUN_ATTEMPT !== "1" ||
    !SHA.test(env.GITHUB_SHA || "") ||
    env.GITHUB_SHA !== env.GITHUB_WORKFLOW_SHA
  )
    throw Error("Unauthorized dependency alert preview context");
  const result = await preview(
    env.DEPENDABOT_READ_TOKEN,
    fs.readFileSync("yarn.lock", "utf8"),
    toolsAt(path.join(__dirname, "dependency-tools"))
  );
  // Actions logs and job summaries are public in this repository.
  const json = JSON.stringify({ head: env.GITHUB_SHA, ...publicSummary(result) }, null, 2);
  console.log(json);
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### Dependabot ticket preview\n\n\`\`\`json\n${json}\n\`\`\`\n`
    );
}

if (require.main === module)
  main().catch(() => {
    console.error(
      "Dependabot ticket preview refused. Check repository context and read permission."
    );
    process.exitCode = 1;
  });

module.exports = { groupsFor, planGroup, listAlerts, preview, publicSummary, main };
