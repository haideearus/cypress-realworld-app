const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");

const base = process.env.NEON_TEST_APP_URL || "http://127.0.0.1:8082";
const origin = process.env.NEON_TEST_APP_ORIGIN || "https://rwa.example.test";
const png = readFileSync("public/logo192.png");

test("Neon avatars require login, validate image bytes, and retain an uploaded picture", async () => {
  let cookie = "";
  const request = (path, method = "GET", body, type = "application/json") =>
    fetch(base + "/api" + path, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
      headers: {
        origin,
        "x-forwarded-proto": "https",
        "content-type": type,
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined
        ? { body: type === "application/json" ? JSON.stringify(body) : body }
        : {}),
    });
  const unauthenticated = await request("/avatars", "POST", png, "image/png");
  assert.equal(unauthenticated.status, 401);
  const username = "factory" + randomUUID().replaceAll("-", "").slice(0, 15);
  const signup = await request("/users", "POST", {
    firstName: "Factory",
    lastName: "StorageTest",
    username,
    password: "s3cret",
  });
  assert.equal(signup.status, 201);
  const user = (await signup.json()).user;
  const login = await request("/login", "POST", { username, password: "s3cret", remember: true });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  const invalid = await request("/avatars", "POST", Buffer.from("not an image"), "image/png");
  assert.equal(invalid.status, 400);
  const oversized = await request(
    "/avatars",
    "POST",
    Buffer.alloc(2 * 1024 * 1024 + 1),
    "image/png"
  );
  assert.equal(oversized.status, 413);
  const uploaded = await request("/avatars", "POST", png, "image/png");
  assert.equal(uploaded.status, 201);
  const { avatar } = await uploaded.json();
  assert.match(avatar, /^\/api\/avatars\//);
  const saved = await request(`/users/${user.id}`, "PATCH", { avatar });
  assert.equal(saved.status, 204);
  const authenticated = await request("/checkAuth");
  assert.equal((await authenticated.json()).user.avatar, avatar);
  const downloaded = await request(new URL(avatar, origin).pathname.replace(/^\/api/, ""));
  assert.equal(downloaded.status, 302);
  const storage = await fetch(downloaded.headers.get("location"));
  assert.equal(storage.status, 200);
  assert.deepEqual(Buffer.from(await storage.arrayBuffer()), png);
  const noCookie = await fetch(base + new URL(avatar, origin).pathname);
  assert.equal(noCookie.status, 401);
  const users = (await (await request("/users")).json()).results;
  if (users.length)
    assert.equal((await request(`/users/${users[0].id}`, "PATCH", { avatar })).status, 403);
  if (process.env.NEON_TEST_EVIDENCE)
    writeFileSync(
      process.env.NEON_TEST_EVIDENCE,
      JSON.stringify({ userId: user.id, username, cookie, avatar }),
      { mode: 0o600 }
    );
  console.log("Verified real Neon PostgreSQL profile metadata and private S3 upload/download.");
});
