const { APP_URL } = require("./deploy-render.cjs");
const MAX_BODY = 64 * 1024;
const TIMEOUT = 10000;
const RETRY_DELAY = 30000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function credentials(username, password) {
  if (
    typeof username !== "string" ||
    !username.length ||
    username.length > 100 ||
    typeof password !== "string" ||
    !password.length ||
    password.length > 256 ||
    /[\x00-\x1f\x7f]/.test(username + password)
  )
    throw Error("Invalid synthetic account configuration");
}
function cookieFrom(headers) {
  const values = headers.getSetCookie();
  if (values.join("").length > 4096) throw Error("Invalid session header");
  const sid = values.filter((value) => /^connect\.sid=/.test(value));
  if (sid.length > 1) throw Error("Ambiguous session header");
  if (!sid.length) return undefined;
  const pair = sid[0].split(";")[0];
  if (pair === "connect.sid=") return null;
  if (
    !/^connect\.sid=[A-Za-z0-9%._~+/=-]{1,2048}$/.test(pair) ||
    !/;\s*Secure(?:;|$)/i.test(sid[0]) ||
    !/;\s*HttpOnly(?:;|$)/i.test(sid[0])
  )
    throw Error("Invalid session header");
  return pair;
}
async function request(fetch, route, method, cookie, body, timeoutMs, receivedCookie = () => {}) {
  const controller = new AbortController();
  let reader, timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(APP_URL + route, {
          method,
          redirect: "manual",
          credentials: "omit",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            Origin: APP_URL,
            "Cache-Control": "no-cache",
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (controller.signal.aborted) return null;
        const sessionCookie = cookieFrom(response.headers);
        receivedCookie(sessionCookie);
        const size = response.headers.get("content-length");
        if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_BODY)) return null;
        const chunks = [];
        let total = 0;
        if (response.body) {
          reader = response.body.getReader();
          while (!controller.signal.aborted) {
            const part = await reader.read();
            if (controller.signal.aborted) return null;
            if (part.done) break;
            total += part.value.byteLength;
            if (total > MAX_BODY) return null;
            chunks.push(Buffer.from(part.value));
          }
        }
        let data = null;
        if (/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) {
          try {
            data = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
          } catch {}
        }
        return {
          status: response.status,
          data,
          sessionCookie,
          location: response.headers.get("location"),
        };
      })().catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}
const publicIdentity = (user) =>
  user &&
  typeof user === "object" &&
  !Array.isArray(user) &&
  typeof user.id === "string" &&
  user.id.length > 0 &&
  user.id.length <= 100 &&
  typeof user.username === "string" &&
  !Object.hasOwn(user, "password");
function validFeed(data) {
  const page = data?.pageData;
  return (
    Array.isArray(data?.results) &&
    data.results.length <= 5 &&
    data.results.every(
      (item) => item && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 100
    ) &&
    page?.page === 1 &&
    page.limit === 5 &&
    Number.isSafeInteger(page.totalPages) &&
    page.totalPages >= 0 &&
    typeof page.hasNextPages === "boolean" &&
    page.hasNextPages === page.totalPages > 1 &&
    (page.totalPages === 0 ? data.results.length === 0 : data.results.length > 0)
  );
}
async function attempt(fetch, username, password, timeoutMs) {
  const checks = { login: "failed", session: "failed", feed: "failed", logout: "failed" };
  let cookie, lastCookie;
  const call = async (route, method = "GET", body) => {
    return request(fetch, route, method, cookie, body, timeoutMs, (value) => {
      if (value !== undefined) {
        cookie = value;
        if (cookie) lastCookie = cookie;
      }
    });
  };
  try {
    const login = await call("/api/login", "POST", { username, password, remember: false });
    if (
      login?.status !== 200 ||
      !cookie ||
      !publicIdentity(login.data?.user) ||
      login.data.user.username !== username
    )
      return checks;
    checks.login = "ok";
    const session = await call("/api/checkAuth");
    if (
      session?.status !== 200 ||
      !cookie ||
      !publicIdentity(session.data?.user) ||
      session.data.user.id !== login.data.user.id ||
      session.data.user.username !== username
    )
      return checks;
    checks.session = "ok";
    const feed = await call("/api/transactions/public?page=1&limit=5");
    if (feed?.status === 200 && cookie && validFeed(feed.data)) checks.feed = "ok";
    return checks;
  } finally {
    if (lastCookie) {
      const oldCookie = lastCookie;
      const logout = await request(fetch, "/api/logout", "POST", oldCookie, undefined, timeoutMs);
      const after = await request(fetch, "/api/checkAuth", "GET", oldCookie, undefined, timeoutMs);
      if (
        logout?.status === 302 &&
        logout.location === "/" &&
        after?.status === 401 &&
        typeof after.data?.error === "string" &&
        !Object.hasOwn(after.data, "user")
      )
        checks.logout = "ok";
    }
  }
}
async function pause(sleep) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => sleep(RETRY_DELAY))
        .then(
          () => true,
          () => false
        ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), RETRY_DELAY + 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function probeUserJourney({
  username,
  password,
  fetch = globalThis.fetch,
  sleep = delay,
  attempts = 3,
  requestTimeoutMs = TIMEOUT,
} = {}) {
  credentials(username, password);
  if (
    typeof fetch !== "function" ||
    typeof sleep !== "function" ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 3 ||
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > TIMEOUT
  )
    throw Error("Invalid app-check bounds");
  for (let count = 1; count <= attempts; count++) {
    const checks = await attempt(fetch, username, password, requestTimeoutMs);
    const healthy = Object.values(checks).every((value) => value === "ok");
    const result = { healthy, checks, attempts: count };
    if (healthy || count === attempts || !(await pause(sleep))) return result;
  }
}
module.exports = { credentials, probeUserJourney };
