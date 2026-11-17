// Shared runtime configuration for trusted entrypoint and image smoke tests.
function environment(release) {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/work",
    COREPACK_HOME: "/opt/corepack",
    NODE_ENV: "test",
    HOST: "0.0.0.0",
    PORT: "3000",
    VITE_BACKEND_PORT: "3001",
    BACKEND_PORT: "3001",
    CI: "true",
    CYPRESS_CACHE_FOLDER: "/opt/cypress",
    CYPRESS_CRASH_REPORTS: "0",
    CYPRESS_RECORD_KEY: "",
    DEBUG: "cypress:cli",
    RENDER_GIT_COMMIT: release,
  };
}
function cypressConfig() {
  return {
    video: false,
    retries: 0,
    screenshotsFolder: "/work/screenshots",
    e2e: {
      baseUrl: "http://localhost:3000",
      specPattern: "discovery-tests/*.cy.ts",
      supportFile: false,
    },
    env: { apiUrl: "http://localhost:3001" },
  };
}
function vitestConfig() {
  return {
    cacheDir: "/work/vitest-cache",
    test: {
      environment: "jsdom",
      setupFiles: ["./src/setup-tests.js"],
      include: ["discovery-tests/*.unit.test.{ts,tsx}"],
      fileParallelism: false,
    },
  };
}
module.exports = { environment, cypressConfig, vitestConfig };
