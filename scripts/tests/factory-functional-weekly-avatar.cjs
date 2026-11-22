const appOrigin = "https://127.0.0.1:8443";
const storageBucket = "factory-avatar-fixture";
const imageBytes =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const pngObject = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/;
const bankList = /^query ListBankAccount\s*\{\s*listBankAccount\s*\{[\w\s]+\}\s*\}$/;
const selector = (id) => '[data-test="' + id + '"]';
const named = (id) => "Functional discovery [" + id + "]";

function registerWeeklyAvatar() {
  it("profile-picture-persistence", () => {
    cy.env(["factoryAvatarFixtureOrigin"], { log: false }).then(
      ({ factoryAvatarFixtureOrigin }) => {
        const storageOrigin = factoryAvatarFixtureOrigin;
        if (
          Cypress.config("baseUrl") !== appOrigin ||
          typeof storageOrigin !== "string" ||
          !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{1,4}$/.test(storageOrigin) ||
          new URL(storageOrigin).origin !== storageOrigin
        )
          throw Error("Disposable avatar app and storage fixture required");

        const credentials = {
          username: "discoveryavatar" + globalThis.crypto.randomUUID().replaceAll("-", ""),
          password: "s3cret",
        };
        let userId;
        let avatar;
        let uploaded = false;
        let saved = false;
        cy.intercept({ url: "**", middleware: true }, (request) => {
          const target = new URL(request.url);
          if (target.origin === storageOrigin) {
            if (
              request.method === "GET" &&
              avatar &&
              target.pathname === "/" + storageBucket + avatar.slice(4) &&
              target.searchParams.has("X-Amz-Signature")
            )
              return request.continue();
            return request.reply({ statusCode: 405 });
          }
          // Block seeded avatars and other external assets, including unexpected storage redirects.
          if (target.origin !== appOrigin) return request.reply({ statusCode: 204 });
          if (request.method === "GET" || request.method === "HEAD") {
            if (target.pathname.startsWith("/api/avatars") && target.pathname !== avatar)
              return request.reply({ statusCode: 405 });
            return;
          }
          if (
            request.method === "POST" &&
            target.pathname === "/api/login" &&
            request.body?.username === credentials.username &&
            request.body?.password === credentials.password &&
            !target.search
          )
            return;
          if (
            request.method === "POST" &&
            target.pathname === "/api/graphql" &&
            request.body?.operationName === "ListBankAccount" &&
            typeof request.body.query === "string" &&
            bankList.test(request.body.query.trim())
          )
            return request.reply({
              statusCode: 200,
              body: {
                data: {
                  listBankAccount: [
                    {
                      id: "avatar-bank-fixture",
                      bankName: "Demo Bank",
                      accountNumber: "000000001",
                      routingNumber: "000000000",
                    },
                  ],
                },
              },
            });
          if (
            request.method === "POST" &&
            target.pathname === "/api/avatars" &&
            !target.search &&
            userId &&
            !uploaded &&
            request.headers["content-type"] === "image/png"
          ) {
            uploaded = true;
            request.alias = "weeklyAvatarUpload";
            return request.continue((response) => {
              const reference = response.body?.avatar;
              const prefix = "/api/avatars/" + userId + "/";
              if (
                response.statusCode === 201 &&
                typeof reference === "string" &&
                reference.startsWith(prefix) &&
                pngObject.test(reference.slice(prefix.length))
              )
                avatar = reference;
            });
          }
          if (
            request.method === "PATCH" &&
            userId &&
            target.pathname === "/api/users/" + userId &&
            !target.search &&
            avatar &&
            !saved &&
            Cypress._.isEqual(request.body, { avatar })
          ) {
            saved = true;
            request.alias = "weeklyAvatarSave";
            return;
          }
          return request.reply({ statusCode: 405 });
        });

        // This explicit setup request bypasses Cypress interception and targets only the loopback app.
        cy.request({
          method: "POST",
          url: appOrigin + "/api/users",
          headers: { origin: appOrigin },
          followRedirect: false,
          body: {
            ...credentials,
            firstName: "Weekly",
            lastName: "AvatarFixture",
            email: "weekly-avatar@example.test",
            phoneNumber: "2025550103",
            defaultPrivacyLevel: "private",
          },
          log: false,
        }).then(({ status, body }) => {
          if (status !== 201 || !/^[A-Za-z0-9_-]{1,64}$/.test(body?.user?.id || ""))
            throw Error("Synthetic avatar account was unavailable");
          userId = body.user.id;
          cy.visit("/signin");
          cy.get("#username").type(credentials.username, { log: false });
          cy.get("#password").type(credentials.password, { log: false });
          cy.get(selector("signin-submit")).click();
          cy.get(selector("sidenav-user-full-name"), { log: false }).should("be.visible");
          cy.visit("/user/settings");

          cy.get("body").should(($body) => {
            expect(
              $body.find(selector("avatar-file")).length,
              named("avatar-file-control")
            ).to.equal(1);
          });
          cy.get(selector("avatar-file")).selectFile(
            {
              contents: Cypress.Buffer.from(imageBytes, "base64"),
              fileName: "factory-avatar.png",
              mimeType: "image/png",
            },
            { force: true, log: false }
          );
          cy.wait("@weeklyAvatarUpload", { log: false }).then(({ response }) => {
            expect(response?.statusCode, named("avatar-uploaded")).to.equal(201);
            expect(
              Boolean(avatar) && response.body?.avatar === avatar,
              named("avatar-reference")
            ).to.equal(true);
          });
          cy.wait("@weeklyAvatarSave", { log: false }).then(({ response }) => {
            expect(response?.statusCode, named("avatar-profile-saved")).to.equal(204);
          });
          cy.get("body").should(($body) => {
            expect(
              $body.find(selector("avatar-saved")).text().includes("Profile picture saved."),
              named("avatar-success")
            ).to.equal(true);
          });
          cy.reload();
          cy.request({
            method: "GET",
            url: appOrigin + "/api/users/" + userId,
            followRedirect: false,
            failOnStatusCode: false,
            log: false,
          }).then(({ status: profileStatus, body: profile }) => {
            expect(
              profileStatus === 200 &&
                profile?.user?.id === userId &&
                profile?.user?.avatar === avatar,
              named("avatar-profile-reloaded")
            ).to.equal(true);
          });
          cy.get("body", { timeout: 15000 }).should(($body) => {
            const image = $body.find(selector("profile-picture") + " img")[0];
            expect(
              Boolean(
                image &&
                  image.getAttribute("src") === avatar &&
                  image.complete &&
                  image.naturalWidth === 1 &&
                  image.naturalHeight === 1 &&
                  Cypress.dom.isVisible(image)
              ),
              named("avatar-image-after-reload")
            ).to.equal(true);
          });
        });
      }
    );
  });
}

module.exports = { registerWeeklyAvatar };
