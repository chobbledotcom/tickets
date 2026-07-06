import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  getAllModifiers,
  getModifierAnswerIds,
  modifierGroups,
  modifierListings,
} from "#shared/db/modifiers.ts";
import { answersTable, questionsTable } from "#shared/db/questions.ts";
import { normalizeCode } from "#shared/price-modifier.ts";
import {
  adminFormPost,
  adminGet,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
} from "#test-utils";
import { createData, lastModifier } from "./helpers.ts";

describeWithEnv("server (admin modifiers)", { db: true }, () => {
  describe("delete", () => {
    test("shows the delete confirmation page", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Doomed" }));
      const { id } = await lastModifier();
      const response = await adminGet(`/admin/modifiers/${id}/delete`);
      await expectHtmlResponse(response, 200, "Delete Modifier", "Doomed");
    });

    test("deletes a modifier when the name is confirmed", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Doomed" }));
      const { id } = await lastModifier();
      const { response } = await adminFormPost(
        `/admin/modifiers/${id}/delete`,
        {
          confirm_identifier: "Doomed",
        },
      );
      await expectFlashRedirect(
        "/admin/modifiers",
        "Modifier deleted",
        true,
      )(response);
      expect((await getAllModifiers()).some((m) => m.id === id)).toBe(false);
    });
  });

  describe("scope", () => {
    /** Seed a "VIP" listing and a listings-scoped "Scoped" modifier. */
    const seedListingsScopedModifier = async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "VIP",
        unitPrice: 100,
      });
      await adminFormPost(
        "/admin/modifiers",
        createData({ name: "Scoped", scope: "listings" }),
      );
      const { id } = await lastModifier();
      return { id, listing };
    };

    test("stores the chosen scope", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ scope: "listings" }),
      );
      expect((await lastModifier()).scope).toBe("listings");
    });

    test("rejects an unknown scope", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ scope: "bogus" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Invalid scope",
        false,
      )(response);
    });

    test("edit page lists linkable listings for a listings-scoped modifier", async () => {
      const { id } = await seedListingsScopedModifier();
      const response = await adminGet(`/admin/modifiers/${id}/edit`);
      await expectHtmlResponse(
        response,
        200,
        "Linked listings",
        "VIP",
        'name="listing_ids"',
      );
    });

    test("edit page lists linkable groups for a groups-scoped modifier", async () => {
      await createTestGroup({ name: "Weekend" });
      await adminFormPost(
        "/admin/modifiers",
        createData({ name: "GS", scope: "groups" }),
      );
      const { id } = await lastModifier();
      const response = await adminGet(`/admin/modifiers/${id}/edit`);
      const html = await expectHtmlResponse(
        response,
        200,
        "Linked groups",
        "Weekend",
        'name="group_ids"',
      );
      // Groups have no deactivated state, so a group option is never muted.
      expect(html).not.toContain(
        '<label class="muted"><input name="group_ids"',
      );
    });

    test("links listings via the scope form", async () => {
      const { id, listing } = await seedListingsScopedModifier();
      await adminFormPost(`/admin/modifiers/${id}/links`, {
        listing_ids: String(listing.id),
      });
      expect(await modifierListings.getIds(id)).toEqual([listing.id]);
    });

    test("links groups via the scope form", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ name: "GS", scope: "groups" }),
      );
      const { id } = await lastModifier();
      await adminFormPost(`/admin/modifiers/${id}/links`, { group_ids: "42" });
      expect(await modifierGroups.getIds(id)).toEqual([42]);
    });

    test("drops a non-positive id from the scope form", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ name: "Filtered", scope: "groups" }),
      );
      const { id } = await lastModifier();
      // selectedIds keeps only positive integers: -1 is an integer but not
      // > 0, so it must be dropped — the filter is `isInteger(n) && n > 0`,
      // not `||` (which would let -1 through and store it).
      await adminFormPost(`/admin/modifiers/${id}/links`, { group_ids: "-1" });
      expect(await modifierGroups.getIds(id)).toEqual([]);
    });

    test("the scope form is a no-op for a whole-order modifier", async () => {
      await adminFormPost("/admin/modifiers", createData());
      const { id } = await lastModifier();
      const { response } = await adminFormPost(
        `/admin/modifiers/${id}/links`,
        {},
      );
      await expectFlashRedirect(
        `/admin/modifiers/${id}/edit`,
        "Scope updated",
        true,
      )(response);
    });

    test("the scope form 404s for a missing modifier", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers/999/links",
        {},
      );
      expectStatus(404)(response);
    });
  });

  describe("answer links", () => {
    const createQuestionWithAnswer = async (
      question: string,
      answer: string,
    ): Promise<{ questionId: number; answerId: number }> => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: question,
      });
      const a = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: answer,
      });
      return { answerId: a.id, questionId: q.id };
    };

    test("edit page lists linkable answers for an answer-triggered modifier", async () => {
      await createQuestionWithAnswer("Size?", "Large");
      await adminFormPost(
        "/admin/modifiers",
        createData({ name: "Tier", trigger: "answer" }),
      );
      const { id } = await lastModifier();
      const response = await adminGet(`/admin/modifiers/${id}/edit`);
      await expectHtmlResponse(
        response,
        200,
        "Linked answers",
        "Size? — Large",
        'name="answer_ids"',
      );
    });

    test("links answers via the answer form", async () => {
      const { answerId } = await createQuestionWithAnswer("Size?", "Large");
      await adminFormPost(
        "/admin/modifiers",
        createData({ name: "Tier", trigger: "answer" }),
      );
      const { id } = await lastModifier();
      const { response } = await adminFormPost(
        `/admin/modifiers/${id}/answers`,
        { answer_ids: String(answerId) },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${id}/edit`,
        "Answers updated",
        true,
      )(response);
      expect(await getModifierAnswerIds(id)).toEqual([answerId]);
    });

    test("the answer form 404s for a missing modifier", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers/999/answers",
        {},
      );
      expectStatus(404)(response);
    });

    test("the edit page omits the answer editor for a non-answer modifier", async () => {
      await adminFormPost("/admin/modifiers", createData());
      const { id } = await lastModifier();
      const response = await adminGet(`/admin/modifiers/${id}/edit`);
      const html = await response.text();
      expect(html).not.toContain("Linked answers");
    });
  });

  describe("trigger and promo code", () => {
    test("stores the chosen trigger", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ trigger: "optional" }),
      );
      expect((await lastModifier()).trigger).toBe("optional");
    });

    test("stores the answer trigger", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ trigger: "answer" }),
      );
      expect((await lastModifier()).trigger).toBe("answer");
    });

    test("rejects an unknown trigger", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ trigger: "magic" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Invalid trigger",
        false,
      )(response);
    });

    test("requires a code when the trigger is a promo code", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ code: "", trigger: "code" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "A promo-code modifier needs a code",
        false,
      )(response);
    });

    test("stores a promo code and its blind index", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ code: "Summer25", trigger: "code" }),
      );
      const modifier = await lastModifier();
      expect(modifier.code).toBe("Summer25");
      expect(modifier.code_index).toBe(
        await hmacHash(normalizeCode("Summer25")),
      );
    });

    test("ignores a code entered for a non-code trigger", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ code: "LEFTOVER", trigger: "automatic" }),
      );
      const modifier = await lastModifier();
      expect(modifier.code).toBe("");
      expect(modifier.code_index).toBeNull();
    });
  });

  describe("returning-customer gate", () => {
    test("stores the minimum previous bookings gate", async () => {
      await adminFormPost("/admin/modifiers", createData({ min_visits: "2" }));
      expect((await lastModifier()).min_visits).toBe(2);
    });

    test("rejects minimum previous bookings on optional add-ons", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ min_visits: "1", trigger: "optional" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Optional add-ons cannot require previous bookings",
        false,
      )(response);
    });

    test("rejects a negative minimum previous bookings value", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ min_visits: "-1" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Minimum previous bookings must be a whole number of 0 or more",
        false,
      )(response);
    });

    test("rejects a fractional minimum previous bookings value", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ min_visits: "1.5" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Minimum previous bookings must be a whole number of 0 or more",
        false,
      )(response);
    });
  });
});
