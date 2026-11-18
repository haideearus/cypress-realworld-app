import type { Request, RequestHandler, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { registerGet, findForUser } = vi.hoisted(() => ({
  registerGet: vi.fn(),
  findForUser: vi.fn(),
}));

vi.mock("express", () => ({
  default: { Router: () => ({ get: registerGet, post: vi.fn(), delete: vi.fn() }) },
}));
vi.mock("../../backend/database", () => ({
  getBankAccountById: () => undefined,
  getBankAccountForUser: findForUser,
}));
vi.mock("../../backend/helpers", () => ({
  ensureAuthenticated: vi.fn(),
  validateMiddleware: vi.fn(),
}));

import "../../backend/bankaccount-routes";

describe("Bank account detail handler", () => {
  const handler: RequestHandler = registerGet.mock.calls
    .find(([path]) => path === "/:bankAccountId")
    ?.at(-1);
  const account = { id: "fixture-account", userId: "fixture-owner" };

  beforeEach(() => {
    findForUser.mockReset();
  });

  function readAccount(userId?: string) {
    const req = {
      params: { bankAccountId: account.id },
      user: userId ? { id: userId } : undefined,
    };
    const res = { status: vi.fn(), json: vi.fn(), sendStatus: vi.fn() };
    handler(req as unknown as Request, res as unknown as Response, vi.fn());
    return res;
  }

  it("uses the signed-in owner when looking up the account", () => {
    findForUser.mockReturnValue(account);
    const res = readAccount(account.userId);

    expect(findForUser).toHaveBeenCalledExactlyOnceWith(account.id, account.userId);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ account });
  });

  it("returns 404 when the owner-scoped lookup has no match", () => {
    const res = readAccount("fixture-requester");

    expect(findForUser).toHaveBeenCalledExactlyOnceWith(account.id, "fixture-requester");
    expect(res.sendStatus).toHaveBeenCalledExactlyOnceWith(404);
    expect(res.json).not.toHaveBeenCalled();
  });

  it("rejects a session without a user ID before looking up any account", () => {
    const res = readAccount();

    expect(findForUser).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledExactlyOnceWith(401);
    expect(res.json).not.toHaveBeenCalled();
  });
});
