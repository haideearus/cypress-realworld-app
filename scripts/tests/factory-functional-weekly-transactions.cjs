const origin = "https://127.0.0.1:8443";
const requester = { id: "uBmeaz5pX", username: "Heath93" };
const recipient = { id: "GjWovtg2hr", username: "Arvilla_Hegmann" };
const password = "s3cret";
const requestMemo = "Weekly discovery request";
const requestCents = 100;
const seededTransaction = "1xfcAhNDZK4";

const requestAssertions = ["created", "notification", "action", "status", "balances"];
const transactionAssertions = {
  "request-acceptance": requestAssertions.map((assertion) => "request-acceptance-" + assertion),
  "request-decline": requestAssertions.map((assertion) => "request-decline-" + assertion),
  "transaction-comment": [
    "transaction-comment-saved",
    "transaction-comment-visible",
    "transaction-comment-reloaded",
  ],
};

function matchesBody(actual, expected) {
  return (
    actual !== null &&
    typeof actual === "object" &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, value]) => Object.hasOwn(actual, key) && actual[key] === value
    )
  );
}

function writeAlias({ url, method, body }, flow) {
  if (!url.startsWith(origin + "/api/")) return;
  const path = url.slice(origin.length);
  if (method === "POST" && path === "/api/login" && flow.login) {
    if (matchesBody(body, { type: "LOGIN", username: flow.login.username, password }))
      return "weeklyLogin";
    return;
  }
  if (method === "POST" && path === "/api/graphql" && flow.active) {
    if (
      body?.operationName === "ListBankAccount" &&
      typeof body.query === "string" &&
      /^query\s+ListBankAccount\s*\{\s*listBankAccount\s*\{[\w\s]+\}\s*\}$/.test(body.query) &&
      (body.variables === undefined || matchesBody(body.variables, {}))
    )
      return "weeklyBankRead";
    return;
  }
  if (
    method === "POST" &&
    path === "/api/transactions" &&
    flow.create &&
    flow.active === requester.id &&
    (body?.amount === "1" || body?.amount === 1) &&
    matchesBody(body, {
      senderId: requester.id,
      receiverId: recipient.id,
      transactionType: "request",
      amount: body.amount,
      description: requestMemo,
    })
  )
    return "weeklyCreate";
  if (
    method === "PATCH" &&
    flow.resolution &&
    flow.active === recipient.id &&
    path === "/api/transactions/" + flow.resolution.id &&
    matchesBody(body, { id: flow.resolution.id, requestStatus: flow.resolution.action })
  )
    return "weeklyResolve";
  if (
    method === "POST" &&
    flow.comment &&
    flow.active === requester.id &&
    path === "/api/comments/" + flow.comment.id &&
    matchesBody(body, { transactionId: flow.comment.id, content: flow.comment.text })
  )
    return "weeklyComment";
}

function guardBrowser(flow) {
  expect(Cypress.config("baseUrl")).to.equal(origin);
  cy.viewport(1280, 800);
  cy.intercept({ url: "**", middleware: true }, (request) => {
    if (new URL(request.url).origin !== origin) return request.reply({ statusCode: 204 });
    if (request.method === "GET" || request.method === "HEAD") return;
    const alias = writeAlias(request, flow);
    switch (alias) {
      case "weeklyLogin":
        flow.login = undefined;
        break;
      case "weeklyCreate":
        flow.create = false;
        break;
      case "weeklyResolve":
        flow.resolution = undefined;
        break;
      case "weeklyComment":
        flow.comment = undefined;
        break;
      case "weeklyBankRead":
        return;
      default:
        return request.reply({ statusCode: 405 });
    }
    request.alias = alias;
  });
}

const named = (id) => "Functional discovery [" + id + "]";
const selector = (id) => '[data-test="' + id + '"]';
const visible = ($node) => $node.length === 1 && Cypress.dom.isVisible($node);

