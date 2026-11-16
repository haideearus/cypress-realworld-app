const test = require("node:test");
const assert = require("node:assert/strict");
let collectReviewContext;
try {
  ({ collectReviewContext } = require("../factory/dependency-review-context.cjs"));
} catch (e) {
  if (e.code !== "MODULE_NOT_FOUND") throw e;
}
const head = "a".repeat(40),
  tagSha = "b".repeat(40),
  commit = "c".repeat(40);
const repo = "haideearus/cypress-realworld-app";
const source = { head, ci: { head, passed: true, runId: 501, requestId: "correlated-ci" } };
const inventory = { queries: [{ name: "lodash-es", version: "4.18.1", side: "added" }] };
const steps = [
  "Run yarn types && yarn lint && yarn test:unit:ci",
  "API and browser regression tests without cloud recording",
];
function transport(change = () => {}) {
  return async (url, opts) => {
    assert.equal(opts.headers.Authorization, undefined);
    assert.equal(opts.redirect, "error");
    assert.ok(opts.signal);
    let data;
    if (url.endsWith("/releases/tags/4.18.1"))
      data = {
        id: 1,
        html_url: "https://github.com/lodash/lodash/releases/tag/4.18.1",
        tag_name: "4.18.1",
        published_at: "2026-04-01T21:01:28Z",
        draft: false,
        prerelease: false,
      };
    else if (url.endsWith("/git/ref/tags/4.18.1"))
      data = { ref: "refs/tags/4.18.1", object: { type: "tag", sha: tagSha } };
    else if (url.endsWith("/git/tags/" + tagSha))
      data = {
        sha: tagSha,
        tag: "4.18.1",
        object: { type: "commit", sha: commit },
        verification: { verified: true, reason: "valid" },
      };
    else if (url.endsWith("/workflows/factory-ci.yml"))
      data = { id: 11, path: ".github/workflows/factory-ci.yml" };
    else if (url.endsWith("/runs/501"))
      data = {
        id: 501,
        workflow_id: 11,
        path: ".github/workflows/factory-ci.yml",
        head_sha: head,
        run_attempt: 1,
        event: "workflow_dispatch",
        display_title: "Factory CI / correlated-ci",
        repository: { full_name: repo },
        head_repository: { full_name: repo },
        status: "completed",
        conclusion: "success",
      };
    else if (url.endsWith("/attempts/1/jobs?per_page=100"))
      data = {
        total_count: 1,
        jobs: [
          {
            id: 12,
            run_id: 501,
            head_sha: head,
            name: "verify",
            status: "completed",
            conclusion: "success",
            steps: steps.map((name) => ({ name, status: "completed", conclusion: "success" })),
          },
        ],
      };
    else throw Error("Unexpected URL " + url);
    change(data, url);
    return new Response(JSON.stringify(data));
  };
}
const read = (fetcher = transport(), input = source, inv = inventory) =>
  collectReviewContext(input, inv, {
    publicJSON: async (url) => {
      const r = await fetcher(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(1000),
      });
      return r.json();
    },
  });
test("reviewer receives official release plus exact-head successful form-suite receipt", async () => {
  assert.equal(typeof collectReviewContext, "function", "missing release and CI evidence adapter");
  const r = await read();
  assert.equal(r.upstreamReleases[0].tagCommit, commit);
  assert.equal(r.upstreamReleases[0].tagVerified, true);
  assert.equal(r.ciEvidence.head, head);
  assert.equal(r.ciEvidence.runId, 501);
  assert.deepEqual(r.ciEvidence.passedSteps, steps);
  assert.ok(r.ciEvidence.testFiles.includes("src/components/__tests__/UserSettingsForm.test.tsx"));
  assert.ok(
    r.ciEvidence.sourceReferences.some((x) =>
      x.includes(head + "/src/components/__tests__/UserSettingsForm.test.tsx")
    )
  );
  assert.match(r.ciEvidence.scope, /not.*per-test/i);
  assert.match(r.upstreamReleases[0].scope, /not.*npm.*provenance/i);
});
test("wrong release, unsigned tag and mismatched CI facts fail closed", async () => {
  for (const mutate of [
    (d, u) => {
      if (u.includes("releases/tags")) d.tag_name = "4.17.21";
    },
    (d, u) => {
      if (u.includes("releases/tags")) d.html_url = "https://evil.invalid/release";
    },
    (d, u) => {
      if (u.includes("releases/tags")) d.draft = true;
    },
    (d, u) => {
      if (u.includes("git/ref")) d.object.type = "commit";
    },
    (d, u) => {
      if (u.includes("git/tags/")) d.verification.verified = false;
    },
    (d, u) => {
      if (u.includes("git/tags/")) d.sha = "d".repeat(40);
    },
    (d, u) => {
      if (u.endsWith("/runs/501")) d.head_sha = "d".repeat(40);
    },
    (d, u) => {
      if (u.endsWith("/runs/501")) d.repository.full_name = "stranger/repo";
    },
    (d, u) => {
      if (u.endsWith("/runs/501")) d.display_title = "Factory CI / other";
    },
    (d, u) => {
      if (u.includes("attempts")) d.jobs[0].conclusion = "failure";
    },
    (d, u) => {
      if (u.includes("attempts")) d.jobs[0].steps.pop();
    },
    (d, u) => {
      if (u.includes("attempts")) d.total_count = 2;
    },
  ])
    await assert.rejects(read(transport(mutate)), /evidence|CI|release|tag/i);
});
test("package-controlled upstream URLs are never fetched and missing CI stays explicit", async () => {
  const r = await read(
    transport(),
    { head },
    {
      queries: [
        { name: "other", version: "1.0.0", side: "added", repository: "https://evil.invalid" },
      ],
    }
  );
  assert.deepEqual(r.upstreamReleases, []);
  assert.equal(r.ciEvidence.status, "not-supplied");
});
test("outages propagate as a hold and baseline copies do not demand an upstream tag", async () => {
  await assert.rejects(
    collectReviewContext(source, inventory, {
      publicJSON: async () => {
        throw Error("Public evidence unavailable");
      },
    }),
    /unavailable/
  );
  const r = await read(
    transport(),
    { head },
    { queries: [{ name: "lodash-es", version: "4.17.21", side: "baseline" }] }
  );
  assert.deepEqual(r.upstreamReleases, []);
});
