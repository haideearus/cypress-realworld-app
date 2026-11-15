const LIMITS = Object.freeze({
  request: 10000,
  retryDelay: 30000,
  retryGuard: 1000,
  attempts: 3,
  scanner: 30000,
  publication: 60000,
  availability: 152000,
  job: 480000,
});
function phaseBudgets() {
  const journey =
    LIMITS.attempts * 5 * LIMITS.request +
    (LIMITS.attempts - 1) * (LIMITS.retryDelay + LIMITS.retryGuard);
  return {
    journey,
    availability: LIMITS.availability,
    scanner: LIMITS.scanner,
    publication: LIMITS.publication,
    setup: LIMITS.job - journey - LIMITS.availability - LIMITS.scanner - LIMITS.publication,
  };
}
function publisherFetch(transport = globalThis.fetch, clock = () => performance.now()) {
  let started;
  return async (url, options) => {
    started ??= clock();
    const remaining = LIMITS.publication - (clock() - started);
    if (remaining < 1) throw Error("App-check publication deadline reached");
    return transport(url, {
      ...options,
      signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(30000, remaining)))),
    });
  };
}
module.exports = { LIMITS, phaseBudgets, publisherFetch };
