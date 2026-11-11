const { defineConfig } = require("cypress");
module.exports = defineConfig({
  video: false,
  retries: 0,
  e2e: {
    baseUrl: "https://127.0.0.1:8444",
    specPattern: "scripts/tests/neon-browser.cy.js",
    supportFile: false,
  },
});
