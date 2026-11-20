import React from "react";
import { describe, expect, test, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Machine, interpret } from "xstate";
import UserOnboardingContainer from "../UserOnboardingContainer";
import { bankAccountsMachine } from "../../machines/bankAccountsMachine";
import { httpClient } from "../../utils/asyncUtils";

vi.mock("../../utils/asyncUtils", () => ({
  httpClient: { post: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const testBank = {
  bankName: "Discovery Demo Bank",
  accountNumber: "000000001",
  routingNumber: "000000000",
};

const authFixtureMachine = Machine({
  id: "authFixture",
  initial: "authorized",
  context: { user: { id: "onboarding-user" } },
  states: { authorized: {} },
});

function selector(id: string) {
  return `[data-test="${id}"]`;
}

function fillBankForm() {
  for (const [field, value] of Object.entries(testBank)) {
    const input = document.querySelector(
      `${selector(`bankaccount-${field}-input`)} input`
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  }
  fireEvent.click(document.querySelector(selector("bankaccount-submit")) as HTMLButtonElement);
}

function renderOnboarding() {
  const authService = interpret(authFixtureMachine).start();
  const bankAccountsService = interpret(bankAccountsMachine).start();

  render(
    <MemoryRouter>
      <UserOnboardingContainer
        authService={authService as any}
        bankAccountsService={bankAccountsService as any}
      />
    </MemoryRouter>
  );
}

describe("UserOnboardingContainer bank account save rejection", () => {
  test("stays on the bank account step with a visible error when the save is rejected, and succeeds on retry", async () => {
    let created = false;

    (httpClient.post as any).mockImplementation(async (_url: string, body: any) => {
      if (body.operationName === "ListBankAccount") {
        const listBankAccount = created ? [{ id: "created-1", ...testBank }] : [];
        return { data: { data: { listBankAccount } } };
      }
      if (body.operationName === "CreateBankAccount") {
        if (!created) {
          return {
            data: {
              data: { createBankAccount: null },
              errors: [{ message: "Test save rejected" }],
            },
          };
        }
        return { data: { data: { createBankAccount: { id: "created-1", ...testBank } } } };
      }
      throw new Error(`Unexpected operation ${body.operationName}`);
    });

    renderOnboarding();

    await waitFor(() =>
      expect(document.querySelector(selector("user-onboarding-dialog-title"))).toBeTruthy()
    );

    fireEvent.click(document.querySelector(selector("user-onboarding-next")) as HTMLButtonElement);

    await waitFor(() => expect(document.querySelector(selector("bankaccount-form"))).toBeTruthy());

    fillBankForm();

    await waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent?.trim()).toBeTruthy();
    });

    const title = document.querySelector(selector("user-onboarding-dialog-title"));
    expect(title?.textContent).not.toEqual("Finished");
    expect(document.querySelector(selector("bankaccount-form"))).toBeTruthy();

    created = true;
    fillBankForm();

    await waitFor(() => {
      const refreshedTitle = document.querySelector(selector("user-onboarding-dialog-title"));
      expect(refreshedTitle?.textContent).toEqual("Finished");
    });
  });
});
