const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const policy = require("./policy.cjs");
const slots = require("./active-tickets.cjs");
const { GitHub, Ledger } = require("./github.cjs");
const { SWITCHES } = require("./stop-contract.cjs");
const { runs, settings } = require("./stop.cjs");
const { partitionRuns } = require("./quarantine.cjs");
const digest = (state) => createHash("sha256").update(JSON.stringify(state)).digest("hex");
function upgraded(state) {
  const next = structuredClone(state);
  next.version = 2;
  delete next.active;
  next.activeTickets = {};
  return next;
}
function previewMigration(state) {
  policy.validateState(state);
  const reasons = [];
  if (state.version !== 1) reasons.push("Ledger already migrated or version unsupported");
  if (!state.stop) reasons.push("Durable owner stop is required");
  if (slots.activeEntries(state).length) reasons.push("Active tickets must be terminal");
  if (Object.values(state.grants).some((g) => g.status === "reserved"))
    reasons.push("Reserved grants must be reconciled");
  return {
    eligible: reasons.length === 0,
    reasons,
    beforeDigest: digest(state),
    afterDigest: reasons.length ? null : digest(upgraded(state)),
  };
}
async function safeWindow(api, state) {
  const actual = await settings(api);
  if (SWITCHES.some((name) => actual[name] !== "false"))
    throw new Error("All three switches must be false for migration");
  const inventory = await partitionRuns(api, state, await runs(api));
  if (inventory.pending.length) throw new Error("Running agents must be terminal before migration");
  return inventory;
}
async function migrateConcurrency({
  api,
  actor,
  expectedCommit,
  execute = false,
  ledger = new Ledger(api),
}) {
  if (actor !== policy.OWNER) throw new Error("Only the owner can migrate the usage ledger");
  if (typeof execute !== "boolean") throw new Error("Invalid migration execution flag");
  if ((execute || expectedCommit !== undefined) && !policy.SHA.test(expectedCommit || ""))
    throw new Error("An exact expected ledger commit is required");
  const snapshot = await ledger.read();
  if (expectedCommit !== undefined && expectedCommit !== snapshot.commit)
    throw new Error("Expected ledger commit changed");
  const preview = previewMigration(snapshot.state);
  const inventory = await safeWindow(api, snapshot.state);
  if (!execute)
    return {
      preview: true,
      ...preview,
      expectedCommit: snapshot.commit,
      quarantinedRunIds: inventory.quarantinedRunIds,
    };
  if (!preview.eligible) throw new Error(preview.reasons.join("; "));
  const result = await ledger.update(
    async (state) => {
      const current = previewMigration(state);
      if (!current.eligible || current.beforeDigest !== preview.beforeDigest)
        throw new Error("Migration state changed; preview again");
      const currentInventory = await safeWindow(api, state);
      const next = upgraded(state);
      next.audit.push({
        event: "factory-concurrency-migrated",
        at: new Date().toISOString(),
        actor,
        previousCommit: snapshot.commit,
        fromVersion: 1,
        toVersion: 2,
        beforeDigest: current.beforeDigest,
        afterDigest: current.afterDigest,
        quarantinedRunIds: currentInventory.quarantinedRunIds,
      });
      return { state: policy.validateState(next) };
    },
    { expectedCommit: snapshot.commit }
  );
  return {
    preview: false,
    migrated: true,
    commit: result.commit,
    previousCommit: snapshot.commit,
    beforeDigest: preview.beforeDigest,
    afterDigest: preview.afterDigest,
    quarantinedRunIds: inventory.quarantinedRunIds,
  };
}
async function main(env = process.env, args = process.argv.slice(2)) {
  const execute = args.includes("--execute");
  const expected = args.find((arg) => arg.startsWith("--expected="));
  if (
    args.some((arg) => arg !== "--execute" && !/^--expected=[a-f0-9]{40}$/.test(arg)) ||
    new Set(args).size !== args.length ||
    args.filter((arg) => arg.startsWith("--expected=")).length > 1
  )
    throw new Error("Usage: concurrency-migration.cjs [--expected=SHA] [--execute]");
  let token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    const reply = execFileSync(
      "git",
      ["-c", "credential.interactive=never", "credential", "fill"],
      {
        input: "protocol=https\nhost=github.com\n\n",
        encoding: "utf8",
        stdio: "pipe",
        timeout: 6000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      }
    );
    token = reply
      .split("\n")
      .find((line) => line.startsWith("password="))
      ?.slice(9)
      .trim();
  }
  if (!token) throw new Error("Existing owner GitHub authentication is required");
  const auth = await fetch("https://api.github.com/user", {
    redirect: "error",
    signal: AbortSignal.timeout(6000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!auth.ok) throw new Error("Owner GitHub authentication failed");
  const actor = (await auth.json()).login;
  const result = await migrateConcurrency({
    api: new GitHub({ token }),
    actor,
    expectedCommit: expected?.slice(11),
    execute,
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}
if (require.main === module)
  main().catch(() => {
    console.error(
      "Concurrency migration failed closed; keep the stop and switches unchanged, inspect the ledger and preview again. No credentials are logged."
    );
    process.exitCode = 1;
  });
module.exports = { previewMigration, migrateConcurrency, main };
