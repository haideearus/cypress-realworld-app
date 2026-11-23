const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { stripVTControlCharacters } = require("node:util");
const c = require("./discovery-contract.cjs");
const { ROOT, Ledger } = require("./github.cjs");
const { verifySweepSource } = require("./discovery-origin.cjs");
const { DiscoveryStore } = require("./discovery-store.cjs");
const { UUID } = require("./monitor-proof.cjs");
const { renderJourney, validateJourney, verifyJourney } = require("./discovery-browser.cjs");
const { IMAGE, validateRequest } = require("./discovery-sandbox.cjs");
const { failedIsolated } = require("./discovery-replay.cjs");

const SWEEP_WORKFLOW = ".github/workflows/factory-discovery.yml";
const MAX_ARCHIVE = 4000000;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function fixedAssertion(journey, marker) {
  if (journey.pages.length !== 1) return null;
  if (journey.check === "settings-validation" && marker === journey.variant) {
    const assertion = {
      "invalid-email": "settings-email-invalid",
      "required-email": "settings-email-required",
      "required-first-name": "settings-first-name-required",
    }[marker];
    if (assertion) return { check: "form-validation", assertion };
  }
  if (
    journey.check === "notification-list" &&
    journey.variant === "empty" &&
    marker === "empty-notifications"
  )
    return { check: "notifications-empty", assertion: "notifications-empty-view" };
  return null;
}

function browserLeads({ batches, browserFollowUp }) {
  if (browserFollowUp) return [];
  const latest = new Map();
  for (const batch of [...batches].sort((a, b) => a.number - b.number))
    if (batch.mode === "cypress") latest.set(batch.file, batch);
  const leads = [];
  for (const batch of latest.values()) {
    const { result, test, testHash, file, number } = batch;
    if (
      result?.mode !== "cypress" ||
      result.file !== file ||
      result.code !== 1 ||
      typeof test !== "string" ||
      c.digest(test) !== testHash ||
      !IMAGE.test(result.image || "") ||
      !failedIsolated(result)
    )
      continue;
    let journey;
    try {
      validateRequest({ mode: "cypress", file });
      journey = verifyJourney(test);
    } catch {
      continue;
    }
    const log = stripVTControlCharacters(result.log);
    const assertion = [
      ...log.matchAll(
        /^[ \t]*AssertionError: (?:Timed out retrying after \d+ms: )?Browser journey \[([a-z-]+)\]: /gm
      ),
    ];
    if (
      !/^[ \t]*1 failing[ \t]*$/m.test(log) ||
      !/^[ \t]*1\) factory browser journey[ \t]*$/m.test(log) ||
      !log
        .split(/\r?\n/)
        .some((line) => line.trim() === `${journey.check} / ${journey.variant}:`) ||
      assertion.length !== 1 ||
      !fixedAssertion(journey, assertion[0][1])
    )
      continue;
    leads.push({
      batch: number,
      journey,
      templateHash: testHash,
      logHash: result.logHash,
      marker: assertion[0][1],
    });
  }
  return leads.sort((a, b) => a.batch - b.batch);
}

function validateLead(lead) {
  c.exact(lead, ["batch", "journey", "templateHash", "logHash", "marker"]);
  const journey = validateJourney(lead.journey);
  const fixed = fixedAssertion(journey, lead.marker);
  if (
    !fixed ||
    c.digest(journey) !== c.digest(lead.journey) ||
    c.digest(renderJourney(journey)) !== lead.templateHash ||
    !c.HASH.test(lead.logHash || "") ||
    !Number.isInteger(lead.batch) ||
    lead.batch < 1 ||
    lead.batch > 4
  )
    throw Error("Invalid browser lead");
  return fixed;
}

function decodeBrowserArchive(bytes, hash) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 1 ||
    bytes.length > MAX_ARCHIVE ||
    !SHA256.test(hash || "") ||
    "sha256:" + createHash("sha256").update(bytes).digest("hex") !== hash
  )
    throw Error("Discovery archive digest mismatch");
  const unpack = [
    "import io, sys, zipfile",
    "with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:",
    "    entries = archive.infolist()",
    "    assert len(entries) == 1 and entries[0].filename == 'evidence.json'",
    `    assert 0 < entries[0].file_size <= ${MAX_ARCHIVE}`,
    `    with archive.open(entries[0]) as entry: sys.stdout.buffer.write(entry.read(${MAX_ARCHIVE + 1}))`,
  ].join("\n");
  const python = process.platform === "win32" ? "python" : "python3";
  const text = execFileSync(python, ["-I", "-c", unpack], {
    input: bytes,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: MAX_ARCHIVE,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    },
  });
  return JSON.parse(text);
}

