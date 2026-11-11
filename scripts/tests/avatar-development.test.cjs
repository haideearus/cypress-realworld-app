const assert = require("node:assert/strict");
const { test } = require("node:test");

test("development profile updates accept a localhost avatar endpoint", async () => {
  const base = "http://127.0.0.1:3001";
  const login = await fetch(base + "/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Heath93", password: "s3cret" }),
  });
  assert.equal(login.status, 200);
  const user = (await login.json()).user;
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const patch = (avatar) =>
    fetch(`${base}/users/${user.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ avatar }),
    });
  try {
    const local = `http://localhost:3001/avatars/${user.id}/12345678-1234-1234-1234-123456789abc.png`;
    assert.equal((await patch(local)).status, 204);
  } finally {
    await patch(user.avatar);
  }
});
