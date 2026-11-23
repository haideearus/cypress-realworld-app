const { WEEKLY_CHECKS } = require("../factory/functional-discovery-contract.cjs");
const {
  readApp,
  registerWeeklyTransactions,
} = require("./factory-functional-weekly-transactions.cjs");
const { registerWeeklyAvatar } = require("./factory-functional-weekly-avatar.cjs");
const extended = Cypress.expose("factoryFunctionalExtended") === true;

const user = { username: "Heath93", password: "s3cret" };
const firstName = "Ted";
const settingsPath = "/user/settings";
const onboarding = "bank-account-onboarding";
const settingsPersistence = "settings-persistence";
const settingsProfile = {
  firstName: "Discovery",
  lastName: "Fixture",
  email: "discovery@example.test",
  phoneNumber: "2025550100",
  defaultPrivacyLevel: "private",
};
const savedFirstName = "Updated";
const testBank = {
  bankName: "Discovery Demo Bank",
  accountNumber: "000000001",
  routingNumber: "000000000",
};

function selector(id) {
  return `[data-test="${id}"]`;
}

function named(id) {
  return `Functional discovery [${id}]`;
}

function visible($element) {
  return $element.length === 1 && Cypress.dom.isVisible($element);
}

function expectRoute(path, id) {
  cy.location("pathname").should((pathname) => expect(pathname, named(id)).to.equal(path));
}

function expectVisible(query, id) {
  cy.get("body").should(($body) => {
    expect(visible($body.find(query)), named(id)).to.equal(true);
  });
}

function expectText(query, text, id) {
  cy.get("body").should(($body) => {
    const $element = $body.find(query);
    expect(visible($element) && $element.text().includes(text), named(id)).to.equal(true);
  });
}

function expectValidation(field, text, id) {
  expectText(`#user-settings-${field}-input-helper-text`, text, id);
}

function openNotifications(scenario) {
  const link = selector("sidenav-notifications");
  expectVisible(link, `notifications-${scenario}-link`);
  cy.get(link).click();
  expectRoute("/notifications", `notifications-${scenario}-route`);
}

function expectInputLabel(field, text, id) {
  cy.get("body").should(($body) => {
    const $input = $body.find(`input#${field}`);
    const labels = Array.from($input[0]?.labels || []);
    expect(
      visible($input) &&
        labels.some((label) => Cypress.dom.isVisible(label) && label.textContent.trim() === text),
      named(id)
    ).to.equal(true);
  });
}

function signInFixture(credentials = user) {
  cy.visit("/signin", {
    log: false,
    onBeforeLoad(win) {
      win.localStorage.removeItem("authState");
    },
  });
  cy.window({ log: false }).then((win) => {
    // Set up other checks through the app's Cypress-only authentication hook.
    win.authService.send("LOGIN", credentials);
  });
  cy.get(selector("sidenav-user-full-name"), { log: false }).should("be.visible");
}

function seedSyntheticUser(scenario, profile) {
  const origin = new URL(Cypress.config("baseUrl")).origin;
  const credentials = {
    username: `discovery${scenario}${globalThis.crypto.randomUUID().replaceAll("-", "")}`,
    password: user.password,
  };
  // cy.request bypasses browser interception. Seed only the disposable loopback app.
  expect(origin).to.equal("https://127.0.0.1:8443");
  return cy
    .request({
      method: "POST",
      url: origin + "/api/users",
      followRedirect: false,
      headers: { origin },
      body: { ...credentials, ...profile },
      log: false,
    })
    .then(({ status, body }) => {
      expect(status).to.equal(201);
      expect(body.user.id).to.be.a("string");
      return { credentials, id: body.user.id };
    });
}

function fillDemoBank(account = testBank) {
  for (const [field, value] of Object.entries(account))
    cy.get(selector(`bankaccount-${field}-input`))
      .find("input")
      .clear()
      .type(value, { log: false });
  cy.get(selector("bankaccount-submit")).click();
}

