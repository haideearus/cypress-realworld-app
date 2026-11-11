describe("Neon profile pictures", () => {
  it("uploads a private picture through account settings and retains it after reload", () => {
    cy.env(["NEON_TEST_USERNAME"], { log: false }).then(({ NEON_TEST_USERNAME: username }) => {
      expect(username, "dedicated synthetic factory account").to.match(/^factory[a-z0-9]+$/);
      const headers = { origin: Cypress.config("baseUrl") };
      cy.request({
        method: "POST",
        url: "/api/login",
        headers,
        body: { username, password: "s3cret" },
      });
      cy.request({
        method: "POST",
        url: "/api/graphql",
        headers,
        body: {
          query:
            'mutation { createBankAccount(bankName: "Factory Demo", accountNumber: "123456789", routingNumber: "987654321") { id } }',
        },
      })
        .its("body.errors")
        .should("not.exist");
      cy.clearCookies();
      cy.visit("/signin");
      cy.get("#username").type(username);
      cy.get("#password").type("s3cret", { log: false });
      cy.get('[data-test="signin-submit"]').click();
      cy.location("pathname").should("equal", "/");
      cy.visit("/user/settings");
      cy.intercept("POST", "**/api/avatars").as("upload");
      cy.intercept("PATCH", "**/api/users/*").as("savePicture");
      cy.get('[data-test="avatar-file"]').selectFile("public/logo192.png", { force: true });
      cy.wait("@upload").its("response.statusCode").should("equal", 201);
      cy.wait("@savePicture").its("response.statusCode").should("equal", 204);
      cy.get('[data-test="avatar-saved"]').should("contain", "Profile picture saved.");
      cy.get('[data-test="profile-picture"] img')
        .should("have.prop", "naturalWidth")
        .and("be.greaterThan", 0);
    });
    cy.reload();
    cy.get('[data-test="profile-picture"] img')
      .should("have.prop", "naturalWidth")
      .and("be.greaterThan", 0);
  });
});
