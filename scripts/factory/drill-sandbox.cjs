const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { serverSource } = require("./drill-fixture.cjs");
const { oracleSource } = require("./drill/oracle.cjs");
const { SHA, validateSource, validateObservation } = require("./drill/validation.cjs");

// Docker Hub manifest-list digest resolved from library/node:22.20.0-alpine on
// 2026-11-14. Never execute a mutable tag or caller-selected container image.
const IMAGE =
  "node:22.20.0-alpine@sha256:dbcedd8aeab47fbc0f4dd4bffa55b7c3c729a707875968d467aaaea42d6225af";

function runDocker(args, options) {
  return new Promise((resolve, reject) => {
    const { input, ...execOptions } = options;
    const child = execFile("docker", args, execOptions, (error, stdout) => {
      if (error) reject(new Error("Isolated Docker operation failed"));
      else resolve({ stdout });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}

async function checkFixture(source, { release, run = runDocker } = {}) {
  validateSource(source);
  if (typeof release !== "string" || !SHA.test(release)) throw new Error("Invalid fixture release");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "factory-drill-"));
  const candidate = path.join(folder, "readiness.cjs");
  const name = `factory-drill-${randomUUID()}`;
  const env = Object.fromEntries(
    ["PATH", "SystemRoot", "WINDIR"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])
  );
  // Docker receives an empty home/config directory, never the caller's registry
  // credentials, context configuration, proxies, provider tokens or GitHub env.
  env.HOME = folder;
  const options = { env, timeout: 60000, maxBuffer: 8192, encoding: "utf8", windowsHide: true };
  const failure = {
    healthy: false,
    checks: { health: "failed", readiness: "failed", frontend: "failed", regression: "failed" },
    attempts: 1,
  };
  try {
    fs.writeFileSync(candidate, source, { mode: 0o444 });
    await run(
      [
        "run",
        "--detach",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--user",
        "10001:10001",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--pids-limit",
        "32",
        "--memory",
        "128m",
        "--memory-swap",
        "128m",
        "--cpus",
        "0.5",
        "--log-driver",
        "none",
        "--mount",
        `type=bind,source=${candidate},target=/candidate/readiness.cjs,readonly`,
        "--entrypoint",
        "node",
        IMAGE,
        "--eval",
        serverSource(release),
      ],
      options
    );
    const result = await run(["exec", "--interactive", "--user", "0:0", name, "node", "-"], {
      ...options,
      timeout: 15000,
      input: oracleSource(release),
    });
    if (typeof result?.stdout !== "string" || Buffer.byteLength(result.stdout) > 4096)
      return failure;
    return validateObservation(JSON.parse(result.stdout), release);
  } catch {
    return failure;
  } finally {
    try {
      await run(["rm", "--force", name], { ...options, timeout: 10000 });
    } finally {
      // Recheck the absolute destination before recursive cleanup, including on
      // Windows. Only our direct child of the temporary directory is removable.
      const resolved = path.resolve(folder);
      if (
        path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
        !/^factory-drill-[A-Za-z0-9]+$/.test(path.basename(resolved)) ||
        fs.lstatSync(resolved).isSymbolicLink()
      )
        throw new Error("Unsafe sandbox cleanup destination");
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

module.exports = { checkFixture };
