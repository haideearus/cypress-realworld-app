const PREFIX = "// Factory browser journey ";
const SYNTHETIC_TRANSACTIONS = {
  "synthetic-request": "request",
  "synthetic-payment": "payment",
};
const PAGES = {
  feed: { link: "sidenav-home", path: "/", landmark: "nav-transaction-tabs" },
  settings: {
    link: "sidenav-user-settings",
    path: "/user/settings",
    landmark: "user-settings-form",
  },
  notifications: { link: "sidenav-notifications", path: "/notifications" },
  transaction: {
    link: "nav-top-new-transaction",
    path: "/transaction/new",
    landmark: "user-list-search-input",
  },
  "bank-accounts": {
    link: "sidenav-bankaccounts",
    path: "/bankaccounts",
    landmark: "bankaccount-list",
  },
};
const CHECKS = {
  "feed-tabs": { page: "feed", variants: ["everyone", "friends", "mine"] },
  "settings-validation": {
    page: "settings",
    variants: ["invalid-email", "required-email", "required-first-name"],
  },
  "notification-list": { page: "notifications", variants: ["populated", "empty"] },
  "transaction-validation": {
    page: "transaction",
    variants: [
      "missing-amount",
      "missing-note",
      "valid-draft",
      ...Object.keys(SYNTHETIC_TRANSACTIONS),
    ],
  },
  "bank-account-list": { page: "bank-accounts", variants: ["visible", "reload"] },
};

const journeySchema = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: { type: "string", enum: Object.keys(PAGES) },
      minItems: 1,
      maxItems: 3,
    },
    check: { type: "string", enum: Object.keys(CHECKS) },
    variant: { type: "string", enum: Object.values(CHECKS).flatMap(({ variants }) => variants) },
  },
  required: ["pages", "check"],
  additionalProperties: false,
};

function validateJourney(journey) {
  if (
    !journey ||
    Object.getPrototypeOf(journey) !== Object.prototype ||
    !Object.keys(journey).every((key) => Object.hasOwn(journeySchema.properties, key)) ||
    !Array.isArray(journey.pages) ||
    journey.pages.length < 1 ||
    journey.pages.length > 3 ||
    typeof journey.check !== "string" ||
    !Object.hasOwn(CHECKS, journey.check)
  )
    throw Error("Invalid browser journey");
  const pages = [...journey.pages];
  const check = CHECKS[journey.check];
  const variant = Object.hasOwn(journey, "variant") ? journey.variant : check.variants[0];
  if (
    pages.some(
      (page, index) =>
        typeof page !== "string" || !Object.hasOwn(PAGES, page) || page === pages[index - 1]
    ) ||
    pages.at(-1) !== check.page ||
    !check.variants.includes(variant)
  )
    throw Error("Unsupported page, check or variant for browser journey");
  return { pages, check: journey.check, variant };
}

// This checked-in test body runs in the isolated Cypress container. The renderer supplies only
// validated page records and enum values. Keep selectors and application inputs in this body.
function browserSpec({ pages, check, variant, transactionType }, submitSyntheticTransaction) {
  const selector = (id) => '[data-test="' + id + '"]';
  const named = (id) => "Browser journey [" + id + "]";
  const visible = ($node) => $node.length === 1 && Cypress.dom.isVisible($node);
  const expectRoute = (path) => {
    cy.location("pathname").should((pathname) => expect(pathname, named("route")).to.equal(path));
  };
  const expectVisible = (id) => {
    cy.get("body").should(($body) => {
      expect(visible($body.find(selector(id))), named(id)).to.equal(true);
    });
  };
  const expectText = (query, text, id) => {
    cy.get("body").should(($body) => {
      const $element = $body.find(query);
      expect(visible($element) && $element.text().includes(text), named(id)).to.equal(true);
    });
  };

  const checks = {
    "feed-tabs": () => {
      const [id, path] = {
        everyone: ["nav-public-tab", "/"],
        friends: ["nav-contacts-tab", "/contacts"],
        mine: ["nav-personal-tab", "/personal"],
      }[variant];
      expectVisible(id);
      cy.get(selector(id)).click();
      expectRoute(path);
      cy.get(selector(id)).should("have.attr", "aria-selected", "true");
    },
    "settings-validation": () => {
      const [field, error] = {
        "invalid-email": ["email", "Must contain a valid email address"],
        "required-email": ["email", "Enter an email address"],
        "required-first-name": ["firstName", "Enter a first name"],
      }[variant];
      const input = "#user-settings-" + field + "-input";
      cy.get(input).clear();
      if (variant === "invalid-email") cy.get(input).type("invalid-email");
      cy.get(input).blur();
      expectText(input + "-helper-text", error, variant);
      cy.get(selector("user-settings-submit")).should("be.disabled");
    },
    "notification-list": () => {
      if (variant === "empty") {
        cy.wait("@emptyNotifications");
        expectText(selector("empty-list-header"), "No Notifications", "empty-notifications");
        cy.get(selector("notifications-list")).should("not.exist");
      } else {
        expectVisible("notifications-list");
        expectText(
          selector("notification-list-item-8NnQy36xaMtB"),
          "liked a transaction.",
          "seeded-notification"
        );
      }
    },
    "transaction-validation": () => {
      const search = selector("user-list-search-input");
      const amount = selector("transaction-create-amount-input") + " input";
      const note = selector("transaction-create-description-input") + " input";
      expectVisible("user-list-item-_XblMqbuoP");
      cy.get(search).type("Kristian");
      expectText(selector("user-list-item-GjWovtg2hr"), "Kristian", "synthetic-recipient");
      cy.get(selector("user-list-item-GjWovtg2hr")).click();
      expectVisible("transaction-create-form");
      cy.get(amount).type(transactionType ? "1" : "43");
      if (variant === "missing-amount") cy.get(amount).clear();
      cy.get(amount).blur();
      cy.get(note).type("Discovery fixture");
      if (variant === "missing-note") cy.get(note).clear();
      cy.get(note).blur();
      if (variant === "missing-amount")
        expectText(
          "#transaction-create-amount-input-helper-text",
          "Please enter a valid amount",
          "missing-amount"
        );
      if (variant === "missing-note")
        expectText(
          "#transaction-create-description-input-helper-text",
          "Please enter a note",
          "missing-note"
        );
      const state = transactionType || variant === "valid-draft" ? "be.enabled" : "be.disabled";
      cy.get(selector("transaction-create-submit-request")).should(state);
      cy.get(selector("transaction-create-submit-payment")).should(state);
      if (transactionType) submitSyntheticTransaction(transactionType);
    },
    "bank-account-list": () => {
      const expectSeededAccount = () => {
        expectText(
          selector("bankaccount-list-item-pgl34JtnfhX"),
          "Waters, King and O'Reilly Bank",
          "seeded-bank-account"
        );
      };
      expectSeededAccount();
      if (variant === "reload") {
        cy.reload();
        expectRoute("/bankaccounts");
        expectSeededAccount();
      }
    },
  };

  describe("factory browser journey", () => {
    it(check + " / " + variant, () => {
      if (transactionType)
        expect(Cypress.config("baseUrl"), named("disposable-app-origin")).to.equal(
          "http://localhost:3000"
        );
      cy.viewport(1280, 800);
      if (check === "notification-list" && variant === "empty")
        cy.intercept(
          { method: "GET", pathname: "/notifications", port: 3001 },
          {
            statusCode: 200,
            headers: {
              "access-control-allow-origin": "http://localhost:3000",
              "access-control-allow-credentials": "true",
            },
            body: { results: [] },
          }
        ).as("emptyNotifications");
      cy.visit("/signin");
      cy.get(selector("signin-username")).find("input").type("Heath93", { log: false });
      cy.get(selector("signin-password"))
        .find("input")
        .type("discovery-only-password", { log: false });
      cy.get(selector("signin-submit")).click();
      expectRoute("/");
      expectVisible("sidenav-user-full-name");
      for (const { link, path, landmark } of pages) {
        expectVisible(link);
        cy.get(selector(link)).click();
        expectRoute(path);
        if (landmark) expectVisible(landmark);
      }
      checks[check]();
    });
  });
}

