import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { expectFlash, testRequiresAuth } from "#test-utils/assertions.ts";
import { hasCheckedInput } from "#test-utils/csrf.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { createKeyedRoleSession } from "#test-utils/role-sessions.ts";
import { adminGet, testCookie, testCsrfToken } from "#test-utils/session.ts";
import { describeAdminSettings } from "#test-utils/settings.ts";
import { ALL_ADMIN_LEVELS } from "#types";

const path = "/admin/settings/tax";
const post = async (
  tax_mode: string,
  tax_rate: string,
  expected_tax = '{"mode":"none"}',
) =>
  handleRequest(
    mockFormRequest(
      path,
      { csrf_token: await testCsrfToken(), expected_tax, tax_mode, tax_rate },
      await testCookie(),
    ),
  );

describeAdminSettings(() => {
  testRequiresAuth(path, {
    body: { expected_tax: '{"mode":"none"}', tax_mode: "none" },
    method: "POST",
  });

  for (const mode of ["add_to_total", "calculate_from_total"] as const) {
    for (const [rate, basisPoints] of [
      ["0", 0],
      ["7.25", 725],
      ["20.01", 2001],
    ] as const) {
      test(`owner saves and reloads ${mode} ${rate}%`, async () => {
        expectFlash(await post(mode, rate), "Tax settings saved");
        expect(settings.tax).toEqual({ mode, rateBasisPoints: basisPoints });
        const html = await (await adminGet("/admin/settings")).text();
        expect(hasCheckedInput(html, "tax_mode", mode)).toBe(true);
        expect(html).toContain(`value="${Number(rate).toFixed(2)}"`);
      });
    }
  }

  test("percentage precision does not depend on currency precision", async () => {
    settings.setForTest({ currency: "JPY" });
    try {
      expectFlash(await post("add_to_total", "7.25"), "Tax settings saved");
      expect(settings.tax).toEqual({
        mode: "add_to_total",
        rateBasisPoints: 725,
      });
    } finally {
      settings.clearTestOverride("currency");
    }
  });

  test("owner switches to No tax", async () => {
    const previous = { mode: "add_to_total", rateBasisPoints: 2000 } as const;
    await settings.update.tax(previous);
    expectFlash(
      await post("none", "", JSON.stringify(previous)),
      "Tax settings saved",
    );
    expect(settings.tax).toEqual({ mode: "none" });
  });

  for (const rate of [
    "",
    "-1",
    "NaN",
    "Infinity",
    "1e2",
    "0x10",
    "7.250",
    "12junk",
    ".5",
    " 2",
    "9007199254740992",
  ]) {
    test(`rejects invalid rate ${JSON.stringify(rate)} without changes`, async () => {
      const response = await post("add_to_total", rate);
      expectFlash(
        response,
        "Enter a non-negative tax rate with at most two decimal places.",
        false,
      );
      expect(settings.tax).toEqual({ mode: "none" });
    });
  }

  test("rejects invalid modes and missing or malformed expected policies", async () => {
    for (const [mode, expected] of [
      ["invalid", '{"mode":"none"}'],
      ["none", ""],
      ["none", "{"],
    ]) {
      expectFlash(
        await post(mode!, "0", expected!),
        "Tax settings are invalid. Reload the page and try again.",
        false,
      );
      expect(settings.tax).toEqual({ mode: "none" });
    }
  });

  test("rejects a stale form without changing the current policy", async () => {
    const current = {
      mode: "calculate_from_total",
      rateBasisPoints: 1000,
    } as const;
    await settings.update.tax(current);
    expectFlash(
      await post("add_to_total", "20"),
      "Tax settings changed since you opened this form. Reload the page and try again.",
      false,
    );
    expect(settings.tax).toEqual(current);
  });

  for (const role of ALL_ADMIN_LEVELS.filter((role) => role !== "owner")) {
    test(`${role} cannot save tax settings`, async () => {
      const { cookie } = await createKeyedRoleSession(role, {
        csrfToken: "tax-csrf",
        token: `tax-${role}`,
        username: `tax-${role}`,
      });
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            csrf_token: "tax-csrf",
            expected_tax: '{"mode":"none"}',
            tax_mode: "add_to_total",
            tax_rate: "20",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      expect(settings.tax).toEqual({ mode: "none" });
    });
  }

  test("explains the effect without requiring a payment provider", async () => {
    const html = await (await adminGet("/admin/settings")).text();
    expect(html).toContain("No tax");
    expect(html).toContain("Add tax to listed prices");
    expect(html).toContain("Listed prices include tax");
    expect(html).toContain("explicitly save an attendee");
    expect(html).toContain("does not change existing money automatically");
    expect(html).toContain('name="expected_tax"');
    expect(html).toContain('inputmode="decimal"');
  });
});
