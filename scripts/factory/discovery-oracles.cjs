// Trusted catalog: generated assertions and model prose are never an oracle.
const { createHash } = require("node:crypto");
const ROUTES = [
  "/users",
  "/users/search",
  "/transactions",
  "/transactions/public",
  "/bankAccounts",
  "/notifications",
  "/users/:other",
];
const KINDS = [
  "unexpected-server-error",
  "protected-route",
  "feed-pagination",
  "account-isolation",
];
const hash = (s) => createHash("sha256").update(s).digest("hex");
function validateOracle(o) {
  if (
    !o ||
    Object.keys(o).sort().join(",") !== "authenticated,kind,query,route" ||
    !KINDS.includes(o.kind) ||
    !ROUTES.includes(o.route) ||
    typeof o.authenticated !== "boolean" ||
    !o.query ||
    typeof o.query !== "object" ||
    Array.isArray(o.query) ||
    Object.keys(o.query).some((k) => !["page", "limit", "q"].includes(k))
  )
    throw Error("Unsupported discovery oracle");
  for (const [key, value] of Object.entries(o.query))
    if (
      key === "q"
        ? typeof value !== "string" || value.length > 100
        : !Number.isSafeInteger(value) || value < -1 || value > 100000
    )
      throw Error("Unsupported discovery oracle input");
  if (
    (o.kind === "protected-route" &&
      (o.authenticated ||
        !["/users", "/transactions", "/bankAccounts", "/notifications"].includes(o.route))) ||
    (o.kind === "feed-pagination" && (!o.authenticated || o.route !== "/transactions/public")) ||
    (o.kind === "account-isolation" && (!o.authenticated || o.route !== "/users/:other")) ||
    (o.route === "/users/:other" && o.kind !== "account-isolation")
  )
    throw Error("Unsupported discovery oracle contract");
  return o;
}
function oracleHash(o) {
  validateOracle(o);
  return hash(
    JSON.stringify([
      o.kind,
      o.route,
      o.authenticated,
      Object.entries(o.query).sort(([a], [b]) => a.localeCompare(b)),
    ])
  );
}
function observe(o, status, body) {
  validateOracle(o);
  let symptom = "none";
  if (o.kind === "unexpected-server-error" && status >= 500 && status <= 599)
    symptom = "server-error";
  if (o.kind === "protected-route" && status >= 200 && status < 300)
    symptom = "unauthenticated-access";
  if (o.kind === "account-isolation" && status === 200) symptom = "other-account-access";
  if (o.kind === "feed-pagination" && status === 200) {
    const d = body?.pageData;
    if (
      !d ||
      !Array.isArray(body.results) ||
      !Number.isInteger(d.page) ||
      d.page < 1 ||
      !Number.isInteger(d.totalPages) ||
      d.totalPages < 0 ||
      typeof d.hasNextPages !== "boolean" ||
      d.hasNextPages !== d.page < d.totalPages ||
      (d.page > d.totalPages && body.results.length > 0)
    )
      symptom = "feed-contract";
  }
  return {
    version: 1,
    kind: o.kind,
    status,
    symptom,
    signature: `${o.route}:${status}:${symptom}`,
    inputHash: oracleHash(o),
    response: JSON.stringify(body).slice(0, 20000),
  };
}
async function probe(o) {
  validateOracle(o);
  const base = "http://app:3001";
  let cookie = "";
  const seed = require("/source/data/database-seed.json");
  if (o.authenticated) {
    const r = await fetch(base + "/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: seed.users[0].username,
        password: "discovery-only-password",
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.status !== 200) throw Error("Sandbox authentication setup failed");
    cookie = r.headers.get("set-cookie")?.split(";")[0] || "";
    if (!cookie) throw Error("Synthetic session missing");
  }
  let route =
    o.route === "/users/:other" ? "/users/" + encodeURIComponent(seed.users[1].id) : o.route;
  const url = new URL(base + route);
  for (const [key, value] of Object.entries(o.query)) url.searchParams.set(key, String(value));
  const r = await fetch(url, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });
  const text = await r.text();
  if (text.length > 100000) throw Error("Oracle response too large");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { text: text.slice(0, 20000) };
  }
  return observe(o, r.status, body);
}
module.exports = { KINDS, validateOracle, oracleHash, observe, probe };
