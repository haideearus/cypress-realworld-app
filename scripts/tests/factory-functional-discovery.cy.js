const user = { username: "Heath93", password: "s3cret" };
const firstName = "Ted";
const settingsPath = "/user/settings";

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

function signInFixture() {
  cy.visit("/signin", { log: false });
  cy.window({ log: false }).then((win) => {
    // Set up other checks through the app's Cypress-only authentication hook.
    win.authService.send("LOGIN", user);
  });
  cy.get(selector("sidenav-user-full-name"), { log: false }).should("be.visible");
}

describe("functional discovery", () => {
  beforeEach(() => {
    const origin = new URL(Cypress.config("baseUrl")).origin;
    cy.intercept({ url: "**", middleware: true }, (request) => {
      const target = new URL(request.url);
      // Seed avatars and any other external URLs stay inside the disposable browser.
      if (target.origin !== origin) return request.reply({ statusCode: 204 });
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

  it("sign-in-accessibility", () => {
    cy.visit("/signin");
    expectInputLabel("username", "Username", "sign-in-username-label");
    expectInputLabel("password", "Password", "sign-in-password-label");
  });
});
