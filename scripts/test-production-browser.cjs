const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, readFileSync, unlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, dirname } = require("node:path");
const { randomBytes } = require("node:crypto");
const https = require("node:https");
const http = require("node:http");

async function main() {
  const uri = process.env.TEST_DATABASE_URL;
  if (!uri || !new URL(uri).pathname.endsWith("_test"))
    throw new Error("Use a disposable database ending in _test");
  const temporary = mkdtempSync(join(tmpdir(), "rwa-browser-test-"));
  const key = join(temporary, "key.pem");
  const cert = join(temporary, "cert.pem");
  execFileSync(
    process.env.OPENSSL_BINARY || "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" }
  );
  const origin = "https://127.0.0.1:8443";
  const server = spawn(process.execPath, ["dist/server/backend/main.js"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: "8081",
      HOST: "127.0.0.1",
      DATABASE_URL: uri,
      SESSION_SECRET: randomBytes(32).toString("hex"),
      APP_ORIGIN: origin,
    },
    stdio: "inherit",
  });
  const proxy = https.createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (req, res) => {
      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: 8081,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, "x-forwarded-proto": "https" },
        },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.on("error", () => res.destroy());
          response.pipe(res);
        }
      );
      upstream.on("error", () => {
        if (res.headersSent) res.destroy();
        else {
          res.writeHead(502);
          res.end();
        }
      });
      req.pipe(upstream);
    }
  );
  try {
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(8443, "127.0.0.1", resolve);
    });
    let ready = false;
    for (let i = 0; i < 300; i++) {
      if (server.exitCode !== null) throw new Error("Production server exited");
      try {
        ready = (await fetch("http://127.0.0.1:8081/healthz")).ok;
      } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error("Production server readiness timeout");
    execFileSync(process.execPath, ["--test", "scripts/tests/production-smoke.test.cjs"], {
      stdio: "inherit",
      env: { ...process.env, TEST_APP_URL: "http://127.0.0.1:8081", TEST_APP_ORIGIN: origin },
    });
    // Keep this event loop available to serve the browser through the TLS proxy.
    const browser = spawn(
      process.execPath,
      [
        join(dirname(require.resolve("cypress/package.json")), "bin/cypress"),
        "run",
        "--config-file",
        "scripts/cypress.production.config.cjs",
        "--browser",
        "electron",
        "--spec",
        "scripts/tests/production-browser.cy.js",
        "--config",
        `baseUrl=${origin},supportFile=false,video=false,retries=0,specPattern=scripts/tests/production-browser.cy.js`,
      ],
      { stdio: "inherit" }
    );
    const [exitCode] = await once(browser, "exit");
    if (exitCode !== 0) throw new Error("Cypress production browser check failed");
  } finally {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
    unlinkSync(key);
    unlinkSync(cert);
  }
}

void main().catch(() => {
  console.error("Production browser check failed; inspect test output above");
  process.exitCode = 1;
});
