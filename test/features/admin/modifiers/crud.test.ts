import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllModifiers } from "#db/modifiers.ts";
import { handleRequest } from "#routes";
import { toMinorUnits } from "#shared/currency.ts";
import { MAX_PERCENT_CHARGE } from "#shared/price-modifier.ts";
import {
  expectFlashRedirect,
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
import { createData, lastModifier } from "./helpers.ts";

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

    test("accepts a fixed amount at the currency's precision", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ calc_kind: "fixed", calc_value: "5.50" }),
      );
      expect((await lastModifier()).calc_value).toBe(5.5);
    });

    test("rejects a fixed amount with too many decimals for the currency", async () => {
      // A fixed amount is a currency value (major units, converted at resolve).
      // 10.005 has 3 decimals — invalid in GBP (2) — so it's rejected rather
      // than silently rounded when the modifier is applied. A percentage or
      // multiplier keeps its precision, so this only guards the fixed kind.
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ calc_kind: "fixed", calc_value: "10.005" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Amount has more decimal places than your currency allows",
        false,
      )(response);
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
        "Minimum order must be a valid amount for your currency",
        false,
      )(response);
    });

    test("rejects a minimum order with too many decimals for the currency", async () => {
      // 10.005 has 3 decimals — invalid in GBP (2). Without validation this
      // would be rounded by toMinorUnits at save; instead it's rejected.
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ min_subtotal: "10.005" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Minimum order must be a valid amount for your currency",
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

    test("stores the max times per order on a question-answer modifier", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({
          calc_kind: "fixed",
          calc_value: "10",
          direction: "charge",
          max_per_order: "2",
          name: "Zone 2 delivery",
          trigger: "answer",
        }),
      );
      expect((await lastModifier()).max_per_order).toBe(2);
    });

    test("drops the max times per order for other triggers", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ max_per_order: "1" }),
      );
      expect((await lastModifier()).max_per_order).toBeNull();
    });

    test("rejects a max times per order below 1", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ max_per_order: "0", trigger: "answer" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Max times per order must be a whole number of 1 or more",
        false,
      )(response);
    });

    test("rejects a fractional max times per order", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ max_per_order: "1.5", trigger: "answer" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Max times per order must be a whole number of 1 or more",
        false,
      )(response);
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

    test("creates a percentage charge above 100", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ calc_value: "150", direction: "charge" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers",
        "Modifier created",
        true,
      )(response);
      const modifier = await lastModifier();
      expect(modifier.calc_value).toBe(150);
      expect(modifier.direction).toBe("charge");
    });

    test("rejects a percentage charge with trailing junk", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ calc_value: "150abc", direction: "charge" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Enter a valid number",
        false,
      )(response);
    });

    test("rejects a percentage charge above the safe limit", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({
          calc_value: String(MAX_PERCENT_CHARGE + 1),
          direction: "charge",
        }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Percentage must be greater than 0 and at most 10,000",
        false,
      )(response);
    });

    test("rejects a zero percentage discount", async () => {
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

    test("rejects a zero percentage charge", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({ calc_value: "0", direction: "charge" }),
      );
      await expectFlashRedirect(
        "/admin/modifiers/new",
        "Percentage must be greater than 0",
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
});