function bankAccountRequest(request, userId, account = testBank) {
  const { operationName, query, variables } = request.body || {};
  if (typeof query !== "string") return;
  // Permit only the app's named, single-root GraphQL operations for this fixture.
  const document = query.replace(/\s+/g, " ").trim();
  if (
    operationName === "ListBankAccount" &&
    /^query ListBankAccount\s*\{\s*listBankAccount\s*\{[\w\s]+\}\s*\}$/.test(document)
  )
    return "list";
  const save =
    /^mutation CreateBankAccount\s*\([^{}]+\)\s*\{\s*createBankAccount\s*\(([^{}]+)\)\s*\{[\w\s]+\}\s*\}$/.exec(
      document
    );
  if (
    operationName === "CreateBankAccount" &&
    userId &&
    /^bankName:\s*\$bankName\s*,?\s*accountNumber:\s*\$accountNumber\s*,?\s*routingNumber:\s*\$routingNumber$/.test(
      save?.[1].trim()
    ) &&
    Cypress._.isEqual(variables, variables?.userId === undefined ? account : { ...account, userId })
  )
    return "save";
}

const disposableOrigin = "https://127.0.0.1:8443";
const sender = { id: "uBmeaz5pX", credentials: user };
const receiver = { id: "GjWovtg2hr", credentials: { ...user, username: "Arvilla_Hegmann" } };
const paymentMemo = "Discovery demo payment";
const notificationRows = '[data-test^="notification-list-item-"]';
const primaryNotification = "8NnQy36xaMtB";

function guardExtendedJourney() {
  expect(Cypress.config("baseUrl")).to.equal(disposableOrigin);
  const flow = {};
  cy.viewport(1280, 800);
  cy.intercept({ url: "**", middleware: true }, (request) => {
    const target = new URL(request.url);
    if (target.origin !== disposableOrigin) return request.reply({ statusCode: 204 });
    if (request.method === "GET" || request.method === "HEAD") return;
    if (target.pathname === "/api/graphql" && request.method === "POST" && !target.search) {
      if (
        bankAccountRequest(request) === "list" &&
        (request.body.variables === undefined || Cypress._.isEqual(request.body.variables, {}))
      )
        return;
    }
    const write = flow.write;
    if (
      write &&
      request.method === write.method &&
      target.pathname === write.path &&
      !target.search &&
      write.matches(request)
    ) {
      flow.write = undefined;
      request.alias = "discoveryWrite";
      return;
    }
    return request.reply({ statusCode: 405 });
  });
  return flow;
}

function allowWrite(flow, method, path, matches) {
  cy.then(() => {
    expect(flow.write).to.be.undefined;
    flow.write = { method, path, matches };
  });
}

function freshDiscoveryLogin(flow, fixture) {
  const { id, credentials } = fixture;
  cy.clearAllCookies({ log: false });
  allowWrite(flow, "POST", "/api/login", ({ body }) =>
    Cypress._.isEqual(body, {
      type: "LOGIN",
      username: credentials.username,
      password: credentials.password,
    })
  );
  signInFixture(credentials);
  return cy.wait("@discoveryWrite", { log: false }).then(({ response }) => {
    expect(response?.statusCode).to.equal(200);
    expect(response?.body?.user?.id).to.equal(id);
    return response.body.user;
  });
}

function expectExactText(query, expected, id) {
  cy.get("body").should(($body) => {
    const $element = $body.find(query);
    expect(visible($element) && $element.text().trim() === expected, named(id)).to.equal(true);
  });
}

function expectBalance(cents, id) {
  expectExactText(
    selector("sidenav-user-balance"),
    (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }),
    id
  );
}

function openDiscoveryNotifications() {
  cy.get(selector("sidenav-notifications")).click();
  cy.location("pathname").should("equal", "/notifications");
}

function expectPaymentHistory(transactionId, id) {
  cy.get(selector("sidenav-home")).click();
  cy.get(selector("nav-personal-tab")).click();
  expectRoute("/personal", id);
  const item = selector("transaction-item-" + transactionId);
  expectText(item, paymentMemo, id);
  expectText(item + " " + selector("transaction-amount-" + transactionId), "$2.00", id);
  return cy.get(item);
}

