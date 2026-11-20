/**
 * Typed-name confirmation helpers: the checks for what an operator typed.
 * This mirror is what the mutation gate runs against.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resetI18nForTest, t } from "#i18n";
import {
  verifiedDelete,
  verifyIdentifier,
  verifyIdentifierOrJsonError,
  verifyOrRedirect,
} from "#routes/admin/confirmation.ts";
import type { AuthSession } from "#routes/auth.ts";
import type { AuthedHandlerArgs } from "#shared/app-forms.ts";
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
      const form = new FormParams({ confirmIdentifier: "Test Listing" });

      expect(verifyOrRedirect(form, "Test Listing", "/admin/test")).toBeNull();
    });

    test("redirects with the label and no action suffix on mismatch", () => {
      const form = new FormParams({ confirmIdentifier: "Wrong" });

      const result = verifyOrRedirect(form, "Test Listing", "/admin/test")!;
      expect(result.status).toBe(302);
      assertStringIncludes(result.headers.get("location") ?? "", "/admin/test");
      expectFlash(
        result,
        "Name does not match. Please type the exact name to confirm.",
        false,
      );
    });

    test("redirects with the label and action suffix on mismatch", () => {
      const form = new FormParams({ confirmIdentifier: "Wrong" });

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
          new FormParams({ confirmIdentifier: "Wrong" }),
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
      assertStringIncludes(
        verifyIdentifierOrJsonError("Test", { not: "a string" }) ?? "",
        "does not match",
      );
    });
  });

  describe("verifiedDelete", () => {
    const stepArgs = (
      context: string,
    ): AuthedHandlerArgs<unknown, string> => ({
      context,
      form: new FormParams({}),
      params: undefined,
      session: {} as AuthSession,
    });

    test("deletes the record, then redirects with a success flash", async () => {
      const deleted: string[] = [];
      const step = verifiedDelete<string>(
        (context) => {
          deleted.push(context);
          return Promise.resolve();
        },
        (context) => `/admin/${context}`,
        () => "Thing deleted.",
      );

      const response = await step(stepArgs("things"));

      expect(deleted).toEqual(["things"]);
      expect(response.status).toBe(302);
      assertStringIncludes(
        response.headers.get("location") ?? "",
        "/admin/things",
      );
      expectFlash(response, "Thing deleted.", true);
    });

    test("takes a plain text flash message as well as a getter", async () => {
      const step = verifiedDelete<string>(
        () => Promise.resolve(),
        () => "/admin/things",
        "Gone.",
      );

      expectFlash(await step(stepArgs("things")), "Gone.", true);
    });
  });
});
