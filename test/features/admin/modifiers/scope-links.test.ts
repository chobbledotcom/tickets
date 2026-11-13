import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import {
  getAllModifiers,
  getModifierAnswerIds,
  modifierGroups,
  modifierListings,
} from "#db/modifiers.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { matchKey } from "#shared/keys.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import {
  createAcceptanceTests,
  createModifier,
  createRefusalTests,
} from "./helpers.ts";

describeWithEnv("server (admin modifiers)", { db: true }, () => {
  describe("delete", () => {
    test("shows the delete confirmation page", async () => {
      const { id } = await createModifier({ name: "Doomed" });
      const response = await adminGet(`/admin/modifiers/${id}/delete`);
      await expectHtmlResponse(response, 200, "Delete Modifier", "Doomed");
    });

    test("deletes a modifier when the name is confirmed", async () => {
      const { id } = await createModifier({ name: "Doomed" });
      const { response } = await adminFormPost(
        `/admin/modifiers/${id}/delete`,
        { confirm_identifier: "Doomed" },
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
      const { id } = await createModifier({
        name: "Scoped",
        scope: "listings",
      });
      return { id, listing };
    };

    createAcceptanceTests([
      ["stores the chosen scope", { scope: "listings" }, { scope: "listings" }],
    ]);

    createRefusalTests([
      ["rejects an unknown scope", { scope: "bogus" }, "Invalid scope"],
    ]);

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
      const { id } = await createModifier({ name: "GS", scope: "groups" });
      const response = await adminGet(`/admin/modifiers/${id}/edit`);
      const html = await expectHtmlResponse(
        response,
        200,
        "Linked groups",
        "Weekend",
        'name="group_ids"',
      );
      // Groups have no deactivated state, so a group option is never muted.
      assert(!html.includes('<label class="muted"><input name="group_ids"'));
    });

    test("links the chosen scope targets via their forms", async () => {
      const { id, listing } = await seedListingsScopedModifier();
      await adminFormPost(`/admin/modifiers/${id}/links`, {
        listing_ids: String(listing.id),
      });
      expect(await modifierListings.getIds(id)).toEqual([listing.id]);

      const group = await createTestGroup({ name: "Linked group" });
      const scoped = await createModifier({ name: "GS", scope: "groups" });
      await adminFormPost(`/admin/modifiers/${scoped.id}/links`, {
        group_ids: String(group.id),
      });
      expect(await modifierGroups.getIds(scoped.id)).toEqual([group.id]);
    });

    test("drops a non-positive id from the scope form", async () => {
      const { id } = await createModifier({
        name: "Filtered",
        scope: "groups",
      });
      // selectedIds keeps only positive integers: -1 is an integer but not
      // > 0, so it must be dropped — the filter is `isInteger(n) && n > 0`,
      // not `||` (which would let -1 through and store it).
      await adminFormPost(`/admin/modifiers/${id}/links`, { group_ids: "-1" });
      expect(await modifierGroups.getIds(id)).toEqual([]);
    });

    test("the scope form is a no-op for a whole-order modifier", async () => {
      const { id } = await createModifier();
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
      const { id } = await createModifier({ name: "Tier", trigger: "answer" });
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
      const { id } = await createModifier({ name: "Tier", trigger: "answer" });
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
      const { id } = await createModifier();
      const response = await adminGet(`/admin/modifiers/${id}/edit`);
      const html = await response.text();
      assert(!html.includes("Linked answers"));
    });
  });

  describe("trigger and promo code", () => {
    createAcceptanceTests([
      [
        "stores the chosen trigger",
        { trigger: "optional" },
        { trigger: "optional" },
      ],
      [
        "stores the answer trigger",
        { trigger: "answer" },
        { trigger: "answer" },
      ],
    ]);

    createRefusalTests([
      ["rejects an unknown trigger", { trigger: "magic" }, "Invalid trigger"],
      [
        "requires a code when the trigger is a promo code",
        { code: "", trigger: "code" },
        "A promo-code modifier needs a code",
      ],
    ]);

    test("stores a promo code's blind index and drops one on another trigger", async () => {
      const coded = await createModifier({ code: "Summer25", trigger: "code" });
      expect(coded.code).toBe("Summer25");
      expect(coded.code_index).toBe(await hmacHash(matchKey("Summer25")));

      const leftover = await createModifier({
        code: "LEFTOVER",
        trigger: "automatic",
      });
      expect(leftover.code).toBe("");
      expect(leftover.code_index).toBeNull();
    });
  });

  describe("returning-customer gate", () => {
    createAcceptanceTests([
      [
        "stores the minimum previous bookings gate",
        { min_visits: "2" },
        { min_visits: 2 },
      ],
      [
        "accepts zero, the declared minimum",
        { min_visits: "0" },
        { min_visits: 0 },
      ],
    ]);

    createRefusalTests([
      [
        "rejects minimum previous bookings on optional add-ons",
        { min_visits: "1", trigger: "optional" },
        "Optional add-ons cannot require previous bookings",
      ],
      [
        "rejects a negative minimum previous bookings value",
        { min_visits: "-1" },
        "Minimum previous bookings (optional) must be 0 or greater",
      ],
      [
        "rejects a fractional minimum previous bookings value",
        { min_visits: "1.5" },
        "Minimum previous bookings (optional) must be a whole number",
      ],
    ]);
  });
});
