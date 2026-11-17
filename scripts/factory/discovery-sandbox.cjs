const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const c = require("./discovery-contract.cjs");
const { secretLike } = require("./artifacts.cjs");
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const FILE = /^[a-z][a-z0-9-]{0,60}\.(?:api\.test\.cjs|unit\.test\.(?:ts|tsx)|cy\.ts)$/;
function safeEnv(env = process.env) {
  return Object.fromEntries(
    ["PATH", "SystemRoot", "WINDIR"].filter((k) => env[k]).map((k) => [k, env[k]])
  );
}
function validateRequest(r) {
  c.exact(r, ["mode", "file"]);
  if (
    !["api", "unit", "cypress"].includes(r.mode) ||
    !FILE.test(r.file) ||
    !r.file.endsWith(
      {
        api: ".api.test.cjs",
        unit: r.file.endsWith(".tsx") ? ".unit.test.tsx" : ".unit.test.ts",
        cypress: ".cy.ts",
      }[r.mode]
    )
  )
    throw Error("Invalid discovery batch request");
  return r;
}
function regularProposal(root, name) {
  if (typeof name !== "string" || !/^tests\//.test(name) || !FILE.test(name.slice(6)))
    throw Error("Invalid proposal path");
  const target = path.join(root, ...name.split("/"));
  for (const f of [root, path.join(root, "tests"), target]) {
    const st = fs.lstatSync(f);
    if (st.isSymbolicLink()) throw Error("Proposal symlink rejected");
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 50000)
    throw Error("Proposal must be bounded regular file");
  return target;
}
function containerArgs({ name, network, image, role, testDir, mode, file, oracleFile, appName }) {
  if (
    !/^discovery-[a-z0-9-]{1,90}$/.test(name) ||
    !/^discovery-[a-z0-9-]{1,90}$/.test(network) ||
    !IMAGE.test(image) ||
    !["app", "test", "oracle"].includes(role)
  )
    throw Error("Invalid discovery container identity");
  if (role === "test") {
    validateRequest({ mode, file });
    if (!/^discovery-app-[a-z0-9-]{1,80}$/.test(appName || ""))
      throw Error("Invalid disposable app network owner");
  }
  const args = [
    "run",
    "--name",
    name,
    "--network",
    role === "test" ? `container:${appName}` : network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--pids-limit",
    "256",
    "--memory",
    "3g",
    "--memory-swap",
    "3g",
    "--cpus",
    "2",
    "--user",
    "1000:1000",
    "--tmpfs",
    "/work:rw,nosuid,size=1073741824,uid=1000,gid=1000",
    "--tmpfs",
    "/tmp:rw,nosuid,size=536870912,uid=1000,gid=1000",
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=1m",
    "--log-opt",
    "max-file=1",
    "--log-opt",
    "compress=false",
  ];
  if (role === "app") args.push("--detach", "--network-alias", "app");
  if (role === "test")
    args.push("--mount", `type=bind,source=${testDir},target=/proposals,readonly`);
  if (role === "oracle")
    args.push("--mount", `type=bind,source=${oracleFile},target=/oracle-request.json,readonly`);
  args.push(image, "node", "/trusted/entry.cjs", role);
  if (role === "test") args.push(mode, file);
  return args;
}
function docker(args, { timeout = 300000, input, env = safeEnv(), ...other } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      args,
      { env, timeout, maxBuffer: 250000, encoding: "utf8", windowsHide: true, ...other },
      (error, stdout, stderr) => {
        if (error && (!Number.isInteger(error.code) || error.killed))
          reject(Error("Isolated discovery operation failed or timed out"));
        else resolve({ code: error ? error.code : 0, stdout, stderr });
      }
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}
class BatchBudget {
  constructor(execute) {
    this.execute = execute;
    this.count = 0;
    this.busy = false;
  }
  async run(request) {
    validateRequest(request);
    if (this.busy || this.count >= 4) throw Error("Discovery batch limit reached");
    this.count++;
    this.busy = true;
    try {
      return await this.execute(request, this.count);
    } finally {
      this.busy = false;
    }
  }
}
async function sandbox({ image, request, tests, oracle, run = docker }) {
  if (!IMAGE.test(image)) throw Error("Invalid immutable sandbox image");
  const id = randomUUID();
  const network = `discovery-${id}`;
  const app = `discovery-app-${id}`;
  const test = `discovery-test-${id}`;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-run-"));
  const options = { env: { ...safeEnv(), HOME: folder }, timeout: 300000 };
  const deadline = Date.now() + 300000;
  const boundedRun = (args, opts = options) => {
    const remaining = deadline - Date.now();
    if (remaining < 1) throw Error("Discovery five-minute batch deadline");
    return run(args, { ...opts, timeout: Math.min(opts.timeout, remaining) });
  };
  const checked = async (args, opts = options) => {
    const r = await boundedRun(args, opts);
    if (r.code !== 0) {
      const detail = String(r.stderr || "").slice(0, 700);
      throw Error(secretLike(detail) ? "Sandbox setup failed" : `Sandbox setup failed: ${detail}`);
    }
    return r;
  };
  try {
    await checked([
      "network",
      "create",
      "--internal",
      "--opt",
      "com.docker.network.bridge.gateway_mode_ipv4=isolated",
      network,
    ]);
    const inspect = await checked(["network", "inspect", network]);
    const net = JSON.parse(inspect.stdout)[0];
    if (
      net.Internal !== true ||
      net.Driver !== "bridge" ||
      net.EnableIPv6 === true ||
      net.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] !== "isolated"
    )
      throw Error("Internal network unavailable");
    await checked(containerArgs({ name: app, network, image, role: "app" }));
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      const r = await boundedRun(["exec", app, "node", "/trusted/entry.cjs", "health"], {
        ...options,
        timeout: 5000,
      });
      if (r.code === 0) {
        healthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!healthy) throw Error("Sandbox baseline startup failed");
    if (oracle) {
      const oracleFile = path.join(folder, "oracle.json");
      fs.writeFileSync(oracleFile, JSON.stringify(oracle), { mode: 0o644 });
      const result = await boundedRun(
        containerArgs({ name: test, network, image, role: "oracle", oracleFile }),
        options
      );
      if (result.code !== 0 || secretLike(result.stdout))
        throw Error("Trusted oracle execution failed");
      return { observation: JSON.parse(result.stdout), networkIsolated: true, image };
    }
    validateRequest(request);
    regularProposal(path.dirname(tests), "tests/" + request.file);
    const result = await boundedRun(
      containerArgs({
        name: test,
        network,
        image,
        role: "test",
        appName: app,
        testDir: tests,
        ...request,
      }),
      options
    );
    let exitState = null;
    if (result.code !== 0) {
      const inspected = await boundedRun(["inspect", test], { ...options, timeout: 5000 });
      if (inspected.code === 0) {
        const value = JSON.parse(inspected.stdout)[0]?.State;
        exitState = {
          status: value?.Status,
          exitCode: value?.ExitCode,
          oomKilled: value?.OOMKilled,
        };
      }
    }
    const text = (result.stdout + "\n" + result.stderr).slice(0, 120000);
    if (secretLike(text)) throw Error("Secret-bearing discovery result held");
    return {
      version: 1,
      image,
      mode: request.mode,
      file: request.file,
      code: result.code,
      exitState,
      log: text,
      logHash: c.digest(text),
      networkIsolated: true,
    };
  } finally {
    for (const n of [test, app])
      try {
        await run(["rm", "--force", n], { ...options, timeout: 10000 });
      } catch {}
    try {
      await run(["network", "rm", network], { ...options, timeout: 10000 });
    } catch {}
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
module.exports = {
  FILE,
  IMAGE,
  safeEnv,
  validateRequest,
  regularProposal,
  containerArgs,
  docker,
  BatchBudget,
  sandbox,
};
