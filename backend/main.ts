import "./environment";
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { createApp } from "./app";
import { readConfig } from "./config";
import { stateAccess } from "./database";
import { PostgresState } from "./postgres-state";

async function main() {
  const config = readConfig();
  const pool = config.production
    ? new Pool({
        connectionString: config.databaseUrl,
        max: 3,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 15000,
      })
    : undefined;
  pool?.on("error", () => console.error("Database connection interrupted"));
  let persistence;
  if (pool) {
    const state = new PostgresState(pool, stateAccess);
    await state.initialize(
      JSON.parse(readFileSync(join(__dirname, "../data/database-seed.json"), "utf8"))
    );
    persistence = { pool, state };
  }
  const server = createApp(config, persistence).listen(config.port, config.host, () => {
    console.log(
      `Application listening on port ${config.port} (${config.production ? "production" : "development"})`
    );
  });
  server.on("error", () => {
    console.error("Server failed to start");
    process.exit(1);
  });
  const shutdown = () => {
    server.close(() => {
      void (pool?.end() || Promise.resolve()).then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 20000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void main().catch(() => {
  console.error("Application startup failed; check server configuration and database availability");
  process.exit(1);
});
