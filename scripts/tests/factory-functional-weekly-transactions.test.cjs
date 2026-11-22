const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  writeAlias,
  transactionAssertions,
} = require("./factory-functional-weekly-transactions.cjs");

const origin = "https://127.0.0.1:8443";
const requester = { id: "uBmeaz5pX", username: "Heath93" };
const recipient = { id: "GjWovtg2hr", username: "Arvilla_Hegmann" };
const payload = {
  senderId: requester.id,
  receiverId: recipient.id,
  transactionType: "request",
  amount: "1",
  description: "Weekly discovery request",
};
const request = (method, path, body) => ({ method, url: origin + path, body });

test("weekly transaction check titles have separate allowlists of classified assertions", () => {
  assert.deepEqual(Object.keys(transactionAssertions), [
    "request-acceptance",
    "request-decline",
    "transaction-comment",
  ]);
  for (const [title, assertions] of Object.entries(transactionAssertions))
    assert.ok(assertions.length > 2 && assertions.every((id) => id.startsWith(title + "-")));
});

test("weekly browser writes require the exact loopback origin, fixture, path and one-shot intent", () => {
  const create = request("POST", "/api/transactions", payload);
  const flow = { create: true, active: requester.id };
  assert.equal(writeAlias(create, flow), "weeklyCreate");
  assert.equal(writeAlias({ ...create, body: { ...payload, amount: 1 } }, flow), "weeklyCreate");
  assert.equal(
    writeAlias({ ...create, url: create.url.replace(origin, "https://example.org") }, flow),
    undefined
  );
  assert.equal(writeAlias({ ...create, url: create.url + "?unused=1" }, flow), undefined);
  assert.equal(writeAlias({ ...create, body: { ...payload, amount: 2 } }, flow), undefined);
  assert.equal(
    writeAlias({ ...create, body: { ...payload, transactionType: "payment" } }, flow),
    undefined
  );
  assert.equal(writeAlias(create, { ...flow, create: false }), undefined);
  assert.equal(writeAlias(create, { ...flow, active: recipient.id }), undefined);
  assert.equal(writeAlias(create, { ...flow, create: true, active: undefined }), undefined);
  assert.equal(writeAlias(request("POST", "/api/users", {}), flow), undefined);

  const resolve = request("PATCH", "/api/transactions/test-fixture", {
    id: "test-fixture",
    requestStatus: "rejected",
  });
  const resolution = { id: "test-fixture", action: "rejected" };
  assert.equal(writeAlias(resolve, { resolution, active: recipient.id }), "weeklyResolve");
  assert.equal(writeAlias(resolve, { resolution, active: requester.id }), undefined);
  assert.equal(
    writeAlias(resolve, {
      resolution: { ...resolution, action: "accepted" },
      active: recipient.id,
    }),
    undefined
  );
  assert.equal(
    writeAlias(
      { ...resolve, body: { ...resolve.body, amount: 200 } },
      { resolution, active: recipient.id }
    ),
    undefined
  );

  const comment = { id: "1xfcAhNDZK4", text: "Weekly discovery test fixture" };
  const submit = request("POST", "/api/comments/" + comment.id, {
    transactionId: comment.id,
    content: comment.text,
  });
  assert.equal(writeAlias(submit, { comment, active: requester.id }), "weeklyComment");
  assert.equal(writeAlias(submit, { comment, active: recipient.id }), undefined);
  assert.equal(
    writeAlias(submit, { comment: { ...comment, text: "other" }, active: requester.id }),
    undefined
  );
});

test("only the seeded account login and bank account read query pass authentication setup", () => {
  const login = request("POST", "/api/login", {
    type: "LOGIN",
    username: recipient.username,
    password: "s3cret",
  });
  assert.equal(writeAlias(login, { login: recipient }), "weeklyLogin");
  assert.equal(writeAlias(login, { login: requester }), undefined);
  assert.equal(
    writeAlias({ ...login, body: { ...login.body, extra: true } }, { login: recipient }),
    undefined
  );
  const bankRead = request("POST", "/api/graphql", {
    operationName: "ListBankAccount",
    query: "query ListBankAccount { listBankAccount { bankName id } }",
    variables: {},
  });
  assert.equal(writeAlias(bankRead, { active: requester.id }), "weeklyBankRead");
  assert.equal(writeAlias(bankRead, {}), undefined);
  assert.equal(
    writeAlias(
      { ...bankRead, body: { ...bankRead.body, query: bankRead.body.query + " mutation { foo }" } },
      { active: requester.id }
    ),
    undefined
  );
});
