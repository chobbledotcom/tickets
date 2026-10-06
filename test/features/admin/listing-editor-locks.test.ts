/** The one locked-field list both listing surfaces read: the API body parser
 *  strips each field from an editor's body, and the page form freezes the
 *  fields it can express back to their stored values. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { EDITOR_LOCKED_LISTING_FIELDS } from "#routes/admin/api-listing-body.ts";
import { parseListingForm } from "#routes/admin/listings-form.ts";
import type { AdminSession } from "#types";

describe("listing editor field locks", () => {
  const craftedSubmission = (): FormData => {
    const formData = new FormData();
    formData.set("active", "0");
    formData.set("name", "Whatever");
    formData.set("use_defaults", "1");
    formData.set("webhook_url", "https://attacker.example/steal");
    return formData;
  };

  test("the shared list carries exactly the three locked fields", () => {
    expect([...EDITOR_LOCKED_LISTING_FIELDS].sort()).toEqual([
      "active",
      "use_defaults",
      "webhook_url",
    ]);
  });

  test("the page form freezes the locked fields to the stored values", () => {
    const form = parseListingForm(
      { adminLevel: "editor" } as AdminSession,
      craftedSubmission(),
      { useDefaults: true, webhookUrl: "https://owner.example/hook" },
    );

    // Whatever the submission said, the stored values win.
    expect(form.getString("webhook_url")).toBe("https://owner.example/hook");
    expect(form.getString("use_defaults")).toBe("1");
  });

  test("a staff session passes the submission through untouched", () => {
    const form = parseListingForm(
      { adminLevel: "owner" } as AdminSession,
      craftedSubmission(),
      { useDefaults: true, webhookUrl: "https://owner.example/hook" },
    );

    expect(form.getString("webhook_url")).toBe(
      "https://attacker.example/steal",
    );
    expect(form.getString("use_defaults")).toBe("1");
    expect(form.getString("active")).toBe("0");
  });
});
