import { describe, expect, test } from "vitest";
import {
  isRequestTransaction,
  getFakeAmount,
  currentUserLikesTransaction,
  getQueryWithoutDateFields,
  getQueryWithoutAmountFields,
  getQueryWithoutFilterFields,
  getPublicTransactionsFeed,
  getPaginatedItems,
} from "../transactionUtils";
import { faker } from "@faker-js/faker";
import {
  Transaction,
  TransactionRequestStatus,
  DefaultPrivacyLevel,
  TransactionStatus,
  TransactionResponseItem,
} from "../../models";
import shortid from "shortid";

const fakeTransaction = (
  requestStatus?: TransactionRequestStatus,
  createdAt?: Date
): Transaction => ({
  id: shortid(),
  uuid: faker.datatype.uuid(),
  source: shortid(),
  amount: getFakeAmount(),
  description: "food",
  privacyLevel: DefaultPrivacyLevel.public,
  receiverId: shortid(),
  senderId: shortid(),
  balanceAtCompletion: getFakeAmount(),
  status: TransactionStatus.pending,
  requestStatus,
  requestResolvedAt: faker.date.future(),
  createdAt: faker.date.past(),
  modifiedAt: createdAt || faker.date.recent(),
});

describe("Transaction Utils", () => {
  describe("isRequestTransaction", () => {
    let transaction;

    test("validates that a transaction is a request", () => {
      for (let s in TransactionRequestStatus) {
        transaction = fakeTransaction(s as TransactionRequestStatus);
        expect(isRequestTransaction(transaction)).toBeTruthy();
      }
    });

    test("validates that a transaction is not a request", () => {
      transaction = fakeTransaction();
      expect(isRequestTransaction(transaction)).toBe(false);
    });

    test("checks if the current user likes a transaction", () => {
      const transactionBase = fakeTransaction();

      const currentUser = {
        id: "9IUK0xpw",
        uuid: faker.datatype.uuid(),
        firstName: faker.name.firstName(),
        lastName: faker.name.lastName(),
        username: faker.internet.userName(),
        password: "abc123",
        email: faker.internet.email(),
        phoneNumber: faker.phone.phoneNumber(),
        avatar: faker.internet.avatar(),
        defaultPrivacyLevel: DefaultPrivacyLevel.public,
        balance: faker.datatype.number(),
        createdAt: faker.date.past(),
        modifiedAt: faker.date.recent(),
      };

      const transactionWithLikes: TransactionResponseItem = {
        ...transactionBase,
        receiverName: "Receiver Name",
        receiverAvatar: "/path/to/receiver/avatar.png",
        senderAvatar: "/path/to/sender/avatar.png",
        senderName: "Sender Name",
        likes: [
          {
            id: "ExVksKSH",
            uuid: "c849329f-42f7-4ff5-a792-e01c9cec05b5",
            userId: "9IUK0xpw",
            transactionId: "dKAI-6Ua",
            createdAt: new Date(),
            modifiedAt: new Date(),
          },
        ],
        comments: [],
      };

      expect(currentUserLikesTransaction(currentUser, transactionWithLikes)).toBe(true);

      const otherCurrentUser = {
        ...currentUser,
        id: "ABC123",
      };

      expect(currentUserLikesTransaction(otherCurrentUser, transactionWithLikes)).toBe(false);
    });
  });

  test("gets query with and without date range fields", () => {
    expect(
      getQueryWithoutDateFields({
        dateRangeStart: new Date().toString(),
        dateRangeEnd: new Date().toString(),
        status: TransactionStatus.incomplete,
      })
    ).toMatchObject({ status: "incomplete" });
    expect(
      getQueryWithoutDateFields({
        status: TransactionStatus.incomplete,
      })
    ).toMatchObject({ status: "incomplete" });
  });

  test("gets query with and without amount range fields", () => {
    expect(
      getQueryWithoutAmountFields({
        amountMin: 5,
        amountMax: 10,
        status: TransactionStatus.incomplete,
      })
    ).toMatchObject({ status: "incomplete" });
    expect(
      getQueryWithoutAmountFields({
        status: TransactionStatus.incomplete,
      })
    ).toMatchObject({ status: "incomplete" });
  });

  test("gets query with and without date and amount range fields", () => {
    const query = {
      amountMin: 5,
      amountMax: 10,
      requestStatus: "pending",
      dateRangeStart: "2019-12-01T06:00:00.000Z",
      dateRangeEnd: "2019-12-05T06:00:00.000Z",
    };
    expect(getQueryWithoutFilterFields(query)).toMatchObject({
      requestStatus: "pending",
    });
    expect(
      getQueryWithoutFilterFields({
        status: TransactionStatus.incomplete,
      })
    ).toMatchObject({ status: "incomplete" });
  });

  describe("public transaction feed pagination (GET /transactions/public)", () => {
    const makeIds = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);

    const paginateFeed = (
      contactsTransactions: string[],
      publicTransactions: string[],
      page: number,
      limit: number
    ) =>
      getPaginatedItems(
        page,
        limit,
        getPublicTransactionsFeed(contactsTransactions, publicTransactions)
      );

    test("paginates the same ordered feed on every page, returning each of the 25 eligible records exactly once", () => {
      const contactsTransactions = makeIds("C", 5);
      const publicTransactions = makeIds("P", 20);
      const limit = 10;

      const page1 = paginateFeed(contactsTransactions, publicTransactions, 1, limit);
      const page2 = paginateFeed(contactsTransactions, publicTransactions, 2, limit);
      const page3 = paginateFeed(contactsTransactions, publicTransactions, 3, limit);

      expect(page1.data).toEqual([...makeIds("C", 5), ...makeIds("P", 5)]);
      expect(page2.data).toEqual(
        Array.from({ length: 10 }, (_, i) => `P${i + 6}`) // P6-P15
      );
      expect(page3.data).toEqual(
        Array.from({ length: 5 }, (_, i) => `P${i + 16}`) // P16-P20
      );

      expect(page1.totalPages).toBe(3);
      expect(page2.totalPages).toBe(3);
      expect(page3.totalPages).toBe(3);

      const allReturned = [...page1.data, ...page2.data, ...page3.data];
      expect(allReturned).toHaveLength(25);
      expect(new Set(allReturned).size).toBe(25);
    });

    test("caps contacts' transactions at five regardless of how many a user has", () => {
      const contactsTransactions = makeIds("C", 7);
      const publicTransactions = makeIds("P", 3);

      const feed = getPublicTransactionsFeed(contactsTransactions, publicTransactions);

      expect(feed).toEqual([...makeIds("C", 5), ...makeIds("P", 3)]);
    });

    test("includes all contacts' transactions when there are fewer than five", () => {
      const contactsTransactions = makeIds("C", 2);
      const publicTransactions = makeIds("P", 3);

      const feed = getPublicTransactionsFeed(contactsTransactions, publicTransactions);

      expect(feed).toEqual([...makeIds("C", 2), ...makeIds("P", 3)]);
    });

    test("falls back to public transactions only when there are zero contacts' transactions", () => {
      const contactsTransactions: string[] = [];
      const publicTransactions = makeIds("P", 3);

      const feed = getPublicTransactionsFeed(contactsTransactions, publicTransactions);

      expect(feed).toEqual(makeIds("P", 3));
    });
  });
});
