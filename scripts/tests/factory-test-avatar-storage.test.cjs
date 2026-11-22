const test = require("node:test");
const assert = require("node:assert/strict");
const { createAvatarStorage } = require("../../backend/avatar-storage.ts");
const { startAvatarFixture } = require("../factory/test-avatar-storage.cjs");

const key = "avatars/demo_profile/12345678-1234-1234-1234-123456789abc.png";
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("production avatar adapter writes and signs a read against the loopback fixture", async (t) => {
  const fixture = await startAvatarFixture();
  t.after(fixture.close);
  const original = Object.fromEntries(
    Object.keys(fixture.env).map((name) => [name, process.env[name]])
  );
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, fixture.env);
  assert.match(fixture.origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]+$/);
  const storage = createAvatarStorage();
  assert.ok(storage);
  await storage.upload(key, image, "image/png");
  const signed = new URL(await storage.url(key));
  assert.equal(signed.origin, fixture.origin);
  assert.equal(signed.pathname, "/factory-avatar-fixture/" + key);
  assert.equal(signed.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  const response = await fetch(signed, { redirect: "error" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
});

test("the fixture rejects unsigned access and closing discards the listener", async () => {
  const fixture = await startAvatarFixture();
  const url = fixture.origin + "/factory-avatar-fixture/" + key;
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal(
      (await fetch(url, { method: "PUT", body: image, headers: { "Content-Type": "image/png" } }))
        .status,
      403
    );
    assert.equal((await fetch(fixture.origin + "/other")).status, 404);
    assert.equal((await fetch(url, { method: "DELETE" })).status, 405);
  } finally {
    await fixture.close();
  }
  await fixture.close();
  await assert.rejects(fetch(url));
});
