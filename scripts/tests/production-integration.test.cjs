const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { Pool } = require("pg");
const { randomBytes } = require("node:crypto");
const http = require("node:http");

const uri = process.env.TEST_DATABASE_URL;
if (!uri || !new URL(uri).pathname.endsWith("_test"))
  throw new Error("Use a disposable database whose name ends with _test");
const port = 8081;
const origin = "https://rwa.example.test";
const base = `http://127.0.0.1:${port}`;
const secret = randomBytes(32).toString("hex");
let server;
async function start() {
  server = spawn(process.execPath, ["dist/server/backend/main.js"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_URL: uri,
      SESSION_SECRET: secret,
      APP_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) throw new Error("Production server exited before becoming ready");
    try {
      ready = (await fetch(`${base}/healthz`)).ok;
    } catch {}
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Production server readiness timeout");
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, "exit");
  server.kill();
  await exited;
}

test(
  "production retains users, payments, and login sessions after process restart",
  { timeout: 90000 },
  async () => {
    const pool = new Pool({ connectionString: uri });
    let cookie;
    const api = (path, method = "GET", body, extra = {}) =>
      fetch(`${base}/api${path}`, {
        method,
        redirect: "manual",
        headers: {
          origin,
          "x-forwarded-proto": "https",
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
          ...extra,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    try {
      await pool.query("DROP TABLE IF EXISTS rwa_state, rwa_sessions");
      await start();
      const login = await api("/login", "POST", {
        username: "Heath93",
        password: "s3cret",
        remember: true,
      });
      assert.equal(login.status, 200);
      const setCookie = login.headers.get("set-cookie");
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /Secure/i);
      assert.match(setCookie, /SameSite=Lax/i);
      cookie = setCookie.split(";")[0];
      const user = (await login.json()).user;
      const slowUpload = http.request(
        `${base}/api/avatars`,
        {
          method: "POST",
          headers: {
            cookie,
            origin,
            "x-forwarded-proto": "https",
            "content-type": "image/png",
            "content-length": "1024",
          },
        },
        (response) => response.resume()
      );
      slowUpload.on("error", () => {});
      slowUpload.write(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      let responsive = false;
      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const concurrent = await fetch(`${base}/api/checkAuth`, {
          headers: { cookie, "x-forwarded-proto": "https" },
          signal: AbortSignal.timeout(1500),
        });
        responsive = concurrent.status === 200;
      } catch {
      } finally {
        slowUpload.destroy();
      }
      assert.equal(
        responsive,
        true,
        "A partially uploaded image must not lock other users out of the API"
      );
      assert.equal(Object.hasOwn(user, "password"), false);
      const list = await (await api("/users")).json();
      assert.ok(list.results.every((u) => !Object.hasOwn(u, "password")));
      const change = await api(`/users/${user.id}`, "PATCH", { firstName: "DurableFactory" });
      assert.equal(change.status, 204);
      const payment = await api("/transactions", "POST", {
        transactionType: "payment",
        receiverId: list.results[0].id,
        amount: 100,
        description: "Persistent factory demonstration",
        privacyLevel: "public",
      });
      assert.equal(payment.status, 200);
      const transactionId = (await payment.json()).transaction.id;
      assert.ok(transactionId);
      await stop();
      await start();
      const checked = await api("/checkAuth");
      assert.equal(checked.status, 200);
      assert.equal((await checked.json()).user.firstName, "DurableFactory");
      const history = await api(`/transactions/${transactionId}`);
      assert.equal(history.status, 200);
      assert.equal(
        (await history.json()).transaction.description,
        "Persistent factory demonstration"
      );
      const rejected = await api(
        `/users/${user.id}`,
        "PATCH",
        { firstName: "Blocked" },
        { origin: "https://attacker.example" }
      );
      assert.equal(rejected.status, 403);
      await pool.query(
        "ALTER TABLE rwa_state ADD CONSTRAINT reject_writes CHECK (revision < 0) NOT VALID"
      );
      try {
        const failed = await api(`/users/${user.id}`, "PATCH", { firstName: "MustNotCommit" });
        assert.equal(failed.status, 503);
        assert.deepEqual(await failed.json(), { error: "Database temporarily unavailable" });
      } finally {
        await pool.query("ALTER TABLE rwa_state DROP CONSTRAINT reject_writes");
      }
      assert.equal((await (await api("/checkAuth")).json()).user.firstName, "DurableFactory");
      const site = await fetch(base);
      assert.match(await site.text(), /<div id="root"/);
      for (const path of ["/testData/seed", "/api/testData/seed"]) {
        assert.equal(
          (await fetch(`${base}${path}`, { method: "POST", headers: { origin } })).status,
          404
        );
      }
      const unknown = await fetch(`${base}/api/unknown`);
      assert.equal(unknown.status, 404);
      assert.match(unknown.headers.get("content-type"), /application\/json/);
      const logout = await api("/logout", "POST");
      assert.equal(logout.status, 302);
      assert.equal((await api("/checkAuth")).status, 401);
    } finally {
      await stop();
      await pool.end();
    }
  }
);
