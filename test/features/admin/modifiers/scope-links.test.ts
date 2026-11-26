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
import { matchKey } from "#shared/keys.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { seedQuestion } from "#test-utils/db-helpers/question-seeds.ts";
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
        { confirmIdentifier: "Doomed" },
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
        'name="listingIds"',
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
        'name="groupIds"',
      );
      // Groups have no deactivated state, so a group option is never muted.
      assert(!html.includes('<label class="muted"><input name="groupIds"'));
    });

    test("links the chosen scope targets via their forms", async () => {
      const { id, listing } = await seedListingsScopedModifier();
      await adminFormPost(`/admin/modifiers/${id}/links`, {
        listingIds: String(listing.id),
      });
      expect(await modifierListings.getIds(id)).toEqual([listing.id]);

      const group = await createTestGroup({ name: "Linked group" });
      const scoped = await createModifier({ name: "GS", scope: "groups" });
      await adminFormPost(`/admin/modifiers/${scoped.id}/links`, {
        groupIds: String(group.id),
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
      await adminFormPost(`/admin/modifiers/${id}/links`, { groupIds: "-1" });
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
      const seeded = await seedQuestion({ answers: [answer], text: question });
      return { answerId: seeded.answers[0].id, questionId: seeded.question.id };
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
        'name="answerIds"',
      );
    });

    test("links answers via the answer form", async () => {
      const { answerId } = await createQuestionWithAnswer("Size?", "Large");
      const { id } = await createModifier({ name: "Tier", trigger: "answer" });
      const { response } = await adminFormPost(
        `/admin/modifiers/${id}/answers`,
        { answerIds: String(answerId) },
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
      expect(coded.codeIndex).toBe(await hmacHash(matchKey("Summer25")));

      const leftover = await createModifier({
        code: "LEFTOVER",
        trigger: "automatic",
      });
      expect(leftover.code).toBe("");
      expect(leftover.codeIndex).toBeNull();
    });
  });

  describe("returning-customer gate", () => {
    createAcceptanceTests([
      [
        "stores the minimum previous bookings gate",
        { minVisits: "2" },
        { minVisits: 2 },
      ],
      [
        "accepts zero, the declared minimum",
        { minVisits: "0" },
        { minVisits: 0 },
      ],
    ]);

    createRefusalTests([
      [
        "rejects minimum previous bookings on optional add-ons",
        { minVisits: "1", trigger: "optional" },
        "Optional add-ons cannot require previous bookings",
      ],
      [
        "rejects a negative minimum previous bookings value",
        { minVisits: "-1" },
        "Minimum previous bookings must be 0 or greater",
      ],
      [
        "rejects a fractional minimum previous bookings value",
        { minVisits: "1.5" },
        "Minimum previous bookings must be a whole number",
      ],
    ]);
  });
});
