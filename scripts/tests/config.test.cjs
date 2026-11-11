const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readConfig } = require("../../dist/server/backend/config.js");

test("the compiled backend includes its optional authentication configuration", () => {
  assert.doesNotThrow(() => require("../../dist/server/backend/helpers.js"));
});

const valid = {
  NODE_ENV: "production",
  PORT: "8081",
  SESSION_SECRET: "x".repeat(32),
  DATABASE_URL: "postgresql://localhost/rwa_test",
  APP_ORIGIN: "https://rwa.example.test",
};
test("production requires server-only secrets and a valid origin", () => {
  assert.equal(readConfig(valid).port, 8081);
  for (const key of ["SESSION_SECRET", "DATABASE_URL", "APP_ORIGIN"]) {
    assert.throws(() => readConfig({ ...valid, [key]: "" }));
  }
  for (const port of ["0", "65536", "abc", "1.5"])
    assert.throws(() => readConfig({ ...valid, PORT: port }));
  assert.throws(() => readConfig({ ...valid, APP_ORIGIN: "http://example.com" }));
  assert.throws(() => readConfig({ ...valid, DATABASE_URL: "https://example.com" }));
});

test("configuration errors do not repeat credential-bearing input", () => {
  const secret = "private-database-password";
  assert.throws(
    () => readConfig({ ...valid, DATABASE_URL: secret }),
    (error) => !error.message.includes(secret)
  );
});