function paymentPersistence() {
  const flow = guardExtendedJourney();
  let recipientBefore;
  let senderBefore;
  freshDiscoveryLogin(flow, receiver).then(({ balance }) => {
    expect(Number.isSafeInteger(balance)).to.equal(true);
    recipientBefore = balance;
  });
  freshDiscoveryLogin(flow, sender).then(({ balance }) => {
    expect(Number.isSafeInteger(balance) && balance >= 200).to.equal(true);
    senderBefore = balance;
  });

  cy.get(selector("nav-top-new-transaction")).click();
  cy.get(selector("user-list-search-input")).type("Kristian");
  cy.get(selector("user-list-item-" + receiver.id)).click();
  cy.get(selector("transaction-create-amount-input") + " input")
    .type("2")
    .blur();
  cy.get(selector("transaction-create-description-input") + " input")
    .type(paymentMemo)
    .blur();
  const payment = {
    senderId: sender.id,
    receiverId: receiver.id,
    transactionType: "payment",
    description: paymentMemo,
  };
  allowWrite(
    flow,
    "POST",
    "/api/transactions",
    ({ body }) =>
      (body?.amount === "2" || body?.amount === 2) &&
      Cypress._.isEqual(body, { ...payment, amount: body.amount })
  );
  cy.get(selector("transaction-create-submit-payment")).click();
  cy.wait("@discoveryWrite", { log: false }).then(({ response }) => {
    const id = named("payment-created");
    expect(response?.statusCode, id).to.equal(200);
    const transaction = response?.body?.transaction;
    expect(transaction, id).to.include({
      senderId: sender.id,
      receiverId: receiver.id,
      amount: 200,
      description: paymentMemo,
    });
    expect(transaction.id, id).to.match(/^[a-zA-Z0-9_-]{7,24}$/);

    freshDiscoveryLogin(flow, sender);
    expectBalance(senderBefore - 200, "payment-sender-balance");
    expectPaymentHistory(transaction.id, "payment-sender-history");

    freshDiscoveryLogin(flow, receiver);
    expectBalance(recipientBefore + 200, "payment-recipient-balance");
    openDiscoveryNotifications();
    // Sign-in can already have a notifications request in flight when the page opens.
    readApp("/notifications").then(({ status, body }) => {
      const assertion = named("payment-recipient-notification");
      expect(status, assertion).to.equal(200);
      expect(body?.results, assertion).to.be.an("array");
      const matches = body.results.filter(
        (item) => item.transactionId === transaction.id && item.userId === receiver.id
      );
      expect(matches, assertion).to.have.length(1);
      expect(matches[0].id, assertion).to.match(/^[a-zA-Z0-9_-]{7,24}$/);
      expectText(
        selector("notification-list-item-" + matches[0].id),
        "received payment.",
        "payment-recipient-notification"
      );
    });

    expectPaymentHistory(transaction.id, "payment-recipient-history").click();
    expectRoute("/transaction/" + transaction.id, "payment-receipt-opened");
    expectText(selector("transaction-description"), paymentMemo, "payment-receipt-opened");
    expectText(selector("transaction-amount-" + transaction.id), "$2.00", "payment-receipt-opened");
  });
}

function notificationReadPersistence() {
  const flow = guardExtendedJourney();
  const notification = selector("notification-list-item-" + primaryNotification);
  const dismiss = selector("notification-mark-read-" + primaryNotification);
  const badge = selector("nav-top-notifications-count");
  freshDiscoveryLogin(flow, sender);
  openDiscoveryNotifications();
  cy.get(notification).should("be.visible");
  cy.get(notificationRows).then(($rows) => {
    const remaining = Array.from($rows, (row) => row.dataset.test).filter(
      (id) => id !== "notification-list-item-" + primaryNotification
    );
    expect(remaining.length).to.be.greaterThan(0);
    allowWrite(flow, "PATCH", "/api/notifications/" + primaryNotification, ({ body }) =>
      Cypress._.isEqual(body, { id: primaryNotification, isRead: true })
    );
    cy.get(dismiss).click();
    cy.wait("@discoveryWrite", { log: false }).then(({ response }) => {
      expect(response?.statusCode, named("notification-read-dismissed")).to.equal(204);
    });
    expectExactText(badge, String(remaining.length), "notification-read-dismissed");

    freshDiscoveryLogin(flow, sender);
    openDiscoveryNotifications();
    cy.get("body").should(($body) => {
      expect(
        Array.from($body.find(notificationRows), (row) => row.dataset.test),
        named("notification-read-reloaded")
      ).to.have.members(remaining);
    });
    expectExactText(badge, String(remaining.length), "notification-read-reloaded");
  });
}

