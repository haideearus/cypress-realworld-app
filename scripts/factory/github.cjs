const { REPOSITORY, emptyState, validateState } = require("./policy.cjs");
const { setTimeout: delay } = require("node:timers/promises");
const ROOT = `/repos/${REPOSITORY}`;
const READ_BACKOFF_MS = [250, 1000];
const TRANSIENT_GATEWAY = new Set([502, 503, 504]);
const QUOTA_WAIT_BUDGET_MS = 65 * 60 * 1000;
const QUOTA_WAIT_LIMIT = 3;
const QUOTA_RESET_GRACE_MS = 1500;

async function quotaResetAt(response, now) {
  if (
    ![403, 429].includes(response.status) ||
    response.headers?.get("x-ratelimit-remaining") !== "0"
  )
    return null;
  const reset = response.headers.get("x-ratelimit-reset");
  if (!/^[1-9]\d{0,11}$/.test(reset || "")) return null;
  const body = await response.json().catch(() => null);
  if (typeof body?.message !== "string" || !/^API rate limit exceeded\b/i.test(body.message))
    return null;
  const retryAfter = response.headers.get("retry-after");
  const minimum = /^\d{1,9}$/.test(retryAfter || "") ? now + Number(retryAfter) * 1000 : now;
  return Math.max(Number(reset) * 1000, minimum) + QUOTA_RESET_GRACE_MS;
}

function quotaSafeRequest(method, path) {
  return (
    method === "GET" ||
    (method === "PATCH" && path === `${ROOT}/git/refs/heads/factory/state`) ||
    (method === "POST" &&
      ["/git/blobs", "/git/trees", "/git/commits", "/check-runs"].some(
        (suffix) => path === ROOT + suffix
      ))
  );
}

function primaryQuota(headers) {
  if (headers?.get("x-ratelimit-resource") !== "core") return null;
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  if (!/^[1-9]\d{0,8}$/.test(limit || "") || !/^\d{1,9}$/.test(remaining || "")) return null;
  if (Number(remaining) > Number(limit)) return null;
  const quota = { limit: Number(limit), remaining: Number(remaining) };
  const reset = headers.get("x-ratelimit-reset");
  if (/^[1-9]\d{0,11}$/.test(reset || "")) quota.reset = Number(reset) * 1000;
  return quota;
}

