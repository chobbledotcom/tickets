import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { toMinorUnits } from "#shared/currency.ts";
import { getDb } from "#shared/db/client.ts";
import { setChildIds } from "#shared/db/listing-parents.ts";
import {
  getAllModifiers,
  getModifierAnswerIds,
  getModifierGroupIds,
  getModifierListingIds,
  modifiersTable,
  updateModifierAggregateValues,
} from "#shared/db/modifiers.ts";
import { answersTable, questionsTable } from "#shared/db/questions.ts";
import { normalizeCode } from "#shared/price-modifier.ts";
import type { Modifier } from "#shared/types.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestGroup,
  createTestListing,
  createTestManagerSession,
  deactivateTestListing,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  followRedirectWithFlash,
  getTestSession,
  insertModifier,
  linkModifierListing,
  patchModifier,
  testRequiresAuth,
} from "#test-utils";

/** Default valid create payload; override per test. */
const createData = (overrides: Record<string, string> = {}) => ({
  active: "1",
  calc_kind: "percent",
  calc_value: "10",
  direction: "discount",
  name: "Early bird",
  ...overrides,
});

const lastModifier = async (): Promise<Modifier> => {
  const all = await getAllModifiers();
  return all[all.length - 1]!;
};

const insertUsage = (
  modifierId: number,
  attendeeId: number,
  quantity: number,
  amountApplied: number,
): Promise<unknown> =>
  getDb().execute({
    args: [modifierId, attendeeId, quantity, amountApplied, "2026-06-17"],
    sql: "INSERT INTO modifier_usages (modifier_id, attendee_id, quantity, amount_applied, created) VALUES (?, ?, ?, ?, ?)",
  });

