const { GitHub } = require("./github.cjs");

const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 20000;
const safeErrors = new WeakSet();

function requestError(status, rateLimited = false) {
  const error = new Error("GitHub recovery request failed");
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  if (rateLimited) error.rateLimited = true;
  safeErrors.add(error);
  return error;
}

async function isRateLimited(response) {
  if (![403, 429].includes(response.status)) return false;
  if (
    response.headers.get("retry-after")?.trim() ||
    response.headers.get("x-ratelimit-remaining")?.trim() === "0"
  )
    return true;
  try {
    const body = await response.clone().json();
    return (
      typeof body?.message === "string" &&
      /API rate limit exceeded|secondary rate limit/i.test(body.message)
    );
  } catch {
    return false;
  }
}

function retryDelay(response, now, attempt) {
  const delays = [];
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : NaN;
    const delay = Number.isNaN(seconds) ? Date.parse(retryAfter) - now : seconds * 1000;
    if (!Number.isNaN(delay)) delays.push(Math.max(0, Math.ceil(delay)));
  }
  const reset = response.headers.get("x-ratelimit-reset")?.trim();
  if (reset && /^\d+(?:\.\d+)?$/.test(reset)) {
    const delay = Number(reset) * 1000 - now;
    if (!Number.isNaN(delay)) delays.push(Math.max(0, Math.ceil(delay)));
  }
  // Honor both server hints; a distant reset must never be shortened to fit the budget.
  return delays.length ? Math.max(...delays) : attempt * 1000;
}

class RecoveryGitHub extends GitHub {
  constructor({
    token,
    fetch: transport = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  }) {
    super({
      token,
      fetch: async (url, options) => {
        let waited = 0;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const response = await transport(url, options);
          if (response.ok) return response;
          // The archive reader must inspect and validate a signed redirect itself.
          // It strips API credentials and rejects redirect chains before following it.
          if (
            options.method === "GET" &&
            options.redirect === "manual" &&
            [301, 302, 303, 307, 308].includes(response.status)
          )
            return response;
          const limited = await isRateLimited(response);
          const error = requestError(response.status, limited);
          if (!limited || options.method !== "GET" || attempt === MAX_ATTEMPTS) throw error;
          const delay = retryDelay(response, now(), attempt);
          if (delay > MAX_WAIT_MS - waited) throw error;
          await sleep(delay);
          waited += delay;
        }
      },
    });
  }

  async request(method, path, body) {
    try {
      return await super.request(method, path, body);
    } catch (error) {
      // Transport and JSON-parser errors may include credentials or response text.
      // Only errors constructed here may leave this opt-in client unchanged.
      if (safeErrors.has(error)) throw error;
      throw requestError();
    }
  }
}

module.exports = { RecoveryGitHub };
