import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import {
  ConfirmPage,
  warningDeletePage,
} from "#templates/admin/confirm-page.tsx";
import { says } from "#test-utils/says.ts";
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

    says(html, "<title></title>");
    says(html, "<h1>Delete Alice</h1>");
  });

  test("renders the real confirmation form while the action is available", () => {
    const html = renderConfirmation();

    says(html, 'action="/admin/people/1/refund"');
    says(html, 'name="confirm_identifier"');
    says(html, 'placeholder="Alice Example"');
    says(html, "Send refund");
    says(html, "Money will be returned.");
    says(html, "<h1>Check payment</h1>");
    says(html, "Payment details");
  });

  test("renders the blocked explanation without any usable form", () => {
    const html = renderConfirmation(true);

    says(html, "A refund is already moving");
    says(html, "Payment details");
    assert(!html.includes("<form"));
    assert(!html.includes('name="confirm_identifier"'));
    assert(!html.includes("Send refund"));
    assert(!html.includes("Money will be returned."));
  });
});