function login(flow, user) {
  cy.clearAllCookies({ log: false });
  cy.then(() => {
    flow.login = user;
    flow.active = user.id;
  });
  cy.visit("/signin", {
    log: false,
    onBeforeLoad(win) {
      win.localStorage.removeItem("authState");
    },
  });
  cy.window({ log: false }).then((win) => {
    win.authService.send("LOGIN", { username: user.username, password });
  });
  cy.wait("@weeklyLogin", { log: false }).then(({ response }) => {
    expect(response?.statusCode).to.equal(200);
    expect(response?.body?.user?.id).to.equal(user.id);
  });
  cy.get(selector("sidenav-user-full-name"), { log: false }).should("be.visible");
}

function readApp(path) {
  // Cypress's request client does not use the browser's intercept, so use an absolute
  // disposable loopback URL with redirects disabled and only an explicit GET.
  return cy.request({
    method: "GET",
    url: origin + "/api" + path,
    followRedirect: false,
    failOnStatusCode: false,
    log: false,
  });
}

function balanceOf(user, assertion) {
  return readApp("/users/" + user.id).then(({ status, body }) => {
    expect(status, assertion).to.equal(200);
    expect(body.user?.id, assertion).to.equal(user.id);
    expect(Number.isSafeInteger(body.user?.balance), assertion).to.equal(true);
    return body.user.balance;
  });
}

