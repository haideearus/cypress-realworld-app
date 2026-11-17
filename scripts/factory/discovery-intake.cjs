const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const c = require("./discovery-contract.cjs");
const f = require("./discovery-finding-contract.cjs");
const s = require("./discovery-sandbox.cjs");
const o = require("./discovery-oracles.cjs");
const p = require("./policy.cjs");
function canReplay(state, config, day) {
  return (
    !state.stop &&
    config.enabled &&
    config.automatic &&
    config.discovery &&
    (state.days[day] || []).length < config.daily &&
    require("./active-tickets.cjs").capacity(state, config.concurrent) &&
    !require("./active-tickets.cjs").pendingIntent(state)
  );
}
function reserveReplay(state, key, day, context, head, ciRunId = "1") {
  if (!f.contextOK(context) || !c.SHA.test(head) || !/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw Error("Invalid intake identity");
  const r = state.records[key];
  if (!r || r.status !== "published" || !r.publication?.issue) throw Error("Finding not published");
  const id = c.digest([key, context.runId, head]);
  if (state.replays[id]) return state.replays[id];
  const attempts = Object.values(state.replays).filter((x) => x.day === day);
  if (attempts.length >= 8 || attempts.filter((x) => x.key === key).length >= 2)
    throw Error("Intake replay limit reached");
  if (Object.keys(state.replays).length >= 3200)
    throw Error("Replay history full; owner maintenance required");
  const receipt = {
    id,
    key,
    day,
    head,
    ciRunId,
    context: structuredClone(context),
    outcome: "intent",
    evidenceHash: null,
  };
  state.replays[id] = receipt;
  r.intake = structuredClone(receipt);
  return receipt;
}
function validObservation(result, oracle) {
  const v = result?.observation;
  if (
    result?.networkIsolated !== true ||
    !v ||
    !Number.isInteger(v.status) ||
    v.inputHash !== o.oracleHash(oracle) ||
    v.kind !== oracle.kind ||
    typeof v.response !== "string"
  )
    return false;
  try {
    return c.digest(v) === c.digest(o.observe(oracle, v.status, JSON.parse(v.response)));
  } catch {
    return false;
  }
}
function healthy(result, oracle) {
  if (!validObservation(result, oracle) || result.observation.symptom !== "none") return false;
  const code = result.observation.status;
  if (oracle.kind === "protected-route") return code === 401 || code === 403;
  if (oracle.kind === "account-isolation") return code === 403 || code === 404;
  return code >= 200 && code < 300;
}
function assessReplay(candidate, tests, observations) {
  f.validateCandidate(candidate);
  if (
    !Array.isArray(tests) ||
    tests.length !== 2 ||
    !Array.isArray(observations) ||
    observations.length !== 2 ||
    tests.some(
      (r) =>
        r?.networkIsolated !== true ||
        !Number.isInteger(r.code) ||
        r.code < 0 ||
        r.code === 124 ||
        r.exitState?.oomKilled
    ) ||
    observations.some((r) => !validObservation(r, candidate.oracle)) ||
    observations[0].observation.signature !== observations[1].observation.signature
  )
    return "held";
  if (
    tests.every((r) => r.code > 0) &&
    observations.every((r) => r.observation.symptom !== "none") &&
    candidate.fingerprint ===
      c.digest([candidate.oracle.kind, candidate.oracle.route, observations[0].observation.symptom])
  )
    return "ready";
  if (tests.every((r) => r.code === 0) && observations.every((r) => healthy(r, candidate.oracle)))
    return "observed-resolved";
  return "held";
}
async function replayForIntake({
  candidate,
  bundle,
  image,
  tests,
  run = s.sandbox,
  now = Date.now,
}) {
  const proof = f.sourceProof(candidate.source);
  const index = bundle.findings?.findIndex((x) => c.digest(x.finding) === candidate.findingHash);
  if (
    index < 0 ||
    c.digest(f.candidateFromEvidence(bundle, index, candidate.artifact, proof)) !==
      c.digest(candidate)
  )
    throw Error("Changed original discovery evidence or RED");
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(tests, candidate.file), bundle.findings[index].original.test, {
    flag: "wx",
    mode: 0o644,
  });
  const deadlineAt = now() + 300000;
  const proposed = [],
    observations = [];
  for (let i = 0; i < 2; i++) {
    proposed.push(
      await run({
        image,
        tests,
        request: { mode: candidate.mode, file: candidate.file },
        deadlineAt,
      })
    );
    observations.push(await run({ image, oracle: candidate.oracle, deadlineAt }));
  }
  return {
    version: 1,
    outcome: assessReplay(candidate, proposed, observations),
    candidateHash: c.digest(candidate),
    originalHead: candidate.source.head,
    originalRedHash: candidate.redLogHash,
    proposed,
    observations,
  };
}
async function buildBaseline({ cwd, head, root, files = [] }) {
  if (!c.SHA.test(head)) throw Error("Invalid replay source");
  const { validateChanges } = require("./artifacts.cjs");
  if (files.length) validateChanges(files);
  fs.mkdirSync(root, { recursive: false });
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  const opts = { cwd, env: s.safeEnv(), windowsHide: true, encoding: "utf8", maxBuffer: 64000000 };
  const tree = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-tree", "-r", head], opts);
  if (
    tree
      .split("\n")
      .filter(Boolean)
      .some((line) => !/^100(?:644|755) blob /.test(line))
  )
    throw Error("Unsafe replay source tree");
  const archive = execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "archive", "--format=tar", head],
    { ...opts, encoding: null }
  );
  execFileSync("tar", ["-xf", "-", "-C", source], {
    env: s.safeEnv(),
    windowsHide: true,
    input: archive,
    maxBuffer: 1000000,
  });
  for (const file of files) {
    const target = path.join(source, file.path);
    if (file.deleted) fs.unlinkSync(target);
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, { mode: 0o644 });
    }
  }
  const manifest = require("./discovery-worker.cjs").manifestFor(source);
  await require("./secret-scan.cjs").scanFiles(
    Object.keys(manifest).map((name) => ({
      path: name,
      content: fs.readFileSync(path.join(source, name)),
    }))
  );
  return require("./discovery-worker.cjs").buildImage(source, root, head);
}
module.exports = {
  canReplay,
  reserveReplay,
  validObservation,
  healthy,
  assessReplay,
  replayForIntake,
  buildBaseline,
};
