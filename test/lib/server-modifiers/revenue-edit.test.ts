import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import {
  getAllModifiers,
  getModifier,
  modifiersTable,
  updateModifierAggregateValues,
} from "#shared/db/modifiers.ts";
import {
  adminFormPost,
  adminGet,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  followRedirectWithFlash,
  getAllActivityLog,
  insertModifierUsage,
  testRequiresAuth,
} from "#test-utils";
import { postModifierLeg } from "#test-utils/ledger.ts";
import { createData, lastModifier } from "./helpers.ts";

describeWithEnv("server (admin modifiers)", { db: true }, () => {
  describe("POST /admin/modifiers/:id/revenue", () => {
    /** Create a modifier and return its id. */
    const seedModifier = async (name = "Adjustable"): Promise<number> => {
      await adminFormPost("/admin/modifiers", createData({ name }));
      return (await lastModifier()).id;
    };

    test("posts a writeoff correction that raises the projected revenue", async () => {
      const id = await seedModifier();
      // £15 of net modifier revenue, corrected up to £25 (major units).
      await postModifierLeg({ delta: 1500, modifierId: id });
      const { response } = await adminFormPost(
        `/admin/modifiers/${id}/revenue`,
        { total_revenue: "25.00" },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${id}/edit`,
        "Modifier revenue adjusted",
        true,
      )(response);
      expect((await getModifier(id))?.total_revenue).toBe(2500);
    });

    test("posts a writeoff correction that lowers the projected revenue", async () => {
      const id = await seedModifier();
      await postModifierLeg({ delta: 4000, modifierId: id });
      const { response } = await adminFormPost(
        `/admin/modifiers/${id}/revenue`,
        { total_revenue: "10.00" },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${id}/edit`,
        "Modifier revenue adjusted",
        true,
      )(response);
      expect((await getModifier(id))?.total_revenue).toBe(1000);
    });

    test("accepts a negative corrected revenue (net discount)", async () => {
      const id = await seedModifier();
      const { response } = await adminFormPost(
        `/admin/modifiers/${id}/revenue`,
        { total_revenue: "-5.00" },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${id}/edit`,
        "Modifier revenue adjusted",
        true,
      )(response);
      expect((await getModifier(id))?.total_revenue).toBe(-500);
    });

    test("logs a neutral activity message without the raw figure", async () => {
      const id = await seedModifier("Promo");
      await adminFormPost(`/admin/modifiers/${id}/revenue`, {
        total_revenue: "12.34",
      });
      const log = await getAllActivityLog(10);
      const entry = log.find((e) => e.message.includes("revenue adjusted"));
      expect(entry?.message).toBe("Modifier 'Promo' revenue adjusted");
      expect(entry?.message).not.toContain("12.34");
    });

    test("rejects a blank amount with an error flash", async () => {
      const id = await seedModifier();
      const { response } = await adminFormPost(
        `/admin/modifiers/${id}/revenue`,
        { total_revenue: "" },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${id}/edit`,
        "Enter a valid amount",
        false,
      )(response);
    });

    test("returns 404 for a missing modifier", async () => {
      const { response } = await adminFormPost(
        "/admin/modifiers/9999/revenue",
        {
          total_revenue: "10",
        },
      );
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

      const log = await getAllActivityLog(10);
      const entry = log.find((e) => e.message.includes("updated"));
      expect(entry?.message).toBe("Modifier 'After' updated");
    });

    test("updates modifier running totals from the edit form", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Totals" }));
      const { id } = await lastModifier();
      const { response } = await adminFormPost(`/admin/modifiers/${id}/edit`, {
        ...createData({ name: "Totals" }),
        total_uses: "12",
        usage_count: "4",
      });
      await expectFlashRedirect(
        "/admin/modifiers",
        "Modifier updated",
        true,
      )(response);
      const updated = (await getAllModifiers()).find((m) => m.id === id)!;
      expect(updated.total_uses).toBe(12);
      expect(updated.usage_count).toBe(4);
      // total_revenue is no longer an editable override — it projects from the
      // ledger, which has no modifier legs here, so it stays 0.
      expect(updated.total_revenue).toBe(0);
    });

    test("rejects invalid modifier running totals", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Bad" }));
      const { id } = await lastModifier();
      const { response } = await adminFormPost(`/admin/modifiers/${id}/edit`, {
        ...createData({ name: "Bad" }),
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
      await insertModifierUsage(id, 1, 2, 1000);
      await updateModifierAggregateValues(id, {
        total_uses: 9,
        usage_count: 5,
      });

      const response = await adminGet(`/admin/modifiers/recalculate/${id}`);
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
      await insertModifierUsage(id, 1, 2, 1000);
      await updateModifierAggregateValues(id, {
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
      expect(updated.usage_count).toBe(5);
      // total_revenue is projected from the ledger (no modifier legs here), so
      // it is 0 and unaffected by the count-only recalculation.
      expect(updated.total_revenue).toBe(0);

      const log = await getAllActivityLog(10);
      const entry = log.find((e) => e.message.includes("totals recalculated"));
      expect(entry?.message).toBe("Modifier 'Reset' totals recalculated");
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
});
