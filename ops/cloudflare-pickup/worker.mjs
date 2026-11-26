const API =
  "https://api.github.com/repos/haideearus/cypress-realworld-app/actions/workflows/factory-automatic.yml/dispatches";
const WINDOW_MS = 10 * 60 * 1000;
const OFFSET_MS = 3 * 60 * 1000;

export async function dispatchPickup(tick, env, request = fetch) {
  if (!Number.isSafeInteger(tick) || tick < 0 || (tick - OFFSET_MS) % WINDOW_MS !== 0)
    throw new Error("Pickup timer received an invalid schedule time");
  if (!env.GITHUB_DISPATCH_TOKEN) throw new Error("GITHUB_DISPATCH_TOKEN is missing");

  let response;
  try {
    response = await request(API, {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "haide-factory-pickup-timer",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { operation: "run", dry_run: false, timer_tick: String(tick) },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("GitHub pickup request outcome unknown; wait for the next tick");
  }
  if (![200, 204].includes(response.status))
    throw new Error(`GitHub rejected pickup request (HTTP ${response.status})`);
  return { outcome: "requested", tick: new Date(tick).toISOString(), status: response.status };
}

export default {
  async scheduled(controller, env) {
    controller.noRetry?.();
    console.log(JSON.stringify(await dispatchPickup(controller.scheduledTime, env)));
  },
};