function mobileFeedFilters() {
  const flow = guardExtendedJourney();
  freshDiscoveryLogin(flow, sender);
  cy.viewport(390, 844);
  cy.intercept({ method: "GET", pathname: "/api/transactions" }).as("personalFeed");
  cy.get(selector("nav-personal-tab")).click();
  cy.wait("@personalFeed").then(({ response }) => {
    const baseline = response?.body?.results?.map(({ id }) => id);
    expect(baseline, named("mobile-filters-unfiltered")).to.include("J5Fd3dlBEBu");
    expectVisible(selector("transaction-item-J5Fd3dlBEBu"), "mobile-filters-unfiltered");

    const amountButton = selector("transaction-list-filter-amount-range-button");
    const amountClose = selector("amount-range-filter-drawer-close");
    cy.get(amountButton).click();
    cy.get(selector("transaction-list-filter-amount-range-slider")).then(($slider) => {
      // Clicking 40% of the slider moves the lower thumb to $400.
      cy.wrap($slider).click(Math.round($slider.width() * 0.4), Math.round($slider.height() / 2));
    });
    expectText(
      selector("transaction-list-filter-amount-range-text"),
      "$400 - $1,000",
      "mobile-filters-amount"
    );
    cy.get(amountClose).click();
    cy.wait("@personalFeed").then(({ response: amount }) => {
      const assertion = named("mobile-filters-amount");
      expect(
        amount?.body?.results?.map(({ id }) => id),
        assertion
      ).to.include("GiWvOORKa8fF");
      expect(
        amount.body.results.every(({ amount }) => amount >= 40000),
        assertion
      ).to.equal(true);
    });
    expectVisible(selector("transaction-item-GiWvOORKa8fF"), "mobile-filters-amount");

    // The amount filter debounces against wall time. Pin only the calendar's starting month.
    cy.clock(new Date(2024, 2, 15).getTime(), ["Date"]).as("calendarClock");
    cy.get(selector("transaction-list-filter-date-range-button")).click();
    const calendarDay =
      selector("transaction-list-filter-date-range") +
      " .react-calendar__month-view__days button:not(.react-calendar__month-view__days__day--neighboringMonth)";
    cy.contains(calendarDay, /^5$/).click();
    cy.contains(calendarDay, /^7$/).click();
    cy.get("@calendarClock").invoke("restore");
    cy.wait("@personalFeed").then(({ response: empty }) => {
      expect(empty?.body?.results, named("mobile-filters-empty")).to.deep.equal([]);
    });
    expectExactText(selector("empty-list-header"), "No Transactions", "mobile-filters-empty");
    const create = selector("transaction-list-empty-create-transaction-button");
    expectVisible(create, "mobile-filters-empty");
    cy.get(create).should(($link) => {
      expect($link.attr("href"), named("mobile-filters-empty")).to.equal("/transaction/new");
    });

    cy.get(amountButton).click();
    cy.get(selector("transaction-list-filter-amount-clear-button")).click();
    cy.get(amountClose).click();
    cy.wait("@personalFeed").then(({ response: date }) => {
      expect(
        date?.body?.results?.map(({ id }) => id),
        named("mobile-filters-date")
      ).to.deep.equal(["Wfk6WoLHlPZ", "52ypEQM_-jD", "glw3rNgxp6yC", "UOO3uWBD_iZ"]);
    });
    expectVisible(selector("transaction-item-Wfk6WoLHlPZ"), "mobile-filters-date");

    cy.get(selector("transaction-list-filter-date-clear-button")).click();
    cy.wait("@personalFeed").then(({ response: restored }) => {
      expect(
        restored?.body?.results?.map(({ id }) => id),
        named("mobile-filters-reset")
      ).to.deep.equal(baseline);
    });
    expectExactText(
      selector("transaction-list-filter-date-range-button"),
      "Date: ALL",
      "mobile-filters-reset"
    );
    expectVisible(selector("transaction-item-J5Fd3dlBEBu"), "mobile-filters-reset");
  });
}

