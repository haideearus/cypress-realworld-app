const test = require("node:test");
const assert = require("node:assert/strict");
const {
  groupsFor,
  planGroup,
  listAlerts,
  publicSummary,
} = require("../factory/dependency-alerts.cjs");
const { toolsAt } = require("../factory/dependency-analysis.cjs");
const path = require("node:path");
const { semver } = toolsAt(path.resolve(__dirname, "../factory/dependency-tools"));
const { ROOT } = require("../factory/github.cjs");

function alert(number, name, severity, scope, range, patched) {
  return {
    number,
    state: "open",
    dependency: { package: { ecosystem: "npm", name }, manifest_path: "yarn.lock", scope },
    security_vulnerability: {
      severity,
      vulnerable_version_range: range,
      first_patched_version: patched ? { identifier: patched } : null,
    },
  };
}

test("groups current alerts and sorts critical runtime work first without excluding lower severity", () => {
  const groups = groupsFor(
    [
      alert(1, "low", "low", "runtime", "< 2.0.1", "2.0.1"),
      alert(2, "example", "critical", "development", "< 2.0.1", "2.0.1"),
      alert(3, "example", "high", "runtime", "< 2.0.2", "2.0.2"),
      alert(4, "dev", "critical", "development", "< 2.0.1", "2.0.1"),
      { ...alert(5, "closed", "critical", "runtime", "< 2.0.1", "2.0.1"), state: "fixed" },
    ],
    {
      "low@^2.0.0": { version: "2.0.0" },
      "example@^2.0.0": { version: "2.0.0" },
      "dev@^2.0.0": { version: "2.0.0" },
    },
    semver
  );
  assert.deepEqual(
    groups.map((g) => g.name),
    ["example", "dev", "low"]
  );
  assert.deepEqual(
    groups[0].alerts.map((a) => a.number),
    [2, 3]
  );
});

test("selects the smallest compatible release outside every known advisory range", () => {
  const [group] = groupsFor(
    [alert(1, "example", "high", "runtime", "< 2.0.1", "2.0.1")],
    { "example@^2.0.0": { version: "2.0.0" } },
    semver
  );
  assert.equal(
    planGroup(group, ["2.0.1", "2.1.0-beta.1", "2.1.0", "3.0.0"], [">= 2.0.1, < 2.1.0"], semver)
      .candidate,
    "2.1.0"
  );
  assert.equal(planGroup(group, ["3.0.0"], [], semver).status, "no-common-candidate");
  assert.equal(planGroup(group, ["2.0.1"], ["unrecognized"], semver).status, "advisory-held");
});

test("stale alerts are excluded and an exact lockfile pin can hold a candidate", () => {
  const [group] = groupsFor(
    [
      alert(1, "example", "high", "development", "< 2.0.1", "2.0.1"),
      alert(2, "example", "critical", "runtime", "< 2.0.0", "2.0.0"),
    ],
    { "example@2.0.0": { version: "2.0.0" } },
    semver
  );
  const plan = planGroup(group, ["2.0.1"], [], semver);
  assert.deepEqual(plan.alerts, [1]);
  assert.equal(plan.status, "no-common-candidate");
});

test("an aliased npm resolution is included under its canonical package", () => {
  const [group] = groupsFor(
    [alert(1, "@example/tool", "high", "runtime", "< 1.0.5", "1.0.5")],
    {
      "@example/tool@^1.0.0": { version: "1.0.3" },
      "tool-cjs@npm:@example/tool@~1.0.0": { version: "1.0.4" },
    },
    semver
  );
  assert.deepEqual(planGroup(group, ["1.1.0"], [], semver), {
    package: "@example/tool",
    severity: "high",
    scope: "runtime",
    alerts: [1],
    locked: ["1.0.3", "1.0.4"],
    status: "no-common-candidate",
  });
});

test("separate compatible release lines hold for individual fixes", () => {
  const [group] = groupsFor(
    [alert(1, "example", "high", "runtime", "< 2.0.1 || >= 3.0.0 < 3.0.1", "2.0.1")],
    {
      "example@^2.0.0": { version: "2.0.0" },
      "example@^3.0.0": { version: "3.0.0" },
    },
    semver
  );
  assert.equal(planGroup(group, ["2.0.1", "3.0.1"], [], semver).status, "no-common-candidate");
});

test("alert pagination stays on GitHub and the same repository", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url.href);
    return Response.json([{ number: calls.length }], {
      headers:
        calls.length === 1
          ? {
              link: '<https://api.github.com/repositories/1453935262/dependabot/alerts?after=next>; rel="next"',
            }
          : {},
    });
  };
  assert.deepEqual(await listAlerts("fixture-only", fetch), [{ number: 1 }, { number: 2 }]);
  assert.ok(calls[0].includes(ROOT + "/dependabot/alerts"));
  let attempts = 0;
  await assert.rejects(
    listAlerts("fixture-only", async () => {
      attempts++;
      return Response.json([], {
        headers: { link: '<https://example.invalid/dependabot/alerts?after=next>; rel="next"' },
      });
    }),
    /pagination destination/
  );
  assert.equal(attempts, 1);
});

test("public workflow output contains aggregate counts only", () => {
  const summary = publicSummary({
    outcome: "preview",
    modelCalls: 0,
    openAlerts: 16,
    groups: 4,
    plans: [
      { package: "example", alerts: [12], candidate: "2.0.1", status: "compatible-candidate" },
      { package: "example-held", locked: ["1.0.0"], status: "no-common-candidate" },
    ],
  });
  assert.deepEqual(summary, {
    outcome: "preview",
    modelCalls: 0,
    groups: 4,
    evaluated: 2,
    compatibleCandidates: 1,
    holds: 1,
  });
});
