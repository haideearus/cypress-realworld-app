// @vitest-environment node

import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import transactionRoutes from "../../backend/transaction-routes";
import { seedDatabase, stateAccess } from "../../backend/database";
import { DefaultPrivacyLevel, TransactionStatus } from "../models";
import type { Transaction, User } from "../models";

describe("GET /transactions/:transactionId private isolation", () => {
  let server: Server;
  let origin: string;
  let sessionUser: User;
  let sender: User;
  let receiver: User;
  let outsider: User;
  let privateTransactionId: string;
  const originalState = stateAccess.read();

  beforeAll(async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = sessionUser;
      req.isAuthenticated = (() => true) as typeof req.isAuthenticated;
      next();
    });
    app.use("/transactions", transactionRoutes);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    seedDatabase();
    const state = stateAccess.read();
    [sender, receiver, outsider] = state.users;
    privateTransactionId = "private-isolation-fixture";
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const privateTransaction: Transaction = {
      id: privateTransactionId,
      uuid: privateTransactionId,
      source: "",
      amount: 100,
      description: "private isolation fixture",
      privacyLevel: DefaultPrivacyLevel.private,
      receiverId: receiver.id,
      senderId: sender.id,
      status: TransactionStatus.complete,
      createdAt,
      modifiedAt: createdAt,
    };
    stateAccess.replace({
      ...state,
      transactions: [...state.transactions, privateTransaction],
    });
  });

  afterAll(async () => {
    stateAccess.replace(originalState);
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  async function getTransaction() {
    return fetch(`${origin}/transactions/${privateTransactionId}`, {
      signal: AbortSignal.timeout(5000),
    });
  }

  it("allows the sender to read their own private transaction", async () => {
    sessionUser = sender;
    const response = await getTransaction();
    expect(response.status).toBe(200);
  });

  it("allows the receiver to read their own private transaction", async () => {
    sessionUser = receiver;
    const response = await getTransaction();
    expect(response.status).toBe(200);
  });

  it("denies a user who is neither sender nor receiver", async () => {
    sessionUser = outsider;
    const response = await getTransaction();
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.transaction).toBeUndefined();
  });
});
