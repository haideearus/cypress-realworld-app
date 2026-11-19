const { validateOracle } = require("./discovery-oracles.cjs");
const { FUNCTIONAL_CHARTERS: CHARTERS, digest } = require("./discovery-contract.cjs");

const SOURCE = Object.freeze({
  "functional-feed": [
    "src/components/TransactionList.tsx",
    "src/machines/publicTransactionsMachine.ts",
  ],
  "functional-directory": ["src/components/UserListSearchForm.tsx", "src/components/UsersList.tsx"],
});
const PREFIX = "// Factory functional scenario ";
const inRange = (value) => Number.isInteger(value) && value >= 1 && value <= 25;

function assertCharter(charter) {
  if (!CHARTERS.includes(charter)) throw Error("Functional discovery charter required");
  return charter;
}

function sourceAllowed(charter, file) {
  return SOURCE[assertCharter(charter)].includes(file);
}

function scenario(charter, oracle) {
  assertCharter(charter);
  validateOracle(oracle);
  const { kind, route, authenticated, query } = oracle;
  const feed = charter === "functional-feed";
  if (
    !authenticated ||
    (feed
      ? kind !== "feed-pagination" ||
        route !== "/transactions/public" ||
        Object.keys(query).length !== 2 ||
        !inRange(query.page) ||
        !inRange(query.limit)
      : kind !== "unexpected-server-error" ||
        route !== "/users/search" ||
        Object.keys(query).length !== 1 ||
        !/^[A-Za-z][A-Za-z0-9 ]{0,23}$/.test(query.q || ""))
  )
    throw Error("Functional scenario outside the approved charter");
  return {
    kind,
    route,
    authenticated,
    query: feed ? { page: query.page, limit: query.limit } : { q: query.q },
  };
}

function proposal(charter, oracle) {
  const input = scenario(charter, oracle);
  const wire = JSON.stringify(input);
  const lines = [
    PREFIX + wire,
    'const test = require("node:test");',
    'const assert = require("node:assert/strict");',
    'const base = "http://127.0.0.1:3001";',
    'test("approved functional scenario", async () => {',
    '  const { users } = require("../data/database-seed.json");',
    '  const session = await fetch(base + "/login", {',
    '    method: "POST",',
    '    redirect: "error",',
    '    headers: { "content-type": "application/json" },',
    '    body: JSON.stringify({ username: users[0].username, password: "discovery-only-password" }),',
    "    signal: AbortSignal.timeout(8000),",
    "  });",
    '  assert.equal(session.status, 200, "synthetic sign-in");',
    '  const cookie = session.headers.get("set-cookie")?.split(";")[0];',
    '  assert.ok(cookie, "synthetic session cookie");',
    "  const scenario = " + wire + ";",
    "  const url = new URL(scenario.route, base);",
    "  url.search = new URLSearchParams(scenario.query);",
    "  const response = await fetch(url, {",
    '    redirect: "error", headers: { cookie }, signal: AbortSignal.timeout(8000),',
    "  });",
    '  assert.equal(response.status, 200, "functional request succeeded");',
  ];
  if (charter === "functional-feed")
    lines.push(
      "  const { pageData, results } = await response.json();",
      "  assert.ok(Array.isArray(results));",
      "  assert.ok(Number.isInteger(pageData.page) && pageData.page >= 1);",
      "  assert.ok(Number.isInteger(pageData.totalPages) && pageData.totalPages >= 0);",
      "  assert.equal(pageData.hasNextPages, pageData.page < pageData.totalPages);",
      "  if (pageData.page > pageData.totalPages) assert.equal(results.length, 0);"
    );
  return lines.concat("});", "").join("\n");
}

function verifyProposal(charter, source) {
  if (typeof source !== "string" || !source.startsWith(PREFIX))
    throw Error("Generated functional proposal required");
  const oracle = JSON.parse(source.slice(PREFIX.length, source.indexOf("\n")));
  if (source !== proposal(charter, oracle)) throw Error("Functional proposal changed");
  return oracle;
}

function describeFinding(charter, finding) {
  const oracle = scenario(charter, finding.oracle);
  if (finding.mode !== "api" || !finding.test.endsWith(".api.test.cjs"))
    throw Error("Functional discovery accepts fixed API proposals only");
  const feed = charter === "functional-feed";
  return {
    ...finding,
    oracle,
    title: feed
      ? "Public feed pagination contract failed"
      : "Directory search returned a server error",
    summary: feed
      ? "The public feed returned inconsistent pagination on a positive page and page size."
      : "An ordinary directory search returned a server error for the synthetic account.",
  };
}

function verifyFindings(charter, report, batches) {
  assertCharter(charter);
  for (const batch of batches) {
    if (batch.mode !== "api") throw Error("Functional discovery accepts fixed API proposals only");
    verifyProposal(charter, batch.test);
  }
  for (const finding of report.findings) {
    const expected = describeFinding(charter, finding);
    const latest = batches
      .filter((b) => b.file === finding.test)
      .sort((left, right) => right.number - left.number)[0];
    if (
      expected.title !== finding.title ||
      expected.summary !== finding.summary ||
      latest?.test !== proposal(charter, expected.oracle) ||
      !Number.isInteger(latest.result?.code) ||
      latest.result.code <= 0 ||
      latest.result.code === 124
    )
      throw Error("Finding does not match its executed failing functional proposal");
  }
}

function eligibleCandidate(candidate) {
  const charter = candidate?.source?.charter;
  if (!CHARTERS.includes(charter) || candidate.source.recovery) return false;
  try {
    const expected = describeFinding(charter, { ...candidate, test: candidate.file });
    return (
      candidate.testHash === digest(proposal(charter, expected.oracle)) &&
      candidate.title === expected.title &&
      candidate.summary === expected.summary
    );
  } catch {
    return false;
  }
}

module.exports = {
  CHARTERS,
  assertCharter,
  sourceAllowed,
  proposal,
  verifyProposal,
  describeFinding,
  verifyFindings,
  eligibleCandidate,
};