class GitHub {
  constructor({
    token,
    fetch: transport = globalThis.fetch,
    retryReads = false,
    retryInternalReads = false,
    waitOnQuota = false,
    now = Date.now,
    sleep = delay,
    onQuotaWait = () => {},
  }) {
    if (!token) throw new Error("GitHub job token is required");
    this.token = token;
    this.fetch = transport;
    this.retryReads = retryReads;
    this.retryInternalReads = retryInternalReads;
    this.waitOnQuota = waitOnQuota;
    this.now = now;
    this.sleep = sleep;
    this.onQuotaWait = onQuotaWait;
    this.quotaWaits = 0;
    this.quotaWaited = 0;
  }
  async waitForQuota(error) {
    if (!this.waitOnQuota || !Number.isFinite(error?.quotaResetAt)) return false;
    const wait = Math.max(QUOTA_RESET_GRACE_MS, error.quotaResetAt - this.now());
    if (this.quotaWaits >= QUOTA_WAIT_LIMIT || this.quotaWaited + wait > QUOTA_WAIT_BUDGET_MS)
      throw new Error("GitHub API quota wait budget exhausted; saved reservation retained", {
        cause: error,
      });
    this.quotaWaits++;
    this.quotaWaited += wait;
    this.onQuotaWait(new Date(this.now() + wait).toISOString());
    await this.sleep(wait);
    return true;
  }
  async request(method, path, body, { pollCache } = {}) {
    if (!path.startsWith(`${ROOT}/`) || /[\\\s]/.test(path) || path.split(/[/?]/).includes(".."))
      throw new Error("GitHub path must remain inside the factory repository");
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com" || !url.pathname.startsWith(`${ROOT}/`))
      throw new Error("Invalid GitHub repository path");
    if (
      pollCache &&
      (method !== "GET" ||
        body !== undefined ||
        !/^\/actions\/runs\/[1-9]\d*$/.test(path.slice(ROOT.length)))
    )
      throw Error("Conditional reads are only supported for polling an Actions run");
    const cached =
      pollCache?.path === path && pollCache.etag
        ? { etag: pollCache.etag, value: pollCache.value }
        : null;
    const options = {
      method,
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "haide-software-factory",
        ...(cached ? { "If-None-Match": cached.etag } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const retryable = this.retryReads === true && method === "GET" && body === undefined;
    let gatewayAttempts = 0;
    for (;;) {
      const response = await this.fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
      this.primaryQuota = primaryQuota(response.headers);
      if (
        retryable &&
        gatewayAttempts < READ_BACKOFF_MS.length &&
        (TRANSIENT_GATEWAY.has(response.status) ||
          (this.retryInternalReads && response.status === 500))
      ) {
        await response.body?.cancel().catch(() => {});
        await this.sleep(READ_BACKOFF_MS[gatewayAttempts++]);
        continue;
      }
      if (response.status === 304 && cached) return cached.value;
      if (!response.ok) {
        const error = new Error(`GitHub request failed (${response.status})`);
        error.status = response.status;
        error.method = method;
        if (this.waitOnQuota || method === "GET") {
          error.quotaResetAt = await quotaResetAt(response, this.now());
          if (
            this.waitOnQuota &&
            quotaSafeRequest(method, path) &&
            (await this.waitForQuota(error))
          )
            continue;
        }
        throw error;
      }
      const value = response.status === 204 ? null : await response.json();
      if (pollCache) Object.assign(pollCache, { path, etag: response.headers.get("etag"), value });
      return value;
    }
  }
  async pages(path, key) {
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const data = await this.request(
        "GET",
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`
      );
      const rows = key ? data[key] : data;
      if (!Array.isArray(rows)) throw new Error("Invalid GitHub collection");
      all.push(...rows);
      if (rows.length < 100) return all;
    }
    throw new Error("GitHub collection exceeds safe pagination limit");
  }
}
const LEDGER_LIMIT_BYTES = 1_000_000;
const LEDGER_WARNING_BYTES = 800_000;

class Ledger {
  constructor(api) {
    this.api = api;
  }
  async read() {
    const ref = await this.api.request("GET", `${ROOT}/git/ref/heads/factory/state`);
    const commit = ref.object?.sha;
    if (!/^[a-f0-9]{40}$/.test(commit || "")) throw new Error("Invalid ledger commit");
    const file = await this.api.request("GET", `${ROOT}/contents/state.json?ref=${commit}`);
    if (
      file.type !== "file" ||
      file.encoding !== "base64" ||
      typeof file.content !== "string" ||
      file.content.length > 1500000
    )
      throw new Error("Invalid ledger file");
    let state;
    try {
      state = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    } catch {
      throw new Error("Invalid ledger JSON");
    }
    return { state: validateState(state), commit };
  }
  async commit(state, parent) {
    validateState(state);
    const content = JSON.stringify(state) + "\n";
    const size = Buffer.byteLength(content);
    if (size > LEDGER_LIMIT_BYTES)
      throw new Error("Ledger exceeds safe size; owner maintenance required");
    if (size >= LEDGER_WARNING_BYTES)
      console.warn(`Factory ledger nearing capacity (${size} of ${LEDGER_LIMIT_BYTES} bytes).`);
    const blob = await this.api.request("POST", `${ROOT}/git/blobs`, {
      content: Buffer.from(content).toString("base64"),
      encoding: "base64",
    });
    const tree = await this.api.request("POST", `${ROOT}/git/trees`, {
      tree: [{ path: "state.json", mode: "100644", type: "blob", sha: blob.sha }],
    });
    const commit = await this.api.request("POST", `${ROOT}/git/commits`, {
      message: "Record factory reservation and audit state",
      tree: tree.sha,
      parents: parent ? [parent] : [],
    });
    return commit.sha;
  }
  async initialize() {
    try {
      await this.api.request("GET", `${ROOT}/git/ref/heads/factory/state`);
      throw new Error("Factory ledger already initialized");
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    const sha = await this.commit(emptyState(REPOSITORY), null);
    await this.api.request("POST", `${ROOT}/git/refs`, { ref: "refs/heads/factory/state", sha });
    return this.read();
  }
  async update(mutator, { expectedCommit } = {}) {
    if (expectedCommit !== undefined && !/^[a-f0-9]{40}$/.test(expectedCommit))
      throw new Error("Invalid expected ledger commit");
    for (let attempt = 0; attempt < 3; attempt++) {
      const { state, commit } = await this.read();
      if (expectedCommit !== undefined && commit !== expectedCommit)
        throw new Error("Expected ledger commit changed; preview again");
      const result = await mutator(state);
      if (!result?.state) throw new Error("Ledger mutation must return state");
      const next = await this.commit(result.state, commit);
      try {
        const saved = await this.api.request("PATCH", `${ROOT}/git/refs/heads/factory/state`, {
          sha: next,
          force: false,
        });
        if (saved.object?.sha !== next) throw new Error("Ledger write was not acknowledged");
        return { ...result, commit: next };
      } catch (error) {
        if (expectedCommit !== undefined) throw error;
        if (![409, 422].includes(error.status) || attempt === 2) throw error;
      }
    }
    throw new Error("Ledger contention");
  }
}
module.exports = { GitHub, Ledger, ROOT };
