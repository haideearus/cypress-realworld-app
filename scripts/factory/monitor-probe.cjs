const { APP_URL } = require("./deploy-render.cjs");

const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 30000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Monitoring is deliberately read-only. These are the only destinations, and
// no response body, header, URL, or exception is included in the public result.
async function readProbe(fetch, path, timeoutMs) {
  const controller = new AbortController();
  let timer;
  let reader;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(`${APP_URL}${path}`, {
          method: "GET",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
          headers: { Accept: "application/json, text/html", "Cache-Control": "no-cache" },
        });
        if (response.status !== 200) return null;
        const declaredLength = response.headers.get("content-length");
        if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) return null;
        const chunks = [];
        let total = 0;
        if (response.body) {
          reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_BODY_BYTES) return null;
            chunks.push(Buffer.from(value));
          }
        }
        return {
          contentType: response.headers.get("content-type") || "",
          text: Buffer.concat(chunks, total).toString("utf8"),
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

function parseJson(response) {
  if (!response || !/^application\/json(?:\s*;|$)/i.test(response.contentType)) return null;
  try {
    return JSON.parse(response.text);
  } catch {
    return null;
  }
}

async function pause(sleep) {
  let timer;
  try {
    // Production sleep is a normal timer. This bound also prevents a broken
    // injected sleep from leaving a monitoring job running indefinitely.
    return await Promise.race([
      Promise.resolve()
        .then(() => sleep(RETRY_DELAY_MS))
        .then(
          () => true,
          () => false
        ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), RETRY_DELAY_MS + 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function probeApp({
  fetch = globalThis.fetch,
  sleep = delay,
  attempts = 3,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (
    typeof fetch !== "function" ||
    typeof sleep !== "function" ||
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > 3 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > REQUEST_TIMEOUT_MS
  )
    throw new Error("Invalid monitor probe configuration");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Three independent requests share each round, limiting normal total time
    // to three 30-second request windows plus two 30-second cold-start pauses.
    const [healthResponse, readyResponse, frontendResponse] = await Promise.all([
      readProbe(fetch, "/healthz", requestTimeoutMs),
      readProbe(fetch, "/readyz", requestTimeoutMs),
      readProbe(fetch, "/", requestTimeoutMs),
    ]);
    const health = parseJson(healthResponse);
    const readiness = parseJson(readyResponse);
    const healthOk =
      health?.status === "ok" &&
      typeof health.release === "string" &&
      health.release.length === 40 &&
      /^[a-f0-9]{40}$/.test(health.release);
    const readyOk = readiness?.status === "ok";
    const frontendOk = Boolean(
      frontendResponse &&
        /^text\/html(?:\s*;|$)/i.test(frontendResponse.contentType) &&
        /<(?:div|main)\b[^>]*\s+id\s*=\s*(["'])root\1(?:\s|>)/i.test(frontendResponse.text)
    );
    const result = {
      healthy: healthOk && readyOk && frontendOk,
      checks: {
        health: healthOk ? "ok" : "failed",
        readiness: readyOk ? "ok" : "failed",
        frontend: frontendOk ? "ok" : "failed",
      },
      attempts: attempt,
      ...(healthOk ? { release: health.release } : {}),
    };
    if (result.healthy || attempt === attempts || !(await pause(sleep))) return result;
  }
}

module.exports = { probeApp };
