const assert = require("node:assert/strict");
const { test } = require("node:test");

const origin = process.env.TEST_APP_URL || "http://127.0.0.1:8081";

test("production health reports readiness without exposing configuration", async () => {
  const response = await fetch(`${origin}/healthz`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.status, "ok");
  assert.equal("databaseUrl" in health, false);
  assert.equal("sessionSecret" in health, false);
});

test("the production origin serves the React frontend", async () => {
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<div id="root"/);
});

test("production does not expose test reset routes", async () => {
  for (const route of ["/testData/seed", "/api/testData/seed"]) {
    const response = await fetch(`${origin}${route}`, {
      method: "POST",
      headers: { origin: process.env.TEST_APP_ORIGIN || "https://rwa.example.test" },
    });
    assert.equal(response.status, 404);
  }
});

test("unknown API paths return a JSON 404 instead of the frontend", async () => {
  const response = await fetch(`${origin}/api/not-a-route`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /application\/json/);
});
