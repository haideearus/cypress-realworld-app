import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TransactionDetail from "../TransactionDetail";
import {
  TransactionResponseItem,
  TransactionStatus,
  User,
  DefaultPrivacyLevel,
} from "../../models";

const currentUser: User = {
  id: "user-1",
  uuid: "1b1b1b1b-1b1b-1b1b-1b1b-1b1b1b1b1b1b",
  firstName: "Alice",
  lastName: "Sender",
  username: "alice",
  password: "secret",
  email: "alice@example.com",
  phoneNumber: "6155551212",
  avatar: "https://example.com/avatar.svg",
  defaultPrivacyLevel: DefaultPrivacyLevel.public,
  balance: 0,
  createdAt: new Date(),
  modifiedAt: new Date(),
};

const transaction: TransactionResponseItem = {
  id: "transaction-1",
  uuid: "2b2b2b2b-2b2b-2b2b-2b2b-2b2b2b2b2b2b",
  source: "",
  amount: 1000,
  description: "Lunch",
  privacyLevel: DefaultPrivacyLevel.public,
  receiverId: "user-2",
  senderId: currentUser.id,
  status: TransactionStatus.complete,
  createdAt: new Date(),
  modifiedAt: new Date(),
  likes: [],
  comments: [],
  receiverName: "Bob Receiver",
  receiverAvatar: "https://example.com/bob.svg",
  senderName: "Alice Sender",
  senderAvatar: "https://example.com/alice.svg",
};

describe("TransactionDetail Like button", () => {
  test("has an accessible name of 'Like transaction'", () => {
    render(
      <TransactionDetail
        transaction={transaction}
        transactionLike={vi.fn()}
        transactionComment={vi.fn()}
        transactionUpdate={vi.fn()}
        currentUser={currentUser}
      />
    );

    expect(screen.getByRole("button", { name: "Like transaction" })).toBeInTheDocument();
  });

  test("Like button click behavior and disabled state are preserved", () => {
    const transactionLike = vi.fn();
    const { rerender } = render(
      <TransactionDetail
        transaction={transaction}
        transactionLike={transactionLike}
        transactionComment={vi.fn()}
        transactionUpdate={vi.fn()}
        currentUser={currentUser}
      />
    );

    const likeButton = screen.getByRole("button", { name: "Like transaction" });
    expect(likeButton).not.toBeDisabled();

    likeButton.click();
    expect(transactionLike).toHaveBeenCalledWith(transaction.id);

    const likedTransaction: TransactionResponseItem = {
      ...transaction,
      likes: [
        {
          id: "like-1",
          uuid: "3b3b3b3b-3b3b-3b3b-3b3b-3b3b3b3b3b3b",
          userId: currentUser.id,
          transactionId: transaction.id,
          createdAt: new Date(),
          modifiedAt: new Date(),
        },
      ],
    };

    rerender(
      <TransactionDetail
        transaction={likedTransaction}
        transactionLike={transactionLike}
        transactionComment={vi.fn()}
        transactionUpdate={vi.fn()}
        currentUser={currentUser}
      />
    );

    expect(screen.getByRole("button", { name: "Like transaction" })).toBeDisabled();
  });
});
