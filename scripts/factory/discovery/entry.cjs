// Executed only inside an internal-network disposable container. No host env is passed.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const role = process.argv[2];
if (role === "health") {
  fetch("http://127.0.0.1:3001/healthz", { signal: AbortSignal.timeout(3000) })
    .then((r) => {
      process.exitCode = r.ok ? 0 : 1;
    })
    .catch(() => {
      process.exitCode = 1;
    });
} else if (role === "oracle") {
  const { probe } = require("/trusted/oracles.cjs");
  probe(JSON.parse(fs.readFileSync("/oracle-request.json", "utf8")))
    .then((r) => console.log(JSON.stringify(r)))
    .catch(() => {
      process.exitCode = 1;
    });
} else {
  const root = "/work/app";
  fs.mkdirSync(root, { recursive: true });
  for (const entry of fs.readdirSync("/source"))
    if (!["node_modules", ".git"].includes(entry))
      fs.cpSync(path.join("/source", entry), path.join(root, entry), { recursive: true });
  fs.symlinkSync("/source/node_modules", path.join(root, "node_modules"), "dir");
  process.chdir(root);
  const env = require("/trusted/runtime.cjs").environment(
    fs.readFileSync("/trusted/head.txt", "utf8").trim()
  );
  if (role === "app") {
    fs.copyFileSync("data/database-seed.json", "data/database.json");
    // Fixed synthetic fixture; never uses live accounts or external auth providers.
    const seed = JSON.parse(fs.readFileSync("data/database-seed.json", "utf8"));
    for (const u of seed.users)
      u.password = require("/source/node_modules/bcryptjs").hashSync("discovery-only-password", 4);
    fs.writeFileSync("data/database-seed.json", JSON.stringify(seed));
    fs.writeFileSync("data/database.json", JSON.stringify(seed));
    const child = spawn("yarn", ["start:ci"], { env, cwd: root, stdio: "inherit" });
    child.on("exit", (code) => {
      process.exitCode = code || 0;
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  } else if (role === "test") {
    const [mode, file] = process.argv.slice(3);
    fs.mkdirSync("discovery-tests");
    fs.copyFileSync("/proposals/" + file, "discovery-tests/" + file);
    let cmd, args;
    if (mode === "api") {
      cmd = "node";
      args = ["--test", "discovery-tests/" + file];
      env.DISCOVERY_API_URL = "http://localhost:3001";
    } else if (mode === "unit") {
      fs.writeFileSync(
        "discovery.config.mjs",
        `import {defineConfig} from 'vitest/config';export default defineConfig({test:{environment:'jsdom',setupFiles:['./src/setup-tests.js'],include:['discovery-tests/*.unit.test.{ts,tsx}'],fileParallelism:false}});`
      );
      cmd = "yarn";
      args = ["vitest", "run", "--config", "discovery.config.mjs"];
    } else if (mode === "cypress") {
      fs.writeFileSync(
        "discovery.config.cjs",
        `const {defineConfig}=require('cypress');module.exports=defineConfig(${JSON.stringify(require("/trusted/runtime.cjs").cypressConfig())});`
      );
      cmd = "yarn";
      args = [
        "cypress",
        "run",
        "--config-file",
        "discovery.config.cjs",
        "--browser",
        "electron",
        "--record",
        "false",
      ];
    } else throw Error("Unknown discovery mode");
    const r = spawnSync(cmd, args, { env, cwd: root, stdio: "inherit", timeout: 270000 });
    const resources = {};
    for (const name of ["pids.peak", "pids.events", "memory.events"]) {
      try {
        resources[name] = fs.readFileSync("/sys/fs/cgroup/" + name, "utf8").trim();
      } catch {}
    }
    console.log("Discovery resource summary:", JSON.stringify(resources));
    process.exitCode = r.status === null ? 124 : r.status;
  } else throw Error("Unknown isolated role");
}
