import { Pool } from "pg";
import { DbSchema } from "../src/models/db-schema";

type StateAccess = { read: () => DbSchema; replace: (state: DbSchema) => void };

// One serialized snapshot preserves the upstream synchronous lowdb operations.
// Row locking also protects writes during overlapping process deployments.
export class PostgresState {
  private tail: Promise<void> = Promise.resolve();
  private revision: string | undefined;

  constructor(
    private pool: Pool,
    private state: StateAccess
  ) {}

  async initialize(seed: DbSchema) {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS rwa_state (
      id integer PRIMARY KEY CHECK (id = 1),
      revision bigint NOT NULL DEFAULT 0,
      payload jsonb NOT NULL
    )`);
    await this.pool.query(
      "INSERT INTO rwa_state (id, payload) VALUES (1, $1) ON CONFLICT (id) DO NOTHING",
      [JSON.stringify(seed)]
    );
  }

  async begin() {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let client;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '15s'");
      const { rows } = await client.query("SELECT revision FROM rwa_state WHERE id = 1 FOR UPDATE");
      if (!rows.length) throw new Error("Missing application state");
      const revision = String(rows[0].revision);
      if (this.revision !== revision) {
        const snapshot = await client.query("SELECT payload FROM rwa_state WHERE id = 1");
        this.state.replace(snapshot.rows[0].payload);
        this.revision = revision;
      }
      const before = JSON.stringify(this.state.read());
      const connection = client;
      let completed = false;
      const finish = async (commit: boolean) => {
        if (completed) return;
        completed = true;
        try {
          if (commit) {
            const after = JSON.stringify(this.state.read());
            if (before !== after) {
              const updated = await connection.query(
                "UPDATE rwa_state SET payload = $1, revision = revision + 1 WHERE id = 1 RETURNING revision",
                [after]
              );
              this.revision = String(updated.rows[0].revision);
            }
            await connection.query("COMMIT");
          } else {
            await connection.query("ROLLBACK");
            this.state.replace(JSON.parse(before));
          }
        } catch (error) {
          this.revision = undefined;
          this.state.replace(JSON.parse(before));
          await connection.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          connection.release();
          release();
        }
      };
      return { commit: () => finish(true), rollback: () => finish(false) };
    } catch (error) {
      this.revision = undefined;
      if (client) {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
      release();
      throw error;
    }
  }
}
