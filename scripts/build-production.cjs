const { execFileSync } = require("node:child_process");
const { cpSync, mkdirSync, existsSync } = require("node:fs");
const { join, dirname } = require("node:path");

function run(entry, args, env = {}) {
  const script =
    entry === "vite"
      ? join(dirname(require.resolve("vite/package.json")), "bin/vite.js")
      : require.resolve(entry);
  execFileSync(process.execPath, [script, ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

// Optional Cognito imports exist even when local authentication is selected.
// A clean checkout needs the upstream mocks; preserve configured local files.
for (const [source, destination] of [
  ["scripts/mock-aws-exports.js", "src/aws-exports.js"],
  ["scripts/mock-aws-exports-es5.js", "aws-exports-es5.js"],
]) {
  if (!existsSync(destination)) cpSync(source, destination);
}

run("vite", ["build", "--outDir", "dist/client"], {
  VITE_API_BASE_URL: "/api",
  CYPRESS_COVERAGE: "false",
});
run("typescript/bin/tsc", ["-p", "tsconfig.production.json"]);
mkdirSync("dist/server/backend/graphql", { recursive: true });
mkdirSync("dist/server/data", { recursive: true });
cpSync("backend/graphql/schema.graphql", "dist/server/backend/graphql/schema.graphql");
cpSync("data/database-seed.json", join("dist/server/data", "database-seed.json"));
