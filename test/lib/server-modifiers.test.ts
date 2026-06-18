import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { toMinorUnits } from "#shared/currency.ts";
import { getDb } from "#shared/db/client.ts";
import {
  getAllModifiers,
  getModifierGroupIds,
  getModifierListingIds,
  modifiersTable,
  updateModifierAggregateValues,
} from "#shared/db/modifiers.ts";
import { normalizeCode } from "#shared/price-modifier.ts";
import type { Modifier } from "#shared/types.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestGroup,
  createTestListing,
  createTestManagerSession,
  describeWithEnv,
  expectHtmlResponse,
  expectRedirectWithFlash,
  expectStatus,
  followRedirectWithFlash,
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
        "/admin/modifiers/new",
        "Percentage must be between 0 and 100",
        false,
      )(response);
    });

    test("rejects a non-positive multiplier", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ calc_kind: "multiply", calc_value: "0" }),
      );
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
        `/admin/modifiers/${id}/edit`,
        "Percentage must be between 0 and 100",
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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

  describe("trigger and promo code", () => {
    test("stores the chosen trigger", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ trigger: "optional" }),
      );
      expect((await lastModifier()).trigger).toBe("optional");
    });

    test("rejects an unknown trigger", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ trigger: "magic" }),
      );
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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
});
