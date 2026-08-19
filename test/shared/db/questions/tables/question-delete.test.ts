// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createQuestion } from "#test-utils/questions/helpers.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server (admin questions)", { db: true }, () => {
  describe("GET /admin/questions/:id/delete", () => {
    testRequiresAuth("/admin/questions/1/delete", {
      setup: async () => {
        await createQuestion("Delete me");
      },
    });

    test("returns 404 for non-existent question", async () => {
      const response = await adminGet("/admin/questions/999/delete");
      expectStatus(404)(response);
    });

    test("shows delete confirmation page", async () => {
      const id = await createQuestion("To be deleted");
      const response = await adminGet(`/admin/questions/${id}/delete`);
      await expectHtmlResponse(
        response,
        200,
        "To be deleted",
        "confirm_identifier",
      );
    });
  });

  describe("POST /admin/questions/:id/delete", () => {
    testRequiresAuth("/admin/questions/1/delete", {
      body: {
        confirm_identifier: "Auth delete",
      },
      method: "POST",
      setup: async () => {
        await createQuestion("Auth delete");
      },
    });

    test("deletes question with correct text confirmation", async () => {
      const id = await createQuestion("Confirm Delete");
      const { response } = await adminFormPost(
        `/admin/questions/${id}/delete`,
        { confirm_identifier: "Confirm Delete" },
      );
      await expectFlashRedirect(
        "/admin/questions",
        "Question deleted",
      )(response);

      // Verify it's gone
      const { questionsTable } = await import("#db/questions/tables.ts");
      const found = await questionsTable.read.one({ id: id });
      expect(found).toBeNull();
    });

    test("deletes a multiline question via its flattened confirmation text", async () => {
      // A question editor is a textarea, so the text can contain newlines. The
      // confirmation page (and the single-line confirm input) shows the
      // flattened "Line 1 / Line 2" form, so deletion must verify against that
      // — not the raw newline text the operator cannot type.
      const id = await createQuestion("Line 1\nLine 2");
      const { response } = await adminFormPost(
        `/admin/questions/${id}/delete`,
        { confirm_identifier: "Line 1 / Line 2" },
      );
      await expectFlashRedirect(
        "/admin/questions",
        "Question deleted",
      )(response);

      const { questionsTable } = await import("#db/questions/tables.ts");
      expect(await questionsTable.read.one({ id: id })).toBeNull();
    });

    test("rejects deletion with wrong text", async () => {
      const id = await createQuestion("Right Text");
      const { response } = await adminFormPost(
        `/admin/questions/${id}/delete`,
        { confirm_identifier: "Wrong Text" },
      );
      expect(response.status).toBe(302);
      // The mismatch prompt names the identifier's label ("Question text"), so
      // an emptied label would leave a nameless " does not match" message.
      expectFlash(
        response,
        expect.stringContaining("Question text does not match"),
        false,
      );

      // Verify still exists
      const { questionsTable } = await import("#db/questions/tables.ts");
      const found = await questionsTable.read.one({ id: id });
      expect(found).not.toBeNull();
    });

    test("returns 404 for non-existent question", async () => {
      const { response } = await adminFormPost("/admin/questions/999/delete", {
        confirm_identifier: "Anything",
      });
      expectStatus(404)(response);
    });

    test("confirmation is case-insensitive", async () => {
      const id = await createQuestion("Case Test");
      const { response } = await adminFormPost(
        `/admin/questions/${id}/delete`,
        { confirm_identifier: "case test" },
      );
      await expectFlashRedirect(
        "/admin/questions",
        "Question deleted",
      )(response);
    });

    test("rejects deletion when confirm_identifier is missing", async () => {
      const id = await createQuestion("No Confirm");
      const { response } = await adminFormPost(
        `/admin/questions/${id}/delete`,
        {},
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("to confirm deletion"),
        false,
      );
    });
  });
});
