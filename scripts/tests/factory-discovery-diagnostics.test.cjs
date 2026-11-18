const test = require("node:test");
const assert = require("node:assert/strict");
let diagnostic, withStage;
try {
  ({ diagnostic, withStage } = require("../factory/discovery-diagnostics.cjs"));
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
const secret = "testsecret";
test("diagnostics contain only allowlisted fields and fixed classifications", () => {
  const error = Object.assign(new Error(`https://private.example/${secret}`), {
    status: 429,
    rateLimited: true,
    token: secret,
    headers: { authorization: secret },
    response: secret,
  });
  assert.deepEqual(diagnostic("discovery", error), {
    stage: "discovery",
    code: "factory-operation-failed",
    category: "rate-limit",
    status: 429,
  });
  assert.ok(!JSON.stringify(diagnostic("discovery", error)).includes(secret));
});
test("unknown stages and non-integer HTTP statuses cannot copy untrusted values", () => {
  for (const status of [secret, "403", 99, 600, 403.5, NaN, Infinity, null]) {
    assert.deepEqual(diagnostic(`https://private.example/${secret}`, { status, message: secret }), {
      stage: "unknown",
      code: "factory-operation-failed",
      category: "unknown",
    });
  }
  assert.deepEqual(diagnostic("recovery", { status: 403, message: secret }), {
    stage: "recovery",
    code: "factory-operation-failed",
    category: "http",
    status: 403,
  });
});
test("each replay phase remains identifiable without copying errors", async () => {
  for (const stage of [
    "image-build",
    "replay-prepare",
    "proposal-replay",
    "oracle-replay",
    "finalization",
  ]) {
    const error = new Error(secret);
    await assert.rejects(
      withStage(stage, async () => {
        throw error;
      }),
      (caught) => {
        assert.equal(caught, error);
        assert.equal(diagnostic("discovery", caught).stage, stage);
        assert.ok(!JSON.stringify(diagnostic("discovery", caught)).includes(secret));
        return true;
      }
    );
  }
});
test("withStage returns successful values and safely annotates frozen or primitive failures", async () => {
  assert.equal(await withStage("discovery", async () => 11), 11);
  const error = Object.freeze(new Error(secret));
  await assert.rejects(
    withStage("oracle-replay", () => {
      throw error;
    }),
    (caught) => {
      assert.equal(caught, error);
      assert.equal(diagnostic("discovery", caught).stage, "oracle-replay");
      return true;
    }
  );
  await assert.rejects(
    withStage(secret, () => {
      throw secret;
    }),
    (caught) => {
      assert.equal(caught, secret);
      assert.equal(diagnostic(secret, caught).stage, "unknown");
      return true;
    }
  );
});
test("nested stages preserve the innermost known failing phase", async () => {
  await assert.rejects(
    withStage("discovery", () =>
      withStage("proposal-replay", () => {
        throw Object.assign(new Error(secret), { stage: secret, rateLimited: "true" });
      })
    ),
    (error) => {
      assert.deepEqual(diagnostic("recovery", error), {
        stage: "proposal-replay",
        code: "factory-operation-failed",
        category: "unknown",
      });
      return true;
    }
  );
});
