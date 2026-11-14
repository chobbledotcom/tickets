import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getAllModifiers } from "#db/modifiers.ts";
import { handleRequest } from "#routes";
import { toMinorUnits } from "#shared/currency.ts";
import { MAX_PERCENT_CHARGE } from "#shared/price-modifier.ts";
import { modifierRecord } from "#shared/records/modifiers.ts";
import {
  expectHtmlResponse,
  expectStatus,
  followRedirectWithFlash,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestManagerSession,
} from "#test-utils/session.ts";
import {
  enableFeature,
  storedFeatureEnabled,
  withFeatureWriteFailure,
} from "#test-utils/settings.ts";
import {
  createAcceptanceTests,
  createData,
  createRefusalTests,
  expectCreated,
  lastModifier,
} from "./helpers.ts";

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
      const response = await adminGet("/admin/modifiers");
      await expectHtmlResponse(
        response,
        200,
        "Modifiers",
        "No modifiers configured",
      );
    });

    test("lists modifiers with their rule summary", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Loyalty" }));
      const response = await adminGet("/admin/modifiers");
      await expectHtmlResponse(response, 200, "Loyalty", "Discount · 10%");
    });
  });

  describe("GET /admin/modifiers/new", () => {
    test("shows the create form", async () => {
      const response = await adminGet("/admin/modifiers/new");
      await expectHtmlResponse(response, 200, "Add Modifier", "Direction");
    });
  });

  describe("POST /admin/modifiers", () => {
    test("creates a percentage discount modifier", async () => {
      await expectCreated(createData());
      const modifier = await lastModifier();
      expect(modifier.name).toBe("Early bird");
      expect(modifier.calc_kind).toBe("percent");
      expect(modifier.calc_value).toBe(10);
      expect(modifier.direction).toBe("discount");
      expect(await storedFeatureEnabled("modifiers")).toBe(true);
    });

    test("does not create a modifier when enabling the feature fails", async () => {
      await enableFeature("modifiers");
      await expect(
        withFeatureWriteFailure(async () => {
          await adminFormPost("/admin/modifiers", createData());
        }),
      ).rejects.toThrow("feature enable failed");
      expect(await getAllModifiers()).toEqual([]);
    });

    test("creates an inactive modifier when the toggle is cleared", async () => {
      const data = createData();
      // Omitting `active` mirrors an unchecked checkbox.
      const { active: _omit, ...withoutActive } = data;
      await adminFormPost("/admin/modifiers", withoutActive);
      expect((await lastModifier()).active).toBe(false);
    });

    createAcceptanceTests([
      [
        "creates an active modifier when the toggle is checked",
        {},
        { active: true },
      ],
      [
        "creates a fixed charge modifier",
        {
          calc_kind: "fixed",
          calc_value: "5",
          direction: "charge",
          name: "Booking surcharge",
        },
        { calc_kind: "fixed", calc_value: 5, direction: "charge" },
      ],
      [
        "accepts a fixed amount at the currency's precision",
        { calc_kind: "fixed", calc_value: "5.50" },
        { calc_value: 5.5 },
      ],
    ]);

    createAcceptanceTests([
      [
        "stores the minimum order in minor units",
        { min_subtotal: "50" },
        { min_subtotal: toMinorUnits(50) },
      ],
      [
        "defaults the minimum order to zero when blank",
        {},
        { min_subtotal: 0 },
      ],
    ]);

    createAcceptanceTests([
      ["stores a stock limit", { stock: "5" }, { stock: 5 }],
      ["defaults stock to unlimited (null) when blank", {}, { stock: null }],
      [
        "stores the max times per order on a question-answer modifier",
        {
          calc_kind: "fixed",
          calc_value: "10",
          direction: "charge",
          max_per_order: "2",
          name: "Zone 2 delivery",
          trigger: "answer",
        },
        { max_per_order: 2 },
      ],
    ]);

    createAcceptanceTests([
      [
        "drops the max times per order for other triggers",
        { max_per_order: "1" },
        { max_per_order: null },
      ],
      [
        "accepts the max times per order at its declared minimum",
        { max_per_order: "1", trigger: "answer" },
        { max_per_order: 1 },
      ],
    ]);

    createRefusalTests([
      [
        "rejects a fixed amount with too many decimals for the currency",
        { calc_kind: "fixed", calc_value: "10.005" },
        "Amount has more decimal places than your currency allows",
      ],
      [
        "rejects a negative minimum order",
        { min_subtotal: "-5" },
        "Minimum order must be a valid amount for your currency",
      ],
      [
        "rejects a minimum order with too many decimals for the currency",
        { min_subtotal: "10.005" },
        "Minimum order must be a valid amount for your currency",
      ],
    ]);

    createRefusalTests([
      [
        "rejects a max times per order below 1",
        { max_per_order: "0", trigger: "answer" },
        "Max times per order (optional) must be 1 or greater",
      ],
      [
        "rejects a fractional max times per order",
        { max_per_order: "1.5", trigger: "answer" },
        "Max times per order (optional) must be a whole number",
      ],
    ]);

    createRefusalTests([
      [
        "rejects a non-numeric value",
        { calc_value: "abc" },
        "Enter a valid number",
      ],
      [
        "rejects a percentage above 100",
        { calc_value: "150" },
        "Percentage must be greater than 0 and at most 100",
      ],
      [
        "rejects a percentage charge with trailing junk",
        { calc_value: "150abc", direction: "charge" },
        "Enter a valid number",
      ],
    ]);

    createRefusalTests([
      [
        "rejects a percentage charge above the safe limit",
        { calc_value: String(MAX_PERCENT_CHARGE + 1), direction: "charge" },
        "Percentage must be greater than 0 and at most 10,000",
      ],
      [
        "rejects a zero percentage discount",
        { calc_value: "0" },
        "Percentage must be greater than 0 and at most 100",
      ],
    ]);

    createRefusalTests([
      [
        "rejects a zero percentage charge",
        { calc_value: "0", direction: "charge" },
        "Percentage must be greater than 0",
      ],
      [
        "rejects a non-positive multiplier",
        { calc_kind: "multiply", calc_value: "0" },
        "Multiplier must be greater than 0",
      ],
      [
        "rejects a non-positive fixed amount",
        { calc_kind: "fixed", calc_value: "0" },
        "Amount must be greater than 0",
      ],
    ]);

    createRefusalTests([
      [
        "rejects an unknown modifier type",
        { calc_kind: "bogus" },
        "Invalid modifier type",
      ],
      [
        "rejects an unknown direction",
        { direction: "sideways" },
        "Invalid direction",
      ],
    ]);

    test("creates a percentage charge above 100", async () => {
      await expectCreated(
        createData({ calc_value: "150", direction: "charge" }),
      );
      const modifier = await lastModifier();
      expect([modifier.calc_value, modifier.direction]).toEqual([
        150,
        "charge",
      ]);
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
  });

  describe("POST /admin/modifiers/:id/edit", () => {
    /** Seed one modifier and answer the edit payload that names it. */
    const seedEdit = async (name: string) => {
      await adminFormPost("/admin/modifiers", createData({ name }));
      const { id } = await lastModifier();
      return {
        edit: createData({
          calc_kind: "fixed",
          calc_value: "5",
          direction: "charge",
          name: `${name} renamed`,
          scope: "listings",
          trigger: "automatic",
        }),
        id,
      };
    };

    test("answers 404 when the row vanished before the save commits", async () => {
      const { edit, id } = await seedEdit("Vanishing");
      using _update = stub(modifierRecord, "update", () =>
        Promise.resolve({ kind: "not-found" as const }),
      );

      const { response } = await adminFormPost(
        `/admin/modifiers/${id}/edit`,
        edit,
      );

      expectStatus(404)(response);
    });

    test("re-renders the edit page with the record's refusal", async () => {
      const { edit, id } = await seedEdit("Refused");
      using _update = stub(modifierRecord, "update", () =>
        Promise.resolve({
          kind: "refused" as const,
          message: "The stored modifier refused this save",
        }),
      );

      const { response } = await adminFormPost(
        `/admin/modifiers/${id}/edit`,
        edit,
      );

      await expectHtmlResponse(
        response,
        400,
        "The stored modifier refused this save",
      );
    });
  });
});