describeWithEnv("server (admin modifiers)", { db: true }, () => {
  describe("GET /admin/modifiers", () => {
    testRequiresAuth("/admin/modifiers");

    test("accessible to managers", async () => {
      const response = await awaitTestRequest("/admin/modifiers", {
        cookie: await createTestManagerSession(),
      });
      expectStatus(200)(response);
    });

    test("shows empty list when no modifiers exist", async () => {
      const { response } = await adminGet("/admin/modifiers");
      await expectHtmlResponse(
        response,
        200,
        "Modifiers",
        "No modifiers configured",
      );
    });

    test("lists modifiers with their rule summary", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Loyalty" }));
      const { response } = await adminGet("/admin/modifiers");
      await expectHtmlResponse(response, 200, "Loyalty", "Discount · 10%");
    });
  });

  describe("GET /admin/modifiers/new", () => {
    test("shows the create form", async () => {
      const { response } = await adminGet("/admin/modifiers/new");
      await expectHtmlResponse(response, 200, "Add Modifier", "Direction");
    });
  });

  describe("POST /admin/modifiers", () => {
    test("creates a percentage discount modifier", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData(),
      );
      await expectFlashRedirect(
        "/admin/modifiers",
        "Modifier created",
        true,
      )(response);
      const modifier = await lastModifier();
      expect(modifier.name).toBe("Early bird");
      expect(modifier.calc_kind).toBe("percent");
      expect(modifier.calc_value).toBe(10);
      expect(modifier.direction).toBe("discount");
    });

    test("creates an active modifier when the toggle is checked", async () => {
      await adminFormPost("/admin/modifiers", createData());
      expect((await lastModifier()).active).toBe(true);
    });

    test("creates an inactive modifier when the toggle is cleared", async () => {
      const data = createData();
      // Omitting `active` mirrors an unchecked checkbox.
      const { active: _omit, ...withoutActive } = data;
      await adminFormPost("/admin/modifiers", withoutActive);
      expect((await lastModifier()).active).toBe(false);
    });

    test("creates a fixed charge modifier", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({
          calc_kind: "fixed",
          calc_value: "5",
          direction: "charge",
          name: "Booking surcharge",
        }),
      );
      const modifier = await lastModifier();
      expect(modifier.calc_kind).toBe("fixed");
      expect(modifier.calc_value).toBe(5);
      expect(modifier.direction).toBe("charge");
    });

    test("stores the minimum order in minor units", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ min_subtotal: "50" }),
      );
      expect((await lastModifier()).min_subtotal).toBe(toMinorUnits(50));
    });

    test("defaults the minimum order to zero when blank", async () => {
      await adminFormPost("/admin/modifiers", createData());
      expect((await lastModifier()).min_subtotal).toBe(0);
    });

    test("rejects a negative minimum order", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ min_subtotal: "-5" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Minimum order must be a positive number",
        false,
      )(response);
    });

    test("stores a stock limit", async () => {
      await adminFormPost("/admin/modifiers", createData({ stock: "5" }));
      expect((await lastModifier()).stock).toBe(5);
    });

    test("defaults stock to unlimited (null) when blank", async () => {
      await adminFormPost("/admin/modifiers", createData());
      expect((await lastModifier()).stock).toBeNull();
    });

    test("rejects a non-numeric value", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ calc_value: "abc" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Enter a valid number",
        false,
      )(response);
    });

    test("rejects a percentage above 100", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ calc_value: "150" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Percentage must be greater than 0 and at most 100",
        false,
      )(response);
    });

    test("rejects a zero percentage", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ calc_value: "0" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Percentage must be greater than 0 and at most 100",
        false,
      )(response);
    });

    test("re-renders the create form with the validation error", async () => {
      const { cookie, response } = await adminFormPost(
        "/admin/modifiers",
        createData({
          calc_kind: "fixed",
          calc_value: "0",
          direction: "charge",
        }),
      );
      const page = await followRedirectWithFlash(
        response,
        (request) => handleRequest(request),
        cookie,
      );
      await expectHtmlResponse(page, 200, "Amount must be greater than 0");
    });

    test("rejects a non-positive multiplier", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ calc_kind: "multiply", calc_value: "0" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Multiplier must be greater than 0",
        false,
      )(response);
    });

    test("rejects a non-positive fixed amount", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ calc_kind: "fixed", calc_value: "0" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Amount must be greater than 0",
        false,
      )(response);
    });

    test("rejects an unknown modifier type", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ calc_kind: "bogus" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Invalid modifier type",
        false,
      )(response);
    });

    test("rejects an unknown direction", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ direction: "sideways" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Invalid direction",
        false,
      )(response);
    });
  });

  describe("GET /admin/modifiers/:id/edit", () => {
    test("shows the edit form with current values", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Editable" }));
      const { id } = await lastModifier();
      const { response } = await adminGet(`/admin/modifiers/${id}/edit`);
      await expectHtmlResponse(response, 200, "Edit Modifier", "Editable");
    });

    test("shows the minimum order in major units on the edit form", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ min_subtotal: "50" }),
      );
      const { id } = await lastModifier();
      const { response } = await adminGet(`/admin/modifiers/${id}/edit`);
      await expectHtmlResponse(response, 200, 'value="50"');
    });

    test("shows the stock limit on the edit form", async () => {
      await adminFormPost("/admin/modifiers", createData({ stock: "7" }));
      const { id } = await lastModifier();
      const { response } = await adminGet(`/admin/modifiers/${id}/edit`);
      await expectHtmlResponse(response, 200, 'value="7"');
    });

    test("returns 404 for a missing modifier", async () => {
      const { response } = await adminGet("/admin/modifiers/999/edit");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/modifiers/:id/edit", () => {
    test("updates a modifier", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Before" }));
      const { id } = await lastModifier();
      const { response } = await adminFormPost(
        `/admin/modifiers/${id}/edit`,
        createData({ calc_value: "20", name: "After" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers",
        "Modifier updated",
        true,
      )(response);
      const updated = (await getAllModifiers()).find((m) => m.id === id)!;
      expect(updated.name).toBe("After");
      expect(updated.calc_value).toBe(20);
    });

    test("updates modifier running totals from the edit form", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Totals" }));
      const { id } = await lastModifier();
      const { response } = await adminFormPost(`/admin/modifiers/${id}/edit`, {
        ...createData({ name: "Totals" }),
        total_revenue: "123.45",
        total_uses: "12",
        usage_count: "4",
      });
      await expectFlashRedirect(
        "/admin/modifiers",
        "Modifier updated",
        true,
      )(response);
      const updated = (await getAllModifiers()).find((m) => m.id === id)!;
      expect(updated.total_revenue).toBe(12345);
      expect(updated.total_uses).toBe(12);
      expect(updated.usage_count).toBe(4);
    });

    test("rejects invalid modifier running totals", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Bad" }));
      const { id } = await lastModifier();
      const { response } = await adminFormPost(`/admin/modifiers/${id}/edit`, {
        ...createData({ name: "Bad" }),
        total_revenue: "10.00",
        total_uses: "-1",
        usage_count: "4",
      });
      await expectFlashRedirect(
        `/admin/modifiers/${id}/edit`,
        "Total Uses must be 0 or greater",
        false,
      )(response);
    });

    test("deactivates a modifier when the toggle is cleared on edit", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Toggle" }));
      const { id } = await lastModifier();
      const data = createData({ name: "Toggle" });
      const { active: _omit, ...withoutActive } = data;
      await adminFormPost(`/admin/modifiers/${id}/edit`, withoutActive);
      const updated = (await getAllModifiers()).find((m) => m.id === id)!;
      expect(updated.active).toBe(false);
    });

    test("rejects an invalid update", async () => {
      await adminFormPost("/admin/modifiers", createData());
      const { id } = await lastModifier();
      const { response } = await adminFormPost(
        `/admin/modifiers/${id}/edit`,
        createData({ calc_value: "150" }),
      );
      await expectFlashRedirect(
        `/admin/modifiers/${id}/edit`,
        "Percentage must be greater than 0 and at most 100",
        false,
      )(response);
    });

    test("returns 404 when editing a missing modifier", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers/999/edit",
        createData(),
      );
      expectStatus(404)(response);
    });

    test("returns 404 when a modifier disappears during update", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Stale" }));
      const { id } = await lastModifier();
      const updateStub = stub(modifiersTable, "update", () =>
        Promise.resolve(null),
      );

      try {
        const { response } = await adminFormPost(
          `/admin/modifiers/${id}/edit`,
          createData({ name: "Gone" }),
        );
        expectStatus(404)(response);
      } finally {
        updateStub.restore();
      }
    });
  });

  describe("modifier aggregate recalculation routes", () => {
    testRequiresAuth("/admin/modifiers/recalculate/1", {
      setup: async () => {
        await adminFormPost("/admin/modifiers", createData());
      },
    });

    test("shows current and usage-derived modifier totals", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Usage" }));
      const { id } = await lastModifier();
      await insertUsage(id, 1, 2, 1000);
      await updateModifierAggregateValues(id, {
        total_revenue: 9000,
        total_uses: 9,
        usage_count: 5,
      });

      const { response } = await adminGet(`/admin/modifiers/recalculate/${id}`);
      await expectHtmlResponse(
        response,
        200,
        "Recalculate:",
        "Current",
        "From attendee data",
        'value="total_uses"',
        ">9<",
        ">2<",
      );
    });

    test("resets selected modifier totals", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Reset" }));
      const { id } = await lastModifier();
      await insertUsage(id, 1, 2, 1000);
      await updateModifierAggregateValues(id, {
        total_revenue: 9000,
        total_uses: 9,
        usage_count: 5,
      });

      const { response } = await adminFormPost(
        `/admin/modifiers/recalculate/${id}`,
        { recalculate_fields: "total_uses" },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${id}/edit`,
        "Modifier totals recalculated",
        true,
      )(response);

      const updated = (await getAllModifiers()).find((m) => m.id === id)!;
      expect(updated.total_uses).toBe(2);
      expect(updated.total_revenue).toBe(9000);
      expect(updated.usage_count).toBe(5);
    });

    test("shows recalculation success on the redirected edit page", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Reset" }));
      const { id } = await lastModifier();

      const { cookie, response } = await adminFormPost(
        `/admin/modifiers/recalculate/${id}`,
        { recalculate_fields: "total_uses" },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${id}/edit`,
        "Modifier totals recalculated",
        true,
      )(response);

      const editResponse = await followRedirectWithFlash(
        response,
        (request) => handleRequest(request),
        cookie,
      );
      await expectHtmlResponse(
        editResponse,
        200,
        "Modifier totals recalculated",
      );
    });

    test("rejects modifier recalculation with no selected totals", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Empty" }));
      const { id } = await lastModifier();

      const { response } = await adminFormPost(
        `/admin/modifiers/recalculate/${id}`,
        {},
      );
      await expectHtmlResponse(
        response,
        400,
        "Choose at least one total to recalculate",
      );
    });
  });

  describe("delete", () => {
    test("shows the delete confirmation page", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Doomed" }));
      const { id } = await lastModifier();
      const { response } = await adminGet(`/admin/modifiers/${id}/delete`);
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
      await createTestListing({
        maxAttendees: 10,
        name: "VIP",
        unitPrice: 100,
      });
      await adminFormPost(
        "/admin/modifiers",
        createData({ name: "Scoped", scope: "listings" }),
      );
      const { id } = await lastModifier();
      const { response } = await adminGet(`/admin/modifiers/${id}/edit`);
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
      const { response } = await adminGet(`/admin/modifiers/${id}/edit`);
      await expectHtmlResponse(
        response,
        200,
        "Linked groups",
        "Weekend",
        'name="group_ids"',
      );
    });

    test("links listings via the scope form", async () => {
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
      await adminFormPost(`/admin/modifiers/${id}/links`, {
        listing_ids: String(listing.id),
      });
      expect(await getModifierListingIds(id)).toEqual([listing.id]);
    });

    test("links groups via the scope form", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ name: "GS", scope: "groups" }),
      );
      const { id } = await lastModifier();
      await adminFormPost(`/admin/modifiers/${id}/links`, { group_ids: "42" });
      expect(await getModifierGroupIds(id)).toEqual([42]);
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
      const { response } = await adminGet(`/admin/modifiers/${id}/edit`);
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
      const { response } = await adminGet(`/admin/modifiers/${id}/edit`);
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

