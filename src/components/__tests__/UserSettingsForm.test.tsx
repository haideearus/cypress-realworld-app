import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import UserSettingsForm from "../UserSettingsForm";
import { User, DefaultPrivacyLevel } from "../../models";

const userProfile: User = {
  id: "t45AiwidW",
  uuid: "6383f84e-b511-44c5-a835-3ece1d781fa8",
  firstName: "Edgar",
  lastName: "Johns",
  username: "Katharina_Bernier",
  password: "secret",
  email: "edgar@example.com",
  phoneNumber: "6155551212",
  avatar: "https://example.com/avatar.svg",
  defaultPrivacyLevel: DefaultPrivacyLevel.public,
  balance: 0,
  createdAt: new Date(),
  modifiedAt: new Date(),
};

const getPhoneNumberInput = () =>
  document.querySelector('[data-test="user-settings-phoneNumber-input"]') as HTMLInputElement;

const getSubmitButton = () =>
  document.querySelector('[data-test="user-settings-submit"]') as HTMLButtonElement;

const setPhoneNumber = (value: string) => {
  const input = getPhoneNumberInput();
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

describe("UserSettingsForm phone number validation", () => {
  test.each(["6155551212", "615-555-1212", "+1 615-555-1212", "(615) 555-1212"])(
    "accepts %s and enables Save when other fields are valid",
    async (phoneNumber) => {
      render(<UserSettingsForm userProfile={userProfile} updateUser={vi.fn()} />);

      setPhoneNumber(phoneNumber);

      await waitFor(() => {
        expect(getSubmitButton()).not.toBeDisabled();
      });
      expect(screen.queryByText("Phone number is not valid")).not.toBeInTheDocument();
    }
  );

  test.each(["\\1 615-555-1212", "abc-def-ghij", "615-555-", ""])(
    "rejects %s and keeps Save disabled",
    async (phoneNumber) => {
      render(<UserSettingsForm userProfile={userProfile} updateUser={vi.fn()} />);

      setPhoneNumber(phoneNumber);

      await waitFor(() => {
        expect(getSubmitButton()).toBeDisabled();
      });
    }
  );

  test("submits the updated phone number when valid", async () => {
    const updateUser = vi.fn();
    render(<UserSettingsForm userProfile={userProfile} updateUser={updateUser} />);

    setPhoneNumber("(615) 555-1212");

    const submitButton = getSubmitButton();
    await waitFor(() => expect(submitButton).not.toBeDisabled());

    fireEvent.click(submitButton);

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    expect(updateUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: userProfile.id, phoneNumber: "(615) 555-1212" })
    );
  });
});
