// @vitest-environment node

import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import paginate from "express-paginate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import transactionRoutes from "../../backend/transaction-routes";
import { seedDatabase, stateAccess } from "../../backend/database";
import { DefaultPrivacyLevel, TransactionStatus } from "../models";
import type { Transaction, User } from "../models";

type PublicFeedResponse = {
  pageData: { page: number; limit: number; totalPages: number; hasNextPages: boolean };
  results: { id: string }[];
};

describe("GET /transactions/public pagination", () => {
  let server: Server;
  let origin: string;
  let sessionUser: User;
  const originalState = stateAccess.read();

  beforeAll(async () => {
    const app = express();
    // Supply a local session identity; keep the real route/auth/validation middleware.
    app.use((req, _res, next) => {
      req.user = sessionUser;
      req.isAuthenticated = (() => true) as typeof req.isAuthenticated;
      next();
    });
    app.use(paginate.middleware(10));
    app.use("/transactions", transactionRoutes);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

  function setFixture(contactCount: number) {
    // Vitest uses the real in-memory database adapter; no database queries are mocked.
    seedDatabase();
    const state = stateAccess.read();
    const [viewer, contact, sender, receiver] = state.users;
    sessionUser = viewer;
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const makeTransaction = (id: string, senderId: string, index: number): Transaction => ({
      id,
      uuid: `fixture-${id}`,
      source: "",
      amount: 100,
      description: id,
      privacyLevel: DefaultPrivacyLevel.public,
      receiverId: receiver.id,
      senderId,
      status: TransactionStatus.complete,
      createdAt,
      modifiedAt: new Date(createdAt.getTime() - index * 1000),
    });
    const contacts = Array.from({ length: contactCount }, (_, index) =>
      makeTransaction(`C${index + 1}`, contact.id, index)
    );
    const publicTransactions = Array.from({ length: 20 }, (_, index) =>
      makeTransaction(`P${index + 1}`, sender.id, index)
    );
    stateAccess.replace({
      ...state,
      users: [viewer, contact, sender, receiver],
      contacts: [
        {
          id: "fixture-contact",
          uuid: "fixture-contact",
          userId: viewer.id,
          contactUserId: contact.id,
          createdAt,
          modifiedAt: createdAt,
        },
      ],
      transactions: [
        ...contacts,
        ...publicTransactions,
        {
          ...makeTransaction("private-record", sender.id, 0),
          privacyLevel: DefaultPrivacyLevel.private,
        },
      ],
      likes: [],
      comments: [],
      notifications: [],
    });
  }

  it.each([
    {
      contactCount: 5,
      pages: [
        "C1 C2 C3 C4 C5 P1 P2 P3 P4 P5",
        "P6 P7 P8 P9 P10 P11 P12 P13 P14 P15",
        "P16 P17 P18 P19 P20",
      ],
    },
    {
      contactCount: 0,
      pages: ["P1 P2 P3 P4 P5 P6 P7 P8 P9 P10", "P11 P12 P13 P14 P15 P16 P17 P18 P19 P20"],
    },
    {
      contactCount: 2,
      pages: ["C1 C2 P1 P2 P3 P4 P5 P6 P7 P8", "P9 P10 P11 P12 P13 P14 P15 P16 P17 P18", "P19 P20"],
    },
    {
      contactCount: 7,
      pages: [
        "C1 C2 C3 C4 C5 P1 P2 P3 P4 P5",
        "P6 P7 P8 P9 P10 P11 P12 P13 P14 P15",
        "P16 P17 P18 P19 P20",
      ],
    },
  ])(
    "returns every eligible record once with $contactCount contact transactions",
    async (fixture) => {
      setFixture(fixture.contactCount);
      const responses: PublicFeedResponse[] = [];
      for (let page = 1; page <= fixture.pages.length; page++) {
        const response = await fetch(`${origin}/transactions/public?page=${page}&limit=10`, {
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status).toBe(200);
        responses.push((await response.json()) as PublicFeedResponse);
      }

      const returnedPages = responses.map((response) => response.results.map((item) => item.id));
      // These hand-derived expectations do not call the pagination/feed helpers.
      expect(returnedPages).toEqual(fixture.pages.map((page) => page.split(" ")));
      expect(responses.map((response) => response.pageData)).toEqual(
        fixture.pages.map((_, index) => ({
          page: index + 1,
          limit: 10,
          totalPages: fixture.pages.length,
          hasNextPages: index < fixture.pages.length - 1,
        }))
      );
      const allIds = returnedPages.flat();
      expect(new Set(allIds).size).toBe(allIds.length);
      expect(allIds).not.toContain("private-record");
    }
  );
});