describeWithEnv(
  "server (admin modifiers) > child-only add-on guard",
  { db: true },
  () => {
    /** An active opt-in, listings-scoped add-on with no links yet. */
    const optInAddOn = async (name: string): Promise<Modifier> => {
      const modifier = await insertModifier({ name });
      await patchModifier(modifier.id, {
        active: 1,
        scope: "listings",
        trigger: "optional",
      });
      return modifier;
    };

    test("allows creating a whole-order opt-in add-on (reachable everywhere)", async () => {
      // A whole-order (scope "all") add-on loads on every page, so it can never
      // be a child-only dead end — creating one with the flag on is allowed.
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({
          calc_kind: "fixed",
          calc_value: "5",
          direction: "charge",
          name: "Order extra",
          trigger: "optional",
        }),
      );
      await expectFlashRedirect(
        "/admin/modifiers",
        "Modifier created",
        true,
      )(response);
      expect((await lastModifier()).trigger).toBe("optional");
    });

    test("blocks scoping an opt-in add-on to only a child via the links form", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const modifier = await optInAddOn("Child-only extra");
      const { response } = await adminFormPost(
        `/admin/modifiers/${modifier.id}/links`,
        { listing_ids: String(child.id) },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${modifier.id}/edit`,
        t("modifiers.err_child_only_addon", { name: "Child-only extra" }),
        false,
      )(response);
      expect(await getModifierListingIds(modifier.id)).toEqual([]);
    });

    test("blocks flipping a child-scoped modifier to an opt-in add-on on edit", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const modifier = await insertModifier({ name: "Becomes add-on" });
      await patchModifier(modifier.id, { scope: "listings" });
      await linkModifierListing(modifier.id, child.id);
      const { response } = await adminFormPost(
        `/admin/modifiers/${modifier.id}/edit`,
        createData({
          calc_kind: "fixed",
          calc_value: "5",
          direction: "charge",
          name: "Becomes add-on",
          scope: "listings",
          trigger: "optional",
        }),
      );
      await expectFlashRedirect(
        `/admin/modifiers/${modifier.id}/edit`,
        t("modifiers.err_child_only_addon", { name: "Becomes add-on" }),
        false,
      )(response);
      expect((await modifiersTable.findById(modifier.id))!.trigger).toBe(
        "automatic",
      );
    });

    test("allows editing an active NON-opt-in child-scoped modifier (not an add-on)", async () => {
      // The child-only-dead-end check applies only to opt-in add-ons: an active
      // automatic modifier scoped solely to a child is never offered on a page,
      // so a plain resource edit (here, a name change) must NOT be blocked even
      // though its stored scope is child-only.
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const modifier = await insertModifier({ name: "Auto child surcharge" });
      await patchModifier(modifier.id, { active: 1, scope: "listings" });
      await linkModifierListing(modifier.id, child.id);
      const { response } = await adminFormPost(
        `/admin/modifiers/${modifier.id}/edit`,
        createData({
          active: "1",
          calc_kind: "fixed",
          calc_value: "5",
          direction: "charge",
          name: "Auto child surcharge renamed",
          scope: "listings",
          trigger: "automatic",
        }),
      );
      await expectFlashRedirect(
        "/admin/modifiers",
        "Modifier updated",
        true,
      )(response);
      expect((await modifiersTable.findById(modifier.id))!.name).toBe(
        "Auto child surcharge renamed",
      );
    });

    test("allows flipping a {child, parent}-scoped modifier to an opt-in add-on", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const modifier = await insertModifier({ name: "Shared add-on" });
      await patchModifier(modifier.id, { scope: "listings" });
      // Scoped to both the parent (a reachable page) and the child: not a dead
      // end, so flipping it to an opt-in add-on is allowed.
      await linkModifierListing(modifier.id, parent.id);
      await linkModifierListing(modifier.id, child.id);
      const { response } = await adminFormPost(
        `/admin/modifiers/${modifier.id}/edit`,
        createData({
          calc_kind: "fixed",
          calc_value: "5",
          direction: "charge",
          name: "Shared add-on",
          scope: "listings",
          trigger: "optional",
        }),
      );
      await expectFlashRedirect(
        "/admin/modifiers",
        "Modifier updated",
        true,
      )(response);
      expect((await modifiersTable.findById(modifier.id))!.trigger).toBe(
        "optional",
      );
    });

    test("blocks scoping an opt-in add-on to a group of only children", async () => {
      const group = await createTestGroup({ name: "Add-ons" });
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({
        groupId: group.id,
        name: "Add-on",
      });
      await setChildIds(parent.id, [child.id]);
      const modifier = await insertModifier({ name: "Group child extra" });
      await patchModifier(modifier.id, {
        active: 1,
        scope: "groups",
        trigger: "optional",
      });
      const { response } = await adminFormPost(
        `/admin/modifiers/${modifier.id}/links`,
        { group_ids: String(group.id) },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${modifier.id}/edit`,
        t("modifiers.err_child_only_addon", { name: "Group child extra" }),
        false,
      )(response);
      expect(await getModifierGroupIds(modifier.id)).toEqual([]);
    });

    test("allows scoping a non-opt-in modifier to only a child (not an add-on)", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      // An automatic surcharge is never offered as an opt-in add-on, so it can
      // be scoped to a child without dead-ending.
      const modifier = await insertModifier({ name: "Auto surcharge" });
      await patchModifier(modifier.id, { active: 1, scope: "listings" });
      const { response } = await adminFormPost(
        `/admin/modifiers/${modifier.id}/links`,
        { listing_ids: String(child.id) },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${modifier.id}/edit`,
        "Scope updated",
        true,
      )(response);
      expect(await getModifierListingIds(modifier.id)).toEqual([child.id]);
    });

    test("allows an inactive child-scoped opt-in add-on (never loads on a page)", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const modifier = await insertModifier({ name: "Inactive extra" });
      // An inactive *opt-in* add-on: the trigger would dead-end if it were
      // active, but an inactive modifier never loads, so the save is allowed.
      await patchModifier(modifier.id, {
        active: 0,
        scope: "listings",
        trigger: "optional",
      });
      const { response } = await adminFormPost(
        `/admin/modifiers/${modifier.id}/links`,
        { listing_ids: String(child.id) },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${modifier.id}/edit`,
        "Scope updated",
        true,
      )(response);
      expect(await getModifierListingIds(modifier.id)).toEqual([child.id]);
    });

    /** POST the scope-links form with repeated `listing_ids` values
     * (mockFormRequest only carries a single value per key). */
    const postListingLinks = async (
      modifierId: number,
      listingIds: number[],
    ): Promise<Response> => {
      const { cookie, csrfToken } = await getTestSession();
      const body = new URLSearchParams();
      body.set("csrf_token", csrfToken);
      for (const id of listingIds) body.append("listing_ids", String(id));
      return handleRequest(
        new Request(`http://localhost/admin/modifiers/${modifierId}/links`, {
          body: body.toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
            host: "localhost",
          },
          method: "POST",
        }),
      );
    };

    test("blocks scoping an opt-in add-on to {child, inactive non-child}", async () => {
      // The non-child listing is INACTIVE, so it serves no public booking page
      // and can't load the add-on. The add-on is therefore reachable only via
      // the suppressed child — still a dead end, so the save is blocked.
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      const inactive = await createTestListing({ name: "Hidden extra page" });
      await deactivateTestListing(inactive.id);
      await setChildIds(parent.id, [child.id]);
      const modifier = await optInAddOn("Stranded extra");
      const response = await postListingLinks(modifier.id, [
        child.id,
        inactive.id,
      ]);
      await expectFlashRedirect(
        `/admin/modifiers/${modifier.id}/edit`,
        t("modifiers.err_child_only_addon", { name: "Stranded extra" }),
        false,
      )(response);
      expect(await getModifierListingIds(modifier.id)).toEqual([]);
    });

    test("allows scoping an opt-in add-on to {child, active non-child}", async () => {
      // The non-child listing is ACTIVE, so its booking page loads the add-on:
      // not a dead end, so the save is allowed.
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      const reachable = await createTestListing({ name: "Live extra page" });
      await setChildIds(parent.id, [child.id]);
      const modifier = await optInAddOn("Reachable extra");
      const response = await postListingLinks(modifier.id, [
        child.id,
        reachable.id,
      ]);
      await expectFlashRedirect(
        `/admin/modifiers/${modifier.id}/edit`,
        "Scope updated",
        true,
      )(response);
      expect(await getModifierListingIds(modifier.id)).toEqual(
        [child.id, reachable.id].sort((a, b) => a - b),
      );
    });
  },
);