async function downloadEvidence(api, artifact) {
  const signal = AbortSignal.timeout(30000);
  const zip = await api.fetch(
    new URL(`${ROOT}/actions/artifacts/${artifact.id}/zip`, "https://api.github.com"),
    {
      redirect: "manual",
      signal,
      headers: {
        Authorization: `Bearer ${api.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  const location = zip.headers.get("location");
  await zip.body?.cancel();
  if (zip.status !== 302 || !location) throw Error("Discovery archive download was not authorized");
  const url = new URL(location);
  if (url.protocol !== "https:" || url.username || url.password)
    throw Error("Invalid discovery archive download location");
  // The signed storage URL receives no job token. Reject further redirects.
  const response = await api.fetch(url, { redirect: "error", signal });
  if (!response.ok || !response.body) throw Error("Discovery archive unavailable");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_ARCHIVE) throw Error("Discovery archive exceeds its size limit");
    chunks.push(chunk);
  }
  return decodeBrowserArchive(Buffer.concat(chunks), artifact.digest);
}

async function sweepInputs(
  api,
  context,
  event,
  { ledger = new Ledger(api), discovery = new DiscoveryStore(api) } = {}
) {
  const run = event?.workflow_run;
  if (
    context.eventName !== "workflow_run" ||
    event?.action !== "completed" ||
    event.repository?.full_name !== c.REPOSITORY ||
    event.workflow?.path !== SWEEP_WORKFLOW ||
    run?.path !== SWEEP_WORKFLOW ||
    !Number.isSafeInteger(run.id) ||
    run.id < 1 ||
    !Number.isSafeInteger(run.workflow_id) ||
    run.workflow_id < 1 ||
    run.workflow_id !== event.workflow.id ||
    run.repository?.full_name !== c.REPOSITORY ||
    run.head_repository?.full_name !== c.REPOSITORY ||
    run.head_branch !== "main" ||
    run.head_sha !== context.workflowSha ||
    run.run_attempt !== 1 ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !["schedule", "workflow_dispatch", "workflow_run"].includes(run.event) ||
    !c.runActorOK(run) ||
    run.actor.login !== context.actor ||
    run.triggering_actor.login !== context.triggeringActor
  )
    throw Error("Untrusted functional browser sweep event");
  const { state } = await ledger.read();
  if (state.stop) return { stopped: true };
  const grants = Object.values(state.grants).filter(
    (grant) =>
      grant.runId === String(run.id) &&
      grant.slot === "discovery" &&
      grant.phase === "discover" &&
      grant.status === "finished" &&
      grant.outcome === "discovery_complete" &&
      grant.runAttempt === 1 &&
      grant.head === context.workflowSha
  );
  if (grants.length !== 1) return {};
  const [grant] = grants;
  const proof = state.tickets[grant.ticket]?.discovery;
  if (
    !UUID.test(grant.id || "") ||
    proof?.runId !== grant.runId ||
    proof.head !== grant.head ||
    !c.FUNCTIONAL_CHARTERS.includes(proof.charter)
  )
    throw Error("Invalid completed browser sweep provenance");
  return { api, proof: { ...proof, grantId: grant.id }, ledger, discovery };
}

async function assertSweepArtifact({ api, proof, ledger, discovery }, id, digest) {
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    !SHA256.test(digest || "") ||
    !(await verifySweepSource(
      api,
      proof,
      { id, digest, name: `discovery-evidence-${proof.grantId}` },
      { ledger, discovery }
    ))
  )
    throw Error("Browser discovery artifact source proof rejected");
}

async function selectBrowserLead(api, context, event, options = {}) {
  const sweep = await sweepInputs(api, context, event, options);
  if (!sweep.proof) return null;
  const { grantId, runId, head } = sweep.proof;
  const artifacts = await api.pages(`${ROOT}/actions/runs/${runId}/artifacts`, "artifacts");
  const matching = artifacts.filter((row) => row.name === `discovery-evidence-${grantId}`);
  if (!matching.length) return null;
  if (matching.length !== 1) throw Error("Ambiguous browser sweep artifact");
  const [artifact] = matching;
  await assertSweepArtifact(sweep, artifact.id, artifact.digest);
  const evidence = await (options.loadEvidence || downloadEvidence)(api, artifact);
  if (
    evidence?.version !== 1 ||
    evidence.source !== "claude-subscription" ||
    evidence.fixture !== false ||
    evidence.head !== head ||
    evidence.grantId !== grantId ||
    Object.hasOwn(evidence, "recovery") ||
    !c.HASH.test(evidence.sourceHash || "")
  )
    throw Error("Browser discovery evidence identity mismatch");
  if (evidence.browserFollowUp || evidence.browserLeads === undefined) return null;
  if (
    !Array.isArray(evidence.browserLeads) ||
    evidence.browserLeads.length > 4 ||
    !Array.isArray(evidence.actualBatches) ||
    evidence.actualBatches.length > 4
  )
    throw Error("Browser lead evidence exceeds approved bounds");
  const leads = evidence.browserLeads.map((lead) => {
    const fixed = validateLead(lead);
    const batches = evidence.actualBatches.filter((batch) => batch.number === lead.batch);
    if (
      batches.length !== 1 ||
      batches[0].mode !== "cypress" ||
      batches[0].code !== 1 ||
      batches[0].networkIsolated !== true ||
      batches[0].testHash !== lead.templateHash
    )
      throw Error("Browser lead does not match an executed Cypress batch");
    return {
      ...fixed,
      lead,
      runId,
      grantId,
      artifactId: artifact.id,
      artifactDigest: artifact.digest,
    };
  });
  return leads[0] ?? null;
}

async function verifyBrowserLead(api, context, event, browserSource, options) {
  c.exact(browserSource, [
    "check",
    "assertion",
    "lead",
    "runId",
    "grantId",
    "artifactId",
    "artifactDigest",
  ]);
  const fixed = validateLead(browserSource.lead);
  if (fixed.check !== browserSource.check || fixed.assertion !== browserSource.assertion)
    throw Error("Browser lead disagrees with the fixed assertion");
  const sweep = await sweepInputs(api, context, event, options);
  if (sweep.stopped) return false;
  if (sweep.proof?.runId !== browserSource.runId || sweep.proof?.grantId !== browserSource.grantId)
    throw Error("Completed browser sweep changed after planning");
  await assertSweepArtifact(sweep, browserSource.artifactId, browserSource.artifactDigest);
  return true;
}

module.exports = {
  SWEEP_WORKFLOW,
  browserLeads,
  decodeBrowserArchive,
  selectBrowserLead,
  verifyBrowserLead,
};
