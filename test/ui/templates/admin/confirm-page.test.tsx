import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ConfirmPage,
  warningDeletePage,
} from "#templates/admin/confirm-page.tsx";
import type { AdminSession } from "#types";

const OWNER: AdminSession = {
  adminLevel: "owner",
};

const renderConfirmation = (disabled = false): string =>
  ConfirmPage({
    action: "/admin/people/1/refund",
    active: "/admin/people",
    buttonText: "Send refund",
    children: <p>Payment details</p>,
    disabled,
    error: disabled ? "A refund is already moving" : undefined,
    heading: "Check payment",
    label: "Person name",
    name: "Alice Example",
    returnUrl: "/admin/people/1/actions",
    session: OWNER,
    title: "Refund Alice Example",
    warning: <p>Money will be returned.</p>,
  });

describe("ConfirmPage", () => {
  test("uses an explicitly blank warning-page title", () => {
    const html = warningDeletePage("/admin/people")(
      {
        action: "/admin/people/1/delete",
        buttonText: "Delete",
        heading: "Delete Alice",
        label: "Person name",
        name: "Alice Example",
        prompt: {
          args: { name: "Alice Example" },
          key: "admin.attendees.delete_confirm",
        },
        title: "",
        warning: <p>Permanent.</p>,
      },
      OWNER,
    );

    expect(html).toContain("<title></title>");
    expect(html).toContain("<h1>Delete Alice</h1>");
  });

  test("renders the real confirmation form while the action is available", () => {
    const html = renderConfirmation();

    expect(html).toContain('action="/admin/people/1/refund"');
    expect(html).toContain('name="confirm_identifier"');
    expect(html).toContain('placeholder="Alice Example"');
    expect(html).toContain("Send refund");
    expect(html).toContain("Money will be returned.");
    expect(html).toContain("<h1>Check payment</h1>");
    expect(html).toContain("Payment details");
  });

  test("renders the blocked explanation without any usable form", () => {
    const html = renderConfirmation(true);

    expect(html).toContain("A refund is already moving");
    expect(html).toContain("Payment details");
    expect(html).not.toContain("<form");
    expect(html).not.toContain('name="confirm_identifier"');
    expect(html).not.toContain("Send refund");
    expect(html).not.toContain("Money will be returned.");
  });
});
