describe("the production website", () => {
  it("logs in through the API on the same HTTPS origin", () => {
    cy.intercept("POST", "**/api/login").as("login");
    cy.visit("/signin");
    cy.get("#username").type("Heath93");
    cy.get("#password").type("s3cret", { log: false });
    cy.get('[data-test="signin-submit"]').click();
    cy.wait("@login").then(({ request, response }) => {
      expect(new URL(request.url).origin).to.equal(new URL(Cypress.config("baseUrl")).origin);
      expect(response.statusCode).to.equal(200);
      expect(response.body.user).not.to.have.property("password");
    });
    cy.location("pathname").should("equal", "/");
    cy.get('[data-test="sidenav-user-full-name"]').should("be.visible");
    cy.reload();
    cy.get('[data-test="sidenav-user-full-name"]').should("be.visible");
  });
});
