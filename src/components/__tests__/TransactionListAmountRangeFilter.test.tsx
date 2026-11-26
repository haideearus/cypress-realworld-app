import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TransactionListAmountRangeFilter from "../TransactionListAmountRangeFilter";

describe("TransactionListAmountRangeFilter clear action", () => {
  test("exposes an accessible name identifying the amount range filter", () => {
    render(
      <TransactionListAmountRangeFilter
        filterAmountRange={vi.fn()}
        amountRangeFilters={{}}
        resetAmountRange={vi.fn()}
      />
    );

    fireEvent.click(
      document.querySelector('[data-test="transaction-list-filter-amount-range-button"]')!
    );

    expect(screen.getByRole("button", { name: "Clear amount range" })).toBeInTheDocument();
  });

  test("activating the clear action resets only the amount filter", () => {
    const resetAmountRange = vi.fn();
    render(
      <TransactionListAmountRangeFilter
        filterAmountRange={vi.fn()}
        amountRangeFilters={{}}
        resetAmountRange={resetAmountRange}
      />
    );

    fireEvent.click(
      document.querySelector('[data-test="transaction-list-filter-amount-range-button"]')!
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear amount range" }));

    expect(resetAmountRange).toHaveBeenCalledTimes(1);
  });
});
