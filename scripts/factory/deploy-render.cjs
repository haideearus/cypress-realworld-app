// This transport performs no authentication, database writes, or model calls.
// Its only write is one approved, exact-commit request to the configured hook.
const APP_URL = "https://haide-software-factory.onrender.com";
const SHA = /^[a-f0-9]{40}$/;
const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const VERIFICATION_TIMEOUT_MS = 20 * 60 * 1000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertRelease(sha) {
  if (typeof sha !== "string" || sha.length !== 40 || !SHA.test(sha))
    throw new Error("Invalid release SHA");
}

function hookUrl(hook, sha) {
  assertRelease(sha);
  try {
    if (
      typeof hook !== "string" ||
      hook.length > 4096 ||
      hook !== hook.trim() ||
      !/^https:\/\/api\.render\.com\//i.test(hook)
    )
      throw new Error();
    const url = new URL(hook);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.render.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/deploy\/srv-[a-zA-Z0-9]+$/.test(url.pathname) ||
      url.searchParams.getAll("key").length !== 1 ||
      !url.searchParams.get("key") ||
      /\s/.test(url.searchParams.get("key")) ||
      url.searchParams.getAll("ref").length > 1 ||
      [...url.searchParams.keys()].some((key) => !["key", "ref"].includes(key))
    )
      throw new Error();
    url.searchParams.set("ref", sha);
    return url;
  } catch {
    // A URL parser or fetch error can contain the secret hook. Never propagate it.
    throw new Error("Invalid deploy hook");
  }
}

function validRequestTimeout(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= REQUEST_TIMEOUT_MS;
}

async function boundedText(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES)
    throw new Error("Response too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) throw new Error("Response too large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    // Cancellation also releases a stream rejected before it reaches EOF.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function request(fetch, url, method, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(String(url), {
          method,
          redirect: "error",
          signal: controller.signal,
          headers: { "Cache-Control": "no-cache", Accept: "application/json, text/html" },
        });
        return {
          status: response.status,
          contentType: response.headers.get("content-type") || "",
          text: await boundedText(response),
        };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Request timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function triggerDeploy({
  hook,
  sha,
  fetch = globalThis.fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const url = hookUrl(hook, sha);
  if (!validRequestTimeout(requestTimeoutMs)) throw new Error("Invalid deploy request timeout");
  let response;
  try {
    // A timeout could occur after Render accepts the request. Never POST twice.
    response = await request(fetch, url, "POST", requestTimeoutMs);
  } catch {
    throw new Error("Deploy request failed; inspect Render before starting a new approved run");
  }
  if (![200, 202].includes(response.status))
    throw new Error(
      `Deploy request failed (HTTP ${response.status}); inspect Render before retrying`
    );
  const body = parseJson(response.text);
  const deployId = body?.deploy?.id ?? body?.id;
  return {
    httpStatus: response.status,
    deployId:
      typeof deployId === "string" &&
      /^dep-[a-zA-Z0-9]{1,100}$/.test(deployId) &&
      !/\s/.test(deployId)
        ? deployId
        : null,
  };
}

async function waitForRelease({
  sha,
  fetch = globalThis.fetch,
  sleep = delay,
  now = Date.now,
  timeoutMs = VERIFICATION_TIMEOUT_MS,
  intervalMs = 15000,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  assertRelease(sha);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > VERIFICATION_TIMEOUT_MS ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > 60000 ||
    !validRequestTimeout(requestTimeoutMs)
  )
    throw new Error("Invalid verification bounds");
  const deadline = now() + timeoutMs;
  const read = async (path) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Verification deadline reached");
    const response = await request(
      fetch,
      `${APP_URL}${path}`,
      "GET",
      Math.min(requestTimeoutMs, remaining)
    );
    if (now() >= deadline || response.status !== 200) throw new Error("Release not ready");
    return response;
  };
  const health = async () => {
    const response = await read("/healthz");
    const data = parseJson(response.text);
    if (data?.status !== "ok" || data.release !== sha) throw new Error("Release not ready");
  };
  // The elapsed-time deadline is primary; this cap also prevents a broken injected
  // clock/sleep implementation from producing an unbounded loop.
  for (let attempt = 0; attempt < 120 && now() < deadline; attempt++) {
    try {
      await health();
      const ready = parseJson((await read("/readyz")).text);
      if (ready?.status !== "ok") throw new Error("Database not ready");
      const frontend = await read("/");
      if (
        !/^text\/html(?:\s*;|$)/i.test(frontend.contentType) ||
        !/<(?:div|main)\b[^>]*\s+id\s*=\s*(["'])root\1(?:\s|>)/i.test(frontend.text)
      )
        throw new Error("Frontend not ready");
      await health();
      return {
        release: sha,
        health: true,
        ready: true,
        frontend: true,
        observedAt: new Date(now()).toISOString(),
      };
    } catch {
      // Only fixed metadata is returned. Server responses and redirect targets
      // cannot enter logs, evidence artifacts, or exception messages.
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  throw new Error(
    "Release verification timed out; inspect Render and start a fresh approved run if needed"
  );
}

module.exports = { APP_URL, triggerDeploy, waitForRelease };
