const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
  journeySchema,
  renderJourney,
  validateJourney,
  verifyJourney,
} = require("../factory/discovery-browser.cjs");

const settings = {
  pages: ["feed", "notifications", "settings"],
  check: "settings-validation",
  variant: "invalid-email",
};

test("browser journey renders a reproducible Cypress spec with approved navigation and a fixed check", () => {
  const source = renderJourney(settings);
  assert.equal(source, renderJourney({ variant: settings.variant, ...settings }));
  assert.deepEqual(verifyJourney(source), settings);
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /\/\/ Factory browser journey /);
  assert.match(source, /sidenav-notifications/);
  assert.match(source, /sidenav-user-settings/);
  assert.match(source, /Must contain a valid email address/);
  assert.match(source, /password/);
});

test("browser discovery supports different routes and checks with finite synthetic variants", () => {
  const cases = [
    ["feed", "feed-tabs", ["everyone", "friends", "mine"], /nav-personal-tab/],
    [
      "settings",
      "settings-validation",
      ["invalid-email", "required-email", "required-first-name"],
      /user-settings-form/,
    ],
    ["notifications", "notification-list", ["populated", "empty"], /No Notifications/],
    [
      "transaction",
      "transaction-validation",
      ["missing-amount", "missing-note", "valid-draft", "synthetic-request", "synthetic-payment"],
      /transaction-create-submit/,
    ],
    [
      "bank-accounts",
      "bank-account-list",
      ["visible", "reload"],
      /bankaccount-list-item-pgl34JtnfhX/,
    ],
  ];
  for (const [page, check, variants, expected] of cases) {
    const sources = variants.map((variant) => {
      const journey = { pages: [page], check, variant };
      const source = renderJourney(journey);
      assert.deepEqual(verifyJourney(source), journey);
      assert.match(source, expected);
      return source;
    });
    assert.equal(new Set(sources).size, variants.length);
    assert.deepEqual(validateJourney({ pages: [page], check }), {
      pages: [page],
      check,
      variant: variants[0],
    });
  }
  assert.deepEqual(journeySchema.required, ["pages", "check"]);
  assert.equal(journeySchema.additionalProperties, false);
  assert.match(
    renderJourney({ pages: ["feed", "settings", "feed"], check: "feed-tabs" }),
    /sidenav-home/
  );
});

test("only the synthetic transaction variants include the fixed local write and receipt checks", () => {
  const draft = { pages: ["bank-accounts", "transaction"], check: "transaction-validation" };
  for (const type of ["request", "payment"]) {
    const journey = { ...draft, variant: "synthetic-" + type };
    const source = renderJourney(journey);
    assert.deepEqual(verifyJourney(source), journey);
    assert.match(source, /function submitSyntheticTransaction/);
    assert.match(source, new RegExp('"transactionType":"' + type + '"'));
    assert.match(source, /http:\/\/localhost:3001/);
    assert.match(source, /synthetic-transaction-receipt/);
    assert.match(source, /synthetic-transaction-saved/);
    assert.throws(() => verifyJourney(source.replace("localhost:3001", "example.org")));
  }
  assert.doesNotMatch(
    renderJourney({ ...draft, variant: "valid-draft" }),
    /function submitSyntheticTransaction/
  );
  assert.throws(() => renderJourney({ ...draft, variant: "synthetic-payment", amount: 2 }));
});

test("transaction write guard admits only one exact loopback submission", () => {
  const source = renderJourney({
    pages: ["transaction"],
    check: "transaction-validation",
    variant: "synthetic-payment",
  });
  const chain = {};
  for (const method of ["as", "blur", "click", "find", "should", "then", "type"])
    chain[method] = () => chain;
  let filter;
  vm.runInNewContext(source, {
    Cypress: {
      config: () => "http://localhost:3000",
      _: {
        isEqual: (a, b) =>
          JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort()),
      },
    },
    cy: {
      contains: () => chain,
      get: () => chain,
      intercept: (_matcher, handler) => {
        filter = handler;
        return chain;
      },
      location: () => chain,
      viewport: () => {},
      visit: () => {},
      wait: () => chain,
    },
    describe: (_name, run) => run(),
    expect: (actual) => ({ to: { equal: (expected) => assert.equal(actual, expected) } }),
    it: (_name, run) => run(),
  });
  const url = "http://localhost:3001/transactions";
  const body = {
    amount: "1",
    description: "Discovery fixture",
    senderId: "uBmeaz5pX",
    receiverId: "GjWovtg2hr",
    transactionType: "payment",
  };
  const calls = [];
  const intercept = (request) =>
    filter({
      url,
      body,
      ...request,
      continue: () => calls.push("forwarded"),
      destroy: () => calls.push("blocked"),
    });
  intercept({ url: "https://example.org/transactions" });
  intercept({ body: { ...body, amount: "5" } });
  intercept({ body: { ...body, receiverId: "other" } });
  intercept({ body: { ...body, transactionType: "request" } });
  intercept({});
  intercept({});
  assert.deepEqual(calls, ["blocked", "blocked", "blocked", "blocked", "forwarded", "blocked"]);
});

test("browser journeys reject unknown routes, arbitrary inputs, mismatched assertions and forged source", () => {
  for (const input of [
    {},
    { ...settings, pages: [] },
    { ...settings, pages: ["feed", "settings", "feed", "settings"] },
    { ...settings, pages: ["feed", "settings", "settings"] },
    { ...settings, pages: [...Array(1), "settings"] },
    { ...settings, pages: ["https://example.org", "settings"] },
    { ...settings, pages: ["constructor", "settings"] },
    { ...settings, pages: ["feed"] },
    { ...settings, check: "constructor" },
    { ...settings, check: "notification-list" },
    { ...settings, variant: undefined },
    { ...settings, variant: "})(); cy.request('example.org');" },
    { ...settings, selector: "body" },
  ]) {
    assert.throws(() => renderJourney(input), /browser journey/i);
  }
  const source = renderJourney(settings);
  assert.throws(() => verifyJourney(source.replace("invalid-email", "required-email")));
  assert.throws(() => verifyJourney(source + "\ncy.visit('https://example.org');\n"));
  assert.throws(() => verifyJourney("describe('untrusted', () => {});"));
});
