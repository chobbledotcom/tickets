import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { toMinorUnits } from "#shared/currency.ts";
import { getAllModifiers } from "#shared/db/modifiers.ts";
import type { Modifier } from "#shared/types.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestManagerSession,
  describeWithEnv,
  expectHtmlResponse,
  expectRedirectWithFlash,
  expectStatus,
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
});
