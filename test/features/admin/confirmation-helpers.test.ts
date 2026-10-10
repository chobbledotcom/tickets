/**
 * Typed-name confirmation helpers: the checks for what an operator typed.
 * This mirror is what the mutation gate runs against.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resetI18nForTest, t } from "#i18n";
import {
  verifyIdentifier,
  verifyIdentifierOrJsonError,
  verifyOrRedirect,
} from "#routes/admin/confirmation.ts";
import { FormParams } from "#shared/form-data.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";

describeWithEnv("typed-name confirmation", { db: true }, () => {
  describe("verifyIdentifier", () => {
    test("matches across case and surrounding space", () => {
      expect(verifyIdentifier("Test Listing", "test listing")).toBe(true);
      expect(verifyIdentifier("  Test  ", "test")).toBe(true);
    });

    test("rejects a different name", () => {
      expect(verifyIdentifier("Test", "Other")).toBe(false);
    });
  });

  describe("verifyOrRedirect", () => {
    test("returns null when the typed name matches", () => {
      const form = new FormParams({ confirm_identifier: "Test Listing" });

      expect(verifyOrRedirect(form, "Test Listing", "/admin/test")).toBeNull();
    });

    test("redirects with the label and no action suffix on mismatch", () => {
      const form = new FormParams({ confirm_identifier: "Wrong" });

      const result = verifyOrRedirect(form, "Test Listing", "/admin/test")!;
      expect(result.status).toBe(302);
      expect(result.headers.get("location")).toContain("/admin/test");
      expectFlash(
        result,
        "Name does not match. Please type the exact name to confirm.",
        false,
      );
    });

    test("redirects with the label and action suffix on mismatch", () => {
      const form = new FormParams({ confirm_identifier: "Wrong" });

      const result = verifyOrRedirect(
        form,
        "Test Listing",
        "/admin/test",
        "Listing name",
        "deletion",
      )!;
      expectFlash(
        result,
        "Listing name does not match. Please type the exact listing name to confirm deletion.",
        false,
      );
    });

    test("rebrands the confirm label through the catalog", () => {
      using _env = withEnv({ I18N_REPLACEMENTS: "attendee|guest" });
      resetI18nForTest();
      try {
        const result = verifyOrRedirect(
          new FormParams({ confirm_identifier: "Wrong" }),
          "Test Listing",
          "/admin/test",
          t("attendees.name_label"),
        )!;
        expectFlash(
          result,
          "Guest name does not match. Please type the exact guest name to confirm.",
          false,
        );
      } finally {
        resetI18nForTest();
      }
    });
  });

  describe("verifyIdentifierOrJsonError", () => {
    test("returns null on a match", () => {
      expect(verifyIdentifierOrJsonError("Test", "Test")).toBeNull();
    });

    test("returns the label's message on a mismatch", () => {
      const error = verifyIdentifierOrJsonError(
        "Test Listing",
        "Wrong",
        "Listing name",
      )!;
      expect(error).toBe(
        "Listing name does not match. Please provide the exact listing name in confirm_identifier.",
      );
    });

    test("names the field Name when no label is given", () => {
      expect(verifyIdentifierOrJsonError("Test", null)).toBe(
        "Name does not match. Please provide the exact name in confirm_identifier.",
      );
    });

    test("treats a value that is not a string as a mismatch", () => {
      expect(
        verifyIdentifierOrJsonError("Test", { not: "a string" }),
      ).toContain("does not match");
    });
  });
});