function submitSyntheticTransaction(transactionType) {
  const endpoint = "http://localhost:3001/transactions";
  const fixture = {
    senderId: "uBmeaz5pX",
    receiverId: "GjWovtg2hr",
    description: "Discovery fixture",
  };
  let sent = false;
  // Allow exactly one request for the fixed demo fixture to reach the isolated app.
  cy.intercept({ method: "POST", pathname: "**/transactions", middleware: true }, (request) => {
    const amount = request.body?.amount;
    if (
      sent ||
      request.url !== endpoint ||
      (amount !== "1" && amount !== 1) ||
      !Cypress._.isEqual(request.body, { ...fixture, amount, transactionType })
    ) {
      request.destroy();
      return;
    }
    sent = true;
    request.continue();
  }).as("syntheticTransaction");
  cy.get('[data-test="transaction-create-submit-' + transactionType + '"]').click();
  cy.wait("@syntheticTransaction").then(({ response }) => {
    expect(response?.statusCode, "Browser journey [synthetic-transaction-accepted]").to.equal(200);
    const id = response.body?.transaction?.id;
    expect(id, "Browser journey [synthetic-transaction-id]").to.match(/^[A-Za-z0-9_-]{7,24}$/);
    cy.request({ url: endpoint + "/" + id, followRedirect: false, log: false }).then((result) => {
      expect(result.status, "Browser journey [synthetic-transaction-read]").to.equal(200);
      const transaction = result.body?.transaction;
      const isRequest = transactionType === "request";
      expect(transaction, "Browser journey [synthetic-transaction-saved]").to.include({
        ...fixture,
        id,
        amount: 100,
        status: isRequest ? "pending" : "complete",
      });
      expect(transaction.requestStatus, "Browser journey [synthetic-transaction-type]").to.equal(
        isRequest ? "pending" : undefined
      );
    });
  });
  const receipt = (transactionType === "request" ? "Requested" : "Paid") + " $1.00 for ";
  cy.contains("h2", receipt + fixture.description).should(($heading) => {
    expect(
      Cypress.dom.isVisible($heading),
      "Browser journey [synthetic-transaction-receipt]"
    ).to.equal(true);
  });
}

function renderJourney(input) {
  const journey = validateJourney(input);
  const transactionType = SYNTHETIC_TRANSACTIONS[journey.variant] || null;
  const parameters = {
    ...journey,
    pages: journey.pages.map((page) => PAGES[page]),
    transactionType,
  };
  return (
    PREFIX +
    JSON.stringify(journey) +
    "\n(" +
    browserSpec.toString() +
    ")(" +
    JSON.stringify(parameters) +
    (transactionType ? ", " + submitSyntheticTransaction.toString() : "") +
    ");\n"
  );
}

function verifyJourney(source) {
  if (typeof source !== "string" || source.length > 50000 || !source.startsWith(PREFIX))
    throw Error("Invalid generated browser journey source");
  const lineEnd = source.indexOf("\n");
  if (lineEnd < 0) throw Error("Invalid browser journey metadata");
  const journey = validateJourney(JSON.parse(source.slice(PREFIX.length, lineEnd)));
  if (renderJourney(journey) !== source) throw Error("Browser journey template changed");
  return journey;
}

module.exports = { journeySchema, renderJourney, validateJourney, verifyJourney };
