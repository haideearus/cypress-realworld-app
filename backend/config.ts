export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === "production";
  const port = Number(production ? env.PORT || 10000 : env.VITE_BACKEND_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid server port");
  const sessionSecret = env.SESSION_SECRET || (production ? "" : "session secret");
  const databaseUrl = env.DATABASE_URL || "";
  const origin = env.APP_ORIGIN || env.RENDER_EXTERNAL_URL || "";
  if (production) {
    if (sessionSecret.length < 32) throw new Error("SESSION_SECRET needs at least 32 characters");
    let database: URL;
    let publicUrl: URL;
    try {
      database = new URL(databaseUrl);
      publicUrl = new URL(origin);
    } catch {
      throw new Error("DATABASE_URL and APP_ORIGIN must be valid URLs");
    }
    if (!["postgres:", "postgresql:"].includes(database.protocol)) {
      throw new Error("DATABASE_URL must use PostgreSQL");
    }
    if (publicUrl.protocol !== "https:" || publicUrl.origin !== origin) {
      throw new Error("APP_ORIGIN must be an HTTPS origin without a trailing slash");
    }
  }
  return {
    production,
    port,
    host: env.HOST || (production ? "0.0.0.0" : "127.0.0.1"),
    sessionSecret,
    databaseUrl,
    origin,
    release: env.RENDER_GIT_COMMIT || "local",
  };
}

export type AppConfig = ReturnType<typeof readConfig>;
