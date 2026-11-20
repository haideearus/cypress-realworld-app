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
  "/bankAccounts/:other",
  "/transactions/:private",
];
const KINDS = [
  "unexpected-server-error",
  "protected-route",
  "feed-pagination",
  "notification-list",
  "account-isolation",
  "bank-account-isolation",
  "private-transaction-isolation",
];
const PRIVACY = {
  "bank-account-isolation": {
    route: "/bankAccounts/:other",
    key: "account",
    fields: ["id", "userId", "bankName", "accountNumber", "routingNumber", "isDeleted"],
    symptom: "other-bank-account-access",
  },
  "private-transaction-isolation": {
    route: "/transactions/:private",
    key: "transaction",
    fields: ["id", "senderId", "receiverId", "privacyLevel", "amount", "description"],
    symptom: "private-transaction-access",
  },
};
// A denial status alone is not proof: arbitrary/renamed payloads can still leak
// a record. Unknown error shapes deliberately hold until separately supported.
const DENIALS = ["Unauthorized", "Forbidden", "Not Found", "denied"];
const NOTIFICATION_CHECKS = Object.freeze(["envelope", "unread", "items"]);
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
    Object.keys(o.query).some(
      (k) => !(o.kind === "notification-list" ? ["check"] : ["page", "limit", "q"]).includes(k)
    )
  )
    throw Error("Unsupported discovery oracle");
  for (const [key, value] of Object.entries(o.query))
    if (
      key === "check"
        ? !NOTIFICATION_CHECKS.includes(value)
        : key === "q"
          ? typeof value !== "string" || value.length > 100
          : !Number.isSafeInteger(value) || value < -1 || value > 100000
    )
      throw Error("Unsupported discovery oracle input");
  if (
    (o.kind === "protected-route" &&
      (o.authenticated ||
        !["/users", "/transactions", "/bankAccounts", "/notifications"].includes(o.route))) ||
    (o.kind === "feed-pagination" && (!o.authenticated || o.route !== "/transactions/public")) ||
    (o.kind === "notification-list" &&
      (!o.authenticated || o.route !== "/notifications" || !Object.hasOwn(o.query, "check"))) ||
    (o.kind === "account-isolation" && (!o.authenticated || o.route !== "/users/:other")) ||
    (o.route === "/users/:other" && o.kind !== "account-isolation") ||
    (PRIVACY[o.kind] &&
      (!o.authenticated || o.route !== PRIVACY[o.kind].route || Object.keys(o.query).length)) ||
    (["/bankAccounts/:other", "/transactions/:private"].includes(o.route) &&
      PRIVACY[o.kind]?.route !== o.route)
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
function projectNotifications(body, seed) {
  const expected = seed.notifications?.filter(
    (row) => row.userId === seed.users[0].id && row.isRead === false
  );
  if (!expected?.length || expected.some(({ id }) => typeof id !== "string" || !id))
    throw Error("Unread synthetic notification fixture missing");
  const expectedIds = new Set(expected.map(({ id }) => id));
  if (expectedIds.size !== expected.length)
    throw Error("Unread synthetic notification fixture IDs must be distinct");
  const hasList = Array.isArray(body?.results);
  const rows = hasList ? body.results : [];
  const hasItems = rows.length > 0;
  const ids = new Set();
  const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
  const validItems =
    hasItems &&
    rows.every((row) => {
      if (
        !nonempty(row?.id) ||
        ids.has(row.id) ||
        !nonempty(row.transactionId) ||
        !nonempty(row.userFullName)
      )
        return false;
      ids.add(row.id);
      const variants = [nonempty(row.likeId), nonempty(row.commentId)];
      return (
        variants.filter(Boolean).length +
          Number(["requested", "received", "incomplete"].includes(row.status)) ===
        1
      );
    });
  const matchesUnread =
    rows.length === expectedIds.size &&
    new Set(rows.map((row) => row?.id)).size === expectedIds.size &&
    rows.every((row) => row?.isRead === false && expectedIds.has(row.id));
  return { hasList, hasItems, matchesUnread, validItems };
}
function notificationSymptom(check, status, projected) {
  if (
    !projected ||
    Object.keys(projected).sort().join(",") !== "hasItems,hasList,matchesUnread,validItems" ||
    !Object.values(projected).every((value) => typeof value === "boolean") ||
    (projected.hasItems && !projected.hasList) ||
    ((projected.matchesUnread || projected.validItems) && !projected.hasItems)
  )
    throw Error("Invalid synthetic notification observation");
  if (status >= 500 && status <= 599) return "server-error";
  if (status !== 200) return "none";
  if (!projected.hasList) return "notifications-envelope";
  if (check === "unread" && !projected.matchesUnread) return "notifications-unread";
  if (check === "items" && !projected.hasItems) return "notifications-unread";
  if (check === "items" && !projected.validItems) return "notifications-items";
  return "none";
}
function observe(o, status, body) {
  validateOracle(o);
  let symptom = "none";
  if (o.kind === "notification-list") symptom = notificationSymptom(o.query.check, status, body);
  if (o.kind === "unexpected-server-error" && status >= 500 && status <= 599)
    symptom = "server-error";
  if (o.kind === "protected-route" && status >= 200 && status < 300)
    symptom = "unauthenticated-access";
  if (o.kind === "account-isolation" && status === 200) symptom = "other-account-access";
  if (PRIVACY[o.kind]) {
    privacyContext(o, body);
    if (status === 200 && sameRecord(body.expected, body.result.resource))
      symptom = PRIVACY[o.kind].symptom;
  }
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
function sameRecord(expected, actual) {
  return Boolean(actual && Object.keys(expected).every((key) => actual[key] === expected[key]));
}
function project(o, body) {
  const contract = PRIVACY[o.kind];
  const value = body?.[contract.key];
  return {
    present: value !== undefined && value !== null,
    denial:
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body).join(",") === "error" &&
      DENIALS.includes(body.error)
        ? body.error
        : null,
    resource:
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            contract.fields.map((key) => [
              key,
              (typeof value[key] === "string" && value[key].length <= 1000) ||
              typeof value[key] === "boolean" ||
              Number.isSafeInteger(value[key])
                ? value[key]
                : null,
            ])
          )
        : null,
  };
}
function privacyContext(o, body) {
  const contract = PRIVACY[o.kind];
  const expected = body?.expected;
  const id = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(x);
  if (
    !expected ||
    Object.keys(expected).sort().join(",") !== [...contract.fields].sort().join(",") ||
    !contract.fields.every((key) => {
      if (key === "isDeleted") return expected[key] === false;
      if (key === "amount") return Number.isSafeInteger(expected[key]) && expected[key] >= 0;
      if (["bankName", "accountNumber", "routingNumber", "description"].includes(key))
        return (
          typeof expected[key] === "string" &&
          expected[key].length > 0 &&
          expected[key].length <= 1000
        );
      return id(expected[key]);
    }) ||
    !id(body.readerId) ||
    !body.result ||
    typeof body.result.present !== "boolean" ||
    (body.result.denial !== null && !DENIALS.includes(body.result.denial)) ||
    (!body.result.present && body.result.resource !== null)
  )
    throw Error("Invalid privacy fixture observation");
  const owners =
    contract.key === "account" ? [expected.userId] : [expected.senderId, expected.receiverId];
  if (
    new Set(owners).size !== owners.length ||
    owners.includes(body.readerId) ||
    (contract.key === "transaction" && expected.privacyLevel !== "private") ||
    !Array.isArray(body.controls) ||
    body.controls.length !== owners.length ||
    body.controls.some(
      (control, index) =>
        control.userId !== owners[index] ||
        control.status !== 200 ||
        !sameRecord(expected, control.resource)
    )
  )
    throw Error("Privacy owner control failed");
  return body;
}
function privacyHealthy(o, status, body) {
  privacyContext(o, body);
  return (
    [401, 403, 404].includes(status) &&
    body.result.present === false &&
    DENIALS.includes(body.result.denial)
  );
}
function privacyFixture(o, seed) {
  const contract = PRIVACY[o.kind];
  const users = seed?.users;
  if (!Array.isArray(users)) throw Error("Synthetic privacy fixture missing");
  const resource = (contract.key === "account" ? seed.bankaccounts : seed.transactions)?.find(
    (r) => (contract.key === "account" ? r.isDeleted === false : r.privacyLevel === "private")
  );
  if (!resource) throw Error("Synthetic privacy fixture missing");
  const expected = Object.fromEntries(contract.fields.map((key) => [key, resource[key]]));
  const ownerIds =
    contract.key === "account" ? [resource.userId] : [resource.senderId, resource.receiverId];
  const owners = ownerIds.map((id) => users.find((u) => u.id === id));
  const reader = users.find((u) => !ownerIds.includes(u.id));
  if (owners.some((u) => !u) || !reader)
    throw Error("Synthetic privacy fixture identities missing");
  // Validate fixture identity and privacy before performing any network request.
  privacyContext(o, {
    expected,
    readerId: reader.id,
    controls: ownerIds.map((userId) => ({ userId, status: 200, resource: expected })),
    result: { present: false, resource: null, denial: null },
  });
  return { expected, owners, reader };
}
async function privacyProbe(o, request, seed) {
  const base = "http://app:3001";
  const fixture = privacyFixture(o, seed);
  const sessions = new Set();
  const read = async (route, init = {}) => {
    const response = await request(base + route, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    if (text.length > 100000) throw Error("Privacy control response too large");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = DENIALS.includes(text.trim()) ? { error: text.trim() } : null;
    }
    return { response, body };
  };
  const checkIdentity = async (user, cookie) => {
    const checked = await read("/checkAuth", { headers: { cookie } });
    if (checked.response.status !== 200 || checked.body?.user?.id !== user.id)
      throw Error("Synthetic privacy session identity failed");
  };
  const login = async (user) => {
    const { response, body } = await read("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: user.username, password: "discovery-only-password" }),
    });
    if (response.status !== 200 || body?.user?.id !== user.id)
      throw Error("Synthetic privacy authentication identity setup failed");
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw Error("Synthetic privacy session missing");
    if (sessions.has(cookie)) throw Error("Synthetic privacy sessions are not distinct");
    sessions.add(cookie);
    await checkIdentity(user, cookie);
    return cookie;
  };
  const route =
    (PRIVACY[o.kind].key === "account" ? "/bankAccounts/" : "/transactions/") +
    encodeURIComponent(fixture.expected.id);
  const controls = [];
  for (const owner of fixture.owners) {
    const cookie = await login(owner);
    const result = await read(route, { headers: { cookie } });
    await checkIdentity(owner, cookie);
    controls.push({
      userId: owner.id,
      status: result.response.status,
      resource: project(o, result.body).resource,
    });
  }
  const cookie = await login(fixture.reader);
  const result = await read(route, { headers: { cookie } });
  await checkIdentity(fixture.reader, cookie);
  return observe(o, result.response.status, {
    expected: fixture.expected,
    readerId: fixture.reader.id,
    controls,
    result: project(o, result.body),
  });
}
async function probe(o, { request = fetch, seed: fixture } = {}) {
  validateOracle(o);
  const base = "http://app:3001";
  let cookie = "";
  const seed = fixture || require("/source/data/database-seed.json");
  if (PRIVACY[o.kind]) return privacyProbe(o, request, seed);
  if (o.authenticated) {
    const r = await request(base + "/login", {
      method: "POST",
      ...(o.kind === "notification-list" ? { redirect: "manual" } : {}),
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
    if (o.kind === "notification-list") {
      const expectedUser = seed.users[0].id;
      const loginText = await r.text();
      let login;
      if (loginText.length <= 100000) {
        try {
          login = JSON.parse(loginText);
        } catch {}
      }
      if (typeof expectedUser !== "string" || !expectedUser || login?.user?.id !== expectedUser)
        throw Error("Synthetic notification session identity failed");
    }
  }
  let route =
    o.route === "/users/:other" ? "/users/" + encodeURIComponent(seed.users[1].id) : o.route;
  const url = new URL(base + route);
  if (o.kind !== "notification-list")
    for (const [key, value] of Object.entries(o.query)) url.searchParams.set(key, String(value));
  const r = await request(url, {
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
  if (o.kind === "notification-list") body = projectNotifications(body, seed);
  return observe(o, r.status, body);
}
module.exports = { KINDS, validateOracle, oracleHash, observe, probe, privacyHealthy };
