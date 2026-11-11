const { defineConfig } = require("cypress");

module.exports = defineConfig({
  video: false,
  retries: 0,
  e2e: {
    baseUrl: "https://127.0.0.1:8443",
    specPattern: "scripts/tests/production-browser.cy.js",
    supportFile: false,
  },
});