function expectDisplayedBalance(amount, assertion) {
  const expected = (amount / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  cy.get("body").should(($body) => {
    const $balance = $body.find(selector("sidenav-user-balance"));
    expect(visible($balance) && $balance.text().trim() === expected, assertion).to.equal(true);
  });
}

function createRequest(flow, title) {
  const assertion = named(title + "-created");
  cy.get(selector("nav-top-new-transaction")).click();
  cy.get(selector("user-list-search-input")).type("Kristian");
  cy.get(selector("user-list-item-" + recipient.id)).click();
  cy.get(selector("transaction-create-amount-input") + " input")
    .type("1")
    .blur();
  cy.get(selector("transaction-create-description-input") + " input")
    .type(requestMemo)
    .blur();
  cy.then(() => {
    flow.create = true;
  });
  cy.get("body").should(($body) => {
    const $button = $body.find(selector("transaction-create-submit-request"));
    expect(visible($button) && $button.is(":enabled"), assertion).to.equal(true);
  });
  cy.get(selector("transaction-create-submit-request")).click();
  return cy.wait("@weeklyCreate", { log: false }).then(({ response }) => {
    expect(response?.statusCode, assertion).to.equal(200);
    const transaction = response?.body?.transaction;
    expect(transaction, assertion).to.include({
      senderId: requester.id,
      receiverId: recipient.id,
      description: requestMemo,
      amount: requestCents,
      requestStatus: "pending",
    });
    expect(transaction.id, assertion).to.match(/^[A-Za-z0-9_-]{7,24}$/);
    return transaction.id;
  });
}

function expectNotification(transactionId, title) {
  const assertion = named(title + "-notification");
  cy.get(selector("sidenav-notifications")).click();
  cy.location("pathname").should((pathname) =>
    expect(pathname, assertion).to.equal("/notifications")
  );
  readApp("/notifications").then(({ status, body }) => {
    expect(status, assertion).to.equal(200);
    expect(body?.results, assertion).to.be.an("array");
    const rows = body.results.filter(
      (notification) =>
        notification.transactionId === transactionId && notification.userId === recipient.id
    );
    expect(rows, assertion).to.have.length(1);
    expect(rows[0].id, assertion).to.match(/^[A-Za-z0-9_-]{7,24}$/);
    cy.get("body").should(($body) => {
      const $notification = $body.find(selector("notification-list-item-" + rows[0].id));
      expect(
        visible($notification) && $notification.text().includes("requested payment."),
        assertion
      ).to.equal(true);
    });
  });
}

function resolveRequest(flow, transactionId, title, accepts) {
  const action = accepts ? "accepted" : "rejected";
  const assertion = named(title + "-action");
  const button = selector(
    "transaction-" + (accepts ? "accept" : "reject") + "-request-" + transactionId
  );
  cy.visit("/transaction/" + transactionId);
  cy.get("body").should(($body) => expect(visible($body.find(button)), assertion).to.equal(true));
  cy.then(() => {
    flow.resolution = { id: transactionId, action };
  });
  cy.get(button).click();
  cy.wait("@weeklyResolve", { log: false }).then(({ response }) => {
    expect(response?.statusCode, assertion).to.equal(204);
  });
  const statusAssertion = named(title + "-status");
  readApp("/transactions/" + transactionId).then(({ status, body }) => {
    expect(status, statusAssertion).to.equal(200);
    expect(body.transaction?.requestStatus, statusAssertion).to.equal(action);
  });
  const buttons =
    selector("transaction-accept-request-" + transactionId) +
    "," +
    selector("transaction-reject-request-" + transactionId);
  cy.get("body").should(($body) => {
    expect($body.find(buttons).length, statusAssertion).to.equal(0);
  });
}

function requestJourney(title, accepts) {
  const flow = {};
  guardBrowser(flow);
  login(flow, requester);
  balanceOf(requester).then((requesterBefore) => {
    createRequest(flow, title).then((transactionId) => {
      login(flow, recipient);
      balanceOf(recipient).then((recipientBefore) => {
        expectNotification(transactionId, title);
        resolveRequest(flow, transactionId, title, accepts);
        const assertion = named(title + "-balances");
        // Check both persisted balances before asserting the UI or the first account.
        // This proves the recipient was debited and requester credited only on acceptance.
        balanceOf(recipient, assertion).then((recipientAfter) => {
          login(flow, requester);
          balanceOf(requester, assertion).then((requesterAfter) => {
            const change = accepts ? requestCents : 0;
            expect([recipientAfter, requesterAfter], assertion).to.deep.equal([
              recipientBefore - change,
              requesterBefore + change,
            ]);
            expectDisplayedBalance(requesterAfter, assertion);
          });
        });
      });
    });
  });
}

function commentJourney() {
  const flow = {};
  guardBrowser(flow);
  login(flow, requester);
  readApp("/transactions/" + seededTransaction).then(({ status, body }) => {
    expect(status).to.equal(200);
    expect(body.transaction?.senderId).to.equal(requester.id);
  });
  const text = "Weekly discovery " + globalThis.crypto.randomUUID();
  const comment = { id: seededTransaction, text };
  cy.visit("/transaction/" + comment.id);
  cy.then(() => {
    flow.comment = comment;
  });
  const input = selector("transaction-comment-input-" + comment.id);
  const saved = named("transaction-comment-saved");
  cy.get("body").should(($body) => expect(visible($body.find(input)), saved).to.equal(true));
  cy.get(input).type(comment.text + "{enter}", { log: false });
  cy.wait("@weeklyComment", { log: false }).then(({ response }) => {
    expect(response?.statusCode, saved).to.equal(200);
  });
  function expectComment(assertion) {
    cy.get("body").should(($body) => {
      const $comment = $body.find('[data-test^="comment-list-item-"]').filter((_index, element) => {
        return element.textContent.trim() === comment.text;
      });
      expect(visible($comment), named(assertion)).to.equal(true);
    });
  }
  expectComment("transaction-comment-visible");
  cy.reload();
  expectComment("transaction-comment-reloaded");
}

function registerWeeklyTransactions() {
  it("request-acceptance", { scrollBehavior: "center" }, () =>
    requestJourney("request-acceptance", true)
  );
  it("request-decline", { scrollBehavior: "center" }, () =>
    requestJourney("request-decline", false)
  );
  it("transaction-comment", commentJourney);
}

module.exports = { registerWeeklyTransactions, transactionAssertions, writeAlias };