function saveDiscoveryBank(flow, fixture, bank) {
  allowWrite(
    flow,
    "POST",
    "/api/graphql",
    (request) => bankAccountRequest(request, fixture.id, bank) === "save"
  );
  fillDemoBank(bank);
  return cy.wait("@discoveryWrite", { log: false }).then(({ response }) => {
    const account = response?.body?.data?.createBankAccount;
    expect(response?.statusCode).to.equal(200);
    expect(account?.id).to.match(/^[a-zA-Z0-9_-]{7,24}$/);
    expect(account.userId).to.equal(fixture.id);
    return account;
  });
}

function removeDiscoveryBank(flow, account, id) {
  const row = selector("bankaccount-list-item-" + account.id);
  const button = selector("bankaccount-delete");
  expectText(row, account.bankName, id);
  allowWrite(
    flow,
    "POST",
    "/api/graphql",
    ({ body }) =>
      body?.operationName === "DeleteBankAccount" &&
      typeof body.query === "string" &&
      /^mutation DeleteBankAccount\s*\(\s*\$id:\s*ID!\s*\)\s*\{\s*deleteBankAccount\s*\(\s*id:\s*\$id\s*\)\s*\}$/.test(
        body.query.trim()
      ) &&
      Cypress._.isEqual(body.variables, { id: account.id })
  );
  cy.get(row).find(button).click();
  cy.wait("@discoveryWrite", { log: false }).then(({ response }) => {
    expect(response?.statusCode, named(id)).to.equal(200);
    expect(response?.body?.data?.deleteBankAccount, named(id)).to.equal(true);
  });
  expectText(row, "(Deleted)", id);
}

function bankAccountDeletion() {
  const flow = guardExtendedJourney();
  const secondBank = { ...testBank, bankName: "Discovery Second Bank", accountNumber: "000000002" };
  const dialog = selector("user-onboarding-dialog");
  const next = selector("user-onboarding-next");
  const accountsLink = selector("sidenav-bankaccounts");
  seedSyntheticUser("bankdelete", { firstName: "Discovery", lastName: "Fixture" }).then(
    (fixture) => {
      freshDiscoveryLogin(flow, fixture);
      cy.get(next).click();
      saveDiscoveryBank(flow, fixture, testBank).then((first) => {
        cy.contains(next, "Done").click();
        cy.get(accountsLink).click();
        cy.get(selector("bankaccount-new")).click();
        saveDiscoveryBank(flow, fixture, secondBank).then((second) => {
          cy.get(selector("bankaccount-list-item-" + second.id)).should("be.visible");
          removeDiscoveryBank(flow, first, "bank-deletion-first-removed");
          freshDiscoveryLogin(flow, fixture);
          cy.visit("/bankaccounts");
          expectText(
            selector("bankaccount-list-item-" + first.id),
            "(Deleted)",
            "bank-deletion-active-account"
          );
          expectVisible(
            selector("bankaccount-list-item-" + second.id) + " " + selector("bankaccount-delete"),
            "bank-deletion-active-account"
          );
          cy.get("body").should(($body) => {
            expect(
              $body.find(dialog).is(":visible"),
              named("bank-deletion-active-account")
            ).to.equal(false);
          });

          removeDiscoveryBank(flow, second, "bank-deletion-last-removed");
          freshDiscoveryLogin(flow, fixture);
          expectText(
            selector("user-onboarding-dialog-title"),
            "Get Started",
            "bank-deletion-onboarding"
          );
        });
      });
    }
  );
}

