const { REPOSITORY, SHA } = require("./dependency-contract.cjs");
const requireFact = (ok) => {
  if (!ok) throw Error("Release/tag or exact-head CI evidence is unavailable or inconsistent");
};
const FORM_STEPS = [
  "Run yarn types && yarn lint && yarn test:unit:ci",
  "API and browser regression tests without cloud recording",
];
const FORM_TESTS = [
  "src/components/__tests__/UserSettingsForm.test.tsx",
  "cypress/tests/ui/auth.spec.ts",
  "cypress/tests/ui/bankaccounts.spec.ts",
  "cypress/tests/ui/user-settings.spec.ts",
];
// Explicit trusted mapping: never follow npm/PR-supplied repository URLs.
const UPSTREAM = Object.freeze({ lodash: "lodash/lodash", "lodash-es": "lodash/lodash" });
async function releaseFacts(entry, read) {
  const repository = UPSTREAM[entry.name];
  const version = entry.version;
  requireFact(repository && /^\d+\.\d+\.\d+$/.test(version));
  const root = `https://api.github.com/repos/${repository}`;
  const url = `https://github.com/${repository}/releases/tag/${version}`;
  const release = await read(`${root}/releases/tags/${version}`);
  requireFact(
    Number.isSafeInteger(release.id) &&
      release.id > 0 &&
      release.tag_name === version &&
      release.html_url === url &&
      release.draft === false &&
      release.prerelease === false &&
      typeof release.published_at === "string" &&
      Number.isFinite(Date.parse(release.published_at))
  );
  const ref = await read(`${root}/git/ref/tags/${version}`);
  requireFact(
    ref.ref === `refs/tags/${version}` &&
      ref.object?.type === "tag" &&
      SHA.test(ref.object.sha || "")
  );
  const tag = await read(`${root}/git/tags/${ref.object.sha}`);
  requireFact(
    tag.sha === ref.object.sha &&
      tag.tag === version &&
      tag.object?.type === "commit" &&
      SHA.test(tag.object.sha || "") &&
      tag.verification?.verified === true &&
      tag.verification.reason === "valid"
  );
  return {
    package: entry.name,
    version,
    repository,
    url,
    releaseId: release.id,
    publishedAt: release.published_at,
    tagObject: ref.object.sha,
    tagCommit: tag.object.sha,
    tagVerified: true,
    sources: [
      `${root}/releases/tags/${version}`,
      `${root}/git/ref/tags/${version}`,
      `${root}/git/tags/${ref.object.sha}`,
    ],
    scope:
      "Official upstream release and GitHub-verified signed tag. This is not npm provenance or proof that the npm distribution equals this source commit; registry gitHead may refer to a separate built distribution branch.",
  };
}
async function ciFacts(source, read) {
  const ci = source.ci;
  if (!ci) return { status: "not-supplied" };
  requireFact(
    SHA.test(source.head || "") &&
      ci.head === source.head &&
      ci.passed === true &&
      Number.isSafeInteger(ci.runId) &&
      ci.runId > 0 &&
      /^[a-z0-9-]{1,100}$/i.test(ci.requestId || "")
  );
  const root = `https://api.github.com/repos/${REPOSITORY}/actions`;
  const workflow = await read(`${root}/workflows/factory-ci.yml`);
  const run = await read(`${root}/runs/${ci.runId}`);
  requireFact(
    workflow.path === ".github/workflows/factory-ci.yml" &&
      Number.isSafeInteger(workflow.id) &&
      workflow.id > 0 &&
      run.workflow_id === workflow.id &&
      run.path === workflow.path &&
      run.id === ci.runId &&
      run.head_sha === source.head &&
      run.repository?.full_name === REPOSITORY &&
      run.head_repository?.full_name === REPOSITORY &&
      run.event === "workflow_dispatch" &&
      run.display_title === `Factory CI / ${ci.requestId}` &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0 &&
      run.status === "completed" &&
      run.conclusion === "success"
  );
  const list = await read(`${root}/runs/${ci.runId}/attempts/${run.run_attempt}/jobs?per_page=100`);
  requireFact(
    Array.isArray(list.jobs) && list.total_count === list.jobs.length && list.jobs.length <= 100
  );
  const jobs = list.jobs.filter((j) => j.name === "verify");
  requireFact(jobs.length === 1);
  const job = jobs[0];
  requireFact(
    Number.isSafeInteger(job.id) &&
      job.id > 0 &&
      job.run_id === ci.runId &&
      job.head_sha === source.head &&
      job.status === "completed" &&
      job.conclusion === "success" &&
      Array.isArray(job.steps)
  );
  for (const name of FORM_STEPS)
    requireFact(
      job.steps.filter(
        (s) => s.name === name && s.status === "completed" && s.conclusion === "success"
      ).length === 1
    );
  return {
    status: "verified",
    head: source.head,
    runId: ci.runId,
    runAttempt: run.run_attempt,
    url: `https://github.com/${REPOSITORY}/actions/runs/${ci.runId}`,
    jobId: job.id,
    passedSteps: [...FORM_STEPS],
    testFiles: [...FORM_TESTS],
    sourceReferences: FORM_TESTS.map(
      (p) => `https://github.com/${REPOSITORY}/blob/${source.head}/${p}`
    ),
    scope:
      "Verified exact-head suite-level CI receipt and immutable references to existing Formik/Yup validation and submission test definitions. These are not per-test results or proof of universal compatibility. Inspect the test source for coverage and remaining gaps; do not claim the reviewer executed tests.",
  };
}
async function collectReviewContext(source, inventory, { publicJSON }) {
  const candidates = inventory.queries.filter(
    (q) => ["added", "retained"].includes(q.side) && Object.hasOwn(UPSTREAM, q.name)
  );
  const unique = [...new Map(candidates.map((q) => [q.name + "@" + q.version, q])).values()];
  requireFact(unique.length <= 4);
  const upstreamReleases = [];
  for (const entry of unique) upstreamReleases.push(await releaseFacts(entry, publicJSON));
  return { upstreamReleases, ciEvidence: await ciFacts(source, publicJSON) };
}
module.exports = { collectReviewContext };
