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

function fillDemoBank() {
  for (const [field, value] of Object.entries(testBank))
    cy.get(selector(`bankaccount-${field}-input`))
      .find("input")
      .clear()
      .type(value, { log: false });
  cy.get(selector("bankaccount-submit")).click();
}

function bankAccountRequest(request, userId) {
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
    Cypress._.isEqual(
      variables,
      variables?.userId === undefined ? testBank : { ...testBank, userId }
    )
  )
    return "save";
}

describe("functional discovery", () => {
  let syntheticUser;
  let sentSettingsUpdate;
  let rejectFirstSave;
  let sentDemoBank;
  beforeEach(() => {
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
});
