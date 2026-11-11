const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { Pool } = require("pg");
const { PostgresState } = require("../../dist/server/backend/postgres-state.js");

const uri = process.env.TEST_DATABASE_URL;
if (!uri || !new URL(uri).pathname.endsWith("_test"))
  throw new Error("Use a disposable database whose name ends with _test");
const pool = new Pool({ connectionString: uri, max: 4 });
const seed = {
  users: [],
  contacts: [],
  bankaccounts: [],
  transactions: [],
  likes: [],
  comments: [],
  notifications: [],
  banktransfers: [],
};
function store() {
  let data;
  return {
    store: new PostgresState(pool, {
      read: () => data,
      replace: (value) => {
        data = value;
      },
    }),
    read: () => data,
  };
}
before(async () => {
  await pool.query("DROP TABLE IF EXISTS rwa_state");
});
after(() => pool.end());

test("state is seeded once, persists across instances, and serializes concurrent updates", async () => {
  const a = store();
  const b = store();
  await a.store.initialize(seed);
  await b.store.initialize({ ...seed, users: [{ id: "should-not-reseed" }] });
  const update = async (item, id) => {
    const transaction = await item.store.begin();
    item.read().users.push({ id });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await transaction.commit();
  };
  await Promise.all([update(a, "first"), update(b, "second"), update(a, "third")]);
  const fresh = store();
  await fresh.store.initialize(seed);
  const transaction = await fresh.store.begin();
  assert.deepEqual(
    fresh
      .read()
      .users.map((u) => u.id)
      .sort(),
    ["first", "second", "third"]
  );
  await transaction.commit();
});

test("failed requests roll back memory and release the next request", async () => {
  const item = store();
  const transaction = await item.store.begin();
  const before = structuredClone(item.read());
  item.read().users.push({ id: "must-not-survive" });
  await transaction.rollback();
  const next = await item.store.begin();
  assert.deepEqual(item.read(), before);
  await next.commit();
});

test("a PostgreSQL update failure is rejected and does not poison cached state", async () => {
  const item = store();
  await pool.query(
    "ALTER TABLE rwa_state ADD CONSTRAINT reject_writes CHECK (revision < 0) NOT VALID"
  );
  const transaction = await item.store.begin();
  const before = structuredClone(item.read());
  item.read().users.push({ id: "invalid" });
  try {
    await assert.rejects(transaction.commit());
  } finally {
    await pool.query("ALTER TABLE rwa_state DROP CONSTRAINT reject_writes");
  }
  const next = await item.store.begin();
  assert.deepEqual(item.read(), before);
  await next.commit();
});
