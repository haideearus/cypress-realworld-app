import React from "react";
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { interpret } from "xstate";
import NavBar from "../NavBar";
import { dataMachine } from "../../machines/dataMachine";

function renderNavBar() {
  const notificationsService = interpret(dataMachine("notifications")).start();

  render(
    <MemoryRouter>
      <NavBar
        drawerOpen={false}
        toggleDrawer={() => {}}
        notificationsService={notificationsService as any}
      />
    </MemoryRouter>
  );
}

describe("NavBar notifications link", () => {
  test("has an accessible name of 'Notifications'", () => {
    renderNavBar();

    const link = screen.getByRole("link", { name: "Notifications" });
    expect(link).toHaveAttribute("href", "/notifications");
  });
});
