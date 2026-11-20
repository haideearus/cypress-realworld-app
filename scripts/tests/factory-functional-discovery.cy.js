const user = { username: "Heath93", password: "s3cret" };
const firstName = "Ted";
const settingsPath = "/user/settings";
const onboarding = "bank-account-onboarding";
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

function expectValidation(field, text, id) {
  cy.get("body").should(($body) => {
    const $message = $body.find(`#user-settings-${field}-input-helper-text`);
    expect(visible($message) && $message.text().includes(text), named(id)).to.equal(true);
  });
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
  cy.visit("/signin", { log: false });
  cy.window({ log: false }).then((win) => {
    // Set up other checks through the app's Cypress-only authentication hook.
    win.authService.send("LOGIN", credentials);
  });
  cy.get(selector("sidenav-user-full-name"), { log: false }).should("be.visible");
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
  let onboardingUserId;
  let onboardingCredentials;
  let rejectFirstSave;
  let sentDemoBank;
  beforeEach(() => {
    const origin = new URL(Cypress.config("baseUrl")).origin;
    const checksOnboarding = Cypress.currentTest.title === onboarding;
    onboardingUserId = undefined;
    onboardingCredentials = undefined;
    rejectFirstSave = true;
    sentDemoBank = false;
    cy.intercept({ url: "**", middleware: true }, (request) => {
      const target = new URL(request.url);
      // Seed avatars and any other external URLs stay inside the disposable browser.
      if (target.origin !== origin) return request.reply({ statusCode: 204 });
      if (checksOnboarding && request.method === "POST") {
        if (target.pathname === "/api/login") {
          if (
            onboardingUserId &&
            request.body?.username === onboardingCredentials.username &&
            request.body?.password === onboardingCredentials.password
          )
            return;
          return request.reply({ statusCode: 405 });
        }
        if (target.pathname === "/api/logout") return;
        if (target.pathname === "/api/graphql") {
          const operation = bankAccountRequest(request, onboardingUserId);
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

  it(onboarding, () => {
    const origin = new URL(Cypress.config("baseUrl")).origin;
    const credentials = {
      username: `discoveryonboarding${globalThis.crypto.randomUUID().replaceAll("-", "")}`,
      password: user.password,
    };
    onboardingCredentials = credentials;
    const dialog = selector("user-onboarding-dialog");
    const title = selector("user-onboarding-dialog-title");
    const next = selector("user-onboarding-next");

    // cy.request bypasses browser interception. Only the loopback fixture is seeded.
    expect(origin).to.equal("https://127.0.0.1:8443");
    cy.request({
      method: "POST",
      url: origin + "/api/users",
      followRedirect: false,
      headers: { origin },
      body: { ...credentials, firstName: "Discovery", lastName: "Fixture" },
      log: false,
    }).then(({ status, body }) => {
      expect(status).to.equal(201);
      expect(body.user.id).to.be.a("string");
      onboardingUserId = body.user.id;
    });

    signInFixture(credentials);
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
    signInFixture(credentials);
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

  it("sign-in-accessibility", () => {
    cy.visit("/signin");
    expectInputLabel("username", "Username", "sign-in-username-label");
    expectInputLabel("password", "Password", "sign-in-password-label");
  });
});