describe("functional discovery", () => {
  let syntheticUser;
  let sentSettingsUpdate;
  let rejectFirstSave;
  let sentDemoBank;
  beforeEach(() => {
    if (extended && WEEKLY_CHECKS.includes(Cypress.currentTest.title)) return;
    const origin = new URL(Cypress.config("baseUrl")).origin;
    const checksOnboarding = Cypress.currentTest.title === onboarding;
    const checksSettingsPersistence = Cypress.currentTest.title === settingsPersistence;
    syntheticUser = undefined;
    sentSettingsUpdate = false;
    rejectFirstSave = true;
    sentDemoBank = false;
    cy.intercept({ url: "**", middleware: true }, (request) => {
      const target = new URL(request.url);
      // Seed avatars and any other external URLs stay inside the disposable browser.
      if (target.origin !== origin) return request.reply({ statusCode: 204 });
      if (
        (checksOnboarding || checksSettingsPersistence) &&
        request.method === "POST" &&
        target.pathname === "/api/login"
      ) {
        if (
          syntheticUser &&
          request.body?.username === syntheticUser.credentials.username &&
          request.body?.password === syntheticUser.credentials.password
        ) {
          request.alias = "syntheticLogin";
          return;
        }
        return request.reply({ statusCode: 405 });
      }
      if (
        checksSettingsPersistence &&
        request.method === "PATCH" &&
        syntheticUser &&
        !sentSettingsUpdate &&
        target.pathname === `/api/users/${syntheticUser.id}` &&
        !target.search &&
        Cypress._.isEqual(request.body, {
          ...settingsProfile,
          id: syntheticUser.id,
          firstName: savedFirstName,
        })
      ) {
        sentSettingsUpdate = true;
        request.alias = "settingsSaved";
        return;
      }
      if (
        checksSettingsPersistence &&
        syntheticUser &&
        request.method === "POST" &&
        target.pathname === "/api/graphql" &&
        bankAccountRequest(request, syntheticUser.id) === "list"
      ) {
        // Exercise an onboarded Settings user without creating a bank account in this check.
        return request.reply({
          statusCode: 200,
          body: { data: { listBankAccount: [{ id: "settings-bank-fixture", ...testBank }] } },
        });
      }
      if (checksOnboarding && request.method === "POST") {
        if (target.pathname === "/api/logout") return;
        if (target.pathname === "/api/graphql") {
          const operation = bankAccountRequest(request, syntheticUser?.id);
          if (operation === "list") return;
          if (operation === "save" && !sentDemoBank) {
            request.alias = rejectFirstSave ? "onboardingRejected" : "onboardingSaved";
            if (!rejectFirstSave) {
              sentDemoBank = true;
              return;
            }
            rejectFirstSave = false;
            // A GraphQL error can arrive on HTTP 200. The database sees no failed write.
            return request.reply({
              statusCode: 200,
              body: {
                data: { createBankAccount: null },
                errors: [{ message: "Test save rejected" }],
              },
            });
          }
        }
      }
      if (
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        !(request.method === "POST" && target.pathname === "/api/login")
      ) {
        return request.reply({ statusCode: 405 });
      }
    });
  });

  it("sign-in", () => {
    cy.visit("/signin");
    expectVisible(selector("signin-submit"), "sign-in-form");
    cy.get("#username").type(user.username, { log: false });
    cy.get("#password").type(user.password, { log: false });
    cy.get(selector("signin-submit")).click();
    expectRoute("/", "sign-in-route");
    expectVisible(selector("sidenav-user-full-name"), "sign-in-identity");
    cy.reload();
    expectVisible(selector("sidenav-user-full-name"), "sign-in-session");
  });

  it("navigation", () => {
    signInFixture();
    const settings = selector("sidenav-user-settings");
    expectVisible(settings, "navigation-settings-link");
    cy.get(settings).click();
    expectRoute(settingsPath, "navigation-settings-route");
    const home = selector("sidenav-home");
    expectVisible(home, "navigation-home-link");
    cy.get(home).click();
    expectRoute("/", "navigation-home-route");
  });

  it("settings", () => {
    signInFixture();
    cy.visit(settingsPath);
    expectVisible(selector("user-settings-form"), "settings-form");
    cy.get("body").should(($body) => {
      expect(
        $body.find("#user-settings-firstName-input").val(),
        named("settings-profile")
      ).to.equal(firstName);
    });
  });

  it("form-validation", () => {
    signInFixture();
    cy.visit(settingsPath);
    const firstNameField = "#user-settings-firstName-input";
    cy.get(firstNameField).clear();
    cy.get(firstNameField).blur();
    expectValidation("firstName", "Enter a first name", "settings-first-name-required");
    cy.get(firstNameField).type(firstName);
    cy.get(firstNameField).blur();

    const email = "#user-settings-email-input";
    cy.get(email).clear();
    cy.get(email).blur();
    expectValidation("email", "Enter an email address", "settings-email-required");

    cy.get(email).type("invalid-email");
    cy.get(email).blur();
    expectValidation("email", "Must contain a valid email address", "settings-email-invalid");
    cy.get("body").should(($body) => {
      expect(
        $body.find(selector("user-settings-submit")).is(":disabled"),
        named("settings-save-disabled")
      ).to.equal(true);
    });
  });

  it(settingsPersistence, () => {
    seedSyntheticUser("settings", settingsProfile).then((fixture) => {
      syntheticUser = fixture;
      signInFixture(fixture.credentials);
    });
    cy.wait("@syntheticLogin", { log: false });
    cy.visit(settingsPath);
    const field = "#user-settings-firstName-input";
    cy.get(field).clear().type(savedFirstName).blur();
    cy.get(selector("user-settings-submit")).click();
    cy.wait("@settingsSaved", { log: false }).should(({ response }) => {
      expect(response?.statusCode, named("settings-persistence-saved")).to.equal(204);
    });
    // Read the saved profile from a fresh session rather than using cached form state.
    cy.clearCookies({ log: false });
    cy.then(() => signInFixture(syntheticUser.credentials));
    cy.wait("@syntheticLogin", { log: false }).then(({ response }) => {
      expect(response?.body?.user?.id).to.equal(syntheticUser.id);
    });
    cy.visit(settingsPath);
    cy.get("body").should(($body) => {
      expect($body.find(field).val(), named("settings-persistence-reloaded")).to.equal(
        savedFirstName
      );
    });
  });

  it(onboarding, () => {
    const dialog = selector("user-onboarding-dialog");
    const title = selector("user-onboarding-dialog-title");
    const next = selector("user-onboarding-next");

    seedSyntheticUser("onboarding", { firstName: "Discovery", lastName: "Fixture" }).then(
      (fixture) => {
        syntheticUser = fixture;
        signInFixture(fixture.credentials);
      }
    );
    expectVisible(dialog, "onboarding-wizard");
    cy.get(next).click();
    fillDemoBank();
    cy.wait("@onboardingRejected", { log: false });
    cy.get("body").should(($body) => {
      const $dialog = $body.find(dialog);
      const error = $dialog
        .find('[role="alert"]')
        .filter((_, node) => Cypress.dom.isVisible(node) && Boolean(node.textContent.trim()));
      expect(
        visible($dialog.find(selector("bankaccount-form"))) &&
          !$dialog.find(title).text().includes("Finished") &&
          error.length > 0,
        named("onboarding-save-rejected")
      ).to.equal(true);
    });

    fillDemoBank();
    cy.wait("@onboardingSaved", { log: false }).should(({ response }) => {
      expect(
        response?.statusCode === 200 &&
          !response.body.errors?.length &&
          typeof response.body.data?.createBankAccount?.id === "string",
        named("onboarding-save-confirmed")
      ).to.equal(true);
    });
    cy.get(title).should(($title) =>
      expect($title.text(), named("onboarding-finish")).to.equal("Finished")
    );
    cy.get(next).click();
    cy.get(selector("sidenav-signout")).click();
    expectRoute("/signin", "onboarding-sign-out");
    cy.then(() => signInFixture(syntheticUser.credentials));
    cy.visit("/bankaccounts");
    cy.get("body").should(($body) => {
      expect(
        visible($body.find(selector("bankaccount-list"))) &&
          $body.find(selector("bankaccount-list")).text().includes(testBank.bankName) &&
          !$body.find(dialog).is(":visible"),
        named("onboarding-account-after-sign-in")
      ).to.equal(true);
    });
  });

  it("feed-tabs", () => {
    signInFixture();
    for (const [tab, label, path] of [
      ["contacts", "friends", "/contacts"],
      ["personal", "mine", "/personal"],
      ["public", "everyone", "/"],
    ]) {
      const query = selector(`nav-${tab}-tab`);
      expectVisible(query, `feed-${label}-tab`);
      cy.get(query).click();
      expectRoute(path, `feed-${label}-route`);
      cy.get("body").should(($body) => {
        expect($body.find(query).attr("aria-selected"), named(`feed-${label}-selected`)).to.equal(
          "true"
        );
      });
    }
  });

  it("transaction-form-validation", { scrollBehavior: "center" }, () => {
    signInFixture();
    const start = selector("nav-top-new-transaction");
    const search = selector("user-list-search-input");
    const recipient = selector("user-list-item-GjWovtg2hr");
    const unrelatedRecipient = selector("user-list-item-_XblMqbuoP");
    const amount = selector("transaction-create-amount-input") + " input";
    const note = selector("transaction-create-description-input") + " input";
    const submit = [
      selector("transaction-create-submit-request"),
      selector("transaction-create-submit-payment"),
    ].join(",");
    expectVisible(start, "transaction-new-link");
    cy.get(start).click();
    expectRoute("/transaction/new", "transaction-new-route");
    expectVisible(search, "transaction-recipient-search");
    expectVisible(unrelatedRecipient, "transaction-fixture-users-loaded");
    cy.get(search).type("Kristian");
    cy.get("body").should(($body) => {
      const $recipient = $body.find(recipient);
      expect(
        visible($recipient) &&
          $recipient.text().includes("Kristian") &&
          !$body.find(unrelatedRecipient).is(":visible"),
        named("transaction-fixture-recipient")
      ).to.equal(true);
    });
    cy.get(recipient).click();
    expectVisible(selector("transaction-create-form"), "transaction-form");

    cy.get(amount).type("43").clear().blur();
    expectText(
      "#transaction-create-amount-input-helper-text",
      "Please enter a valid amount",
      "transaction-amount-required"
    );
    cy.get(note).type("Discovery fixture").clear().blur();
    expectText(
      "#transaction-create-description-input-helper-text",
      "Please enter a note",
      "transaction-note-required"
    );
    cy.get("body").should(($body) => {
      const buttons = $body.find(submit);
      expect(
        buttons.length === 2 && buttons.filter(":disabled").length === 2,
        named("transaction-submit-disabled")
      ).to.equal(true);
    });

    cy.get(amount).type("43").blur();
    cy.get(note).type("Discovery fixture").blur();
    cy.get("body").should(($body) => {
      const buttons = $body.find(submit);
      expect(
        buttons.length === 2 && buttons.filter(":enabled").length === 2,
        named("transaction-submit-enabled")
      ).to.equal(true);
    });
  });

  it("notifications-populated", () => {
    signInFixture();
    openNotifications("list");
    expectVisible(selector("notifications-list"), "notifications-list-present");
    expectText(
      selector("notification-list-item-8NnQy36xaMtB"),
      "liked a transaction.",
      "notifications-seed-items"
    );
    expectText(
      selector("notification-list-item-mq-7Xnl-74JR"),
      "commented on a transaction.",
      "notifications-seed-comment"
    );
  });

  it("notifications-empty", () => {
    signInFixture();
    expectText(selector("nav-top-notifications-count"), "8", "notifications-empty-seeded");
    cy.intercept("GET", "/api/notifications", { statusCode: 200, body: { results: [] } }).as(
      "emptyNotificationList"
    );
    openNotifications("empty");
    cy.wait("@emptyNotificationList", { log: false });
    cy.get("body").should(($body) => {
      const $empty = $body.find(selector("empty-list-header"));
      expect(
        visible($empty) &&
          $empty.text().includes("No Notifications") &&
          !$body.find(selector("notifications-list")).is(":visible"),
        named("notifications-empty-view")
      ).to.equal(true);
    });
  });

  it("sign-in-accessibility", () => {
    cy.visit("/signin");
    expectInputLabel("username", "Username", "sign-in-username-label");
    expectInputLabel("password", "Password", "sign-in-password-label");
  });
  if (extended) {
    it("mobile-feed-filters", { scrollBehavior: "center" }, mobileFeedFilters);
    it("payment-persistence", { scrollBehavior: "center" }, paymentPersistence);
    it("notification-read-persistence", { scrollBehavior: "center" }, notificationReadPersistence);
    it("bank-account-deletion", bankAccountDeletion);
    registerWeeklyTransactions();
    registerWeeklyAvatar();
  }
});
