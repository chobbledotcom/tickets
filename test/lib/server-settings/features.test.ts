import type { InStatement } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { setAdminFeatureEnabled } from "#shared/db/admin-features.ts";
import { execute, getDb } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { setTestEnv } from "#test-utils/env.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { describeAdminSettings } from "#test-utils/settings.ts";

const expectFeatureSaved = async (
  slug: string,
  enabled: boolean,
  message: string,
): Promise<void> => {
  const path = `/admin/features/${slug}`;
  const { response } = await adminFormPost(path, {
    enabled: String(enabled),
  });
  await expectFlashRedirect(path, message)(response);
};

describeAdminSettings(() => {
  testRequiresAuth("/admin/features/modifiers");
  testRequiresAuth("/admin/features/modifiers", {
    body: { enabled: "true" },
    method: "POST",
  });

  test("shows the feature table last on the settings page", async () => {
    const html = await (await adminGet("/admin/settings")).text();
    expect(html).toContain('href="/admin/features/site"');
    expect(html).toContain('href="/admin/features/attributes"');
    expect(html).toContain('href="/admin/features/questions"');
    expect(html).toContain('href="/admin/features/modifiers"');
    expect(html).toContain('href="/admin/features/servicing"');
    expect(html).toContain("Disabled");
    expect(html.indexOf("Features")).toBeGreaterThan(
      html.indexOf("Calendar feeds"),
    );
  });

  test("shows a feature as enabled when it already has saved records", async () => {
    await execute(
      "INSERT INTO modifiers (name, calc_kind, calc_value, direction) VALUES ('Fee', 'fixed', 1, 'increase')",
    );
    const html = await (await adminGet("/admin/settings")).text();
    const start = html.indexOf('id="settings-features"');
    const featureTable = html.slice(start, html.indexOf("</article>", start));
    expect(featureTable).toContain('href="/admin/features/modifiers"');
    expect(featureTable).toContain("Enabled");
  });

  test("explains one feature and offers its toggle", async () => {
    const response = await adminGet("/admin/features/modifiers");
    await expectHtmlResponse(
      response,
      200,
      "Modifiers",
      "Show tools for changing prices and adding optional extras.",
      'action="/admin/features/modifiers"',
    );
  });

  test("shows feature status without a form in read-only mode", async () => {
    const restore = setTestEnv({
      READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
    });
    try {
      const html = await (await adminGet("/admin/features/modifiers")).text();
      expect(html).toContain("Status:");
      expect(html).toContain("Disabled");
      expect(html).not.toContain('action="/admin/features/modifiers"');
    } finally {
      restore();
    }
  });

  test("explains Site", async () => {
    const response = await adminGet("/admin/features/site");
    await expectHtmlResponse(
      response,
      200,
      "Site",
      "Publish the public site and show its editing tools in the admin menu.",
    );
  });

  test("explains Attributes", async () => {
    const response = await adminGet("/admin/features/attributes");
    await expectHtmlResponse(
      response,
      200,
      "Attributes",
      "Show tools for adding reusable details to listings.",
    );
  });

  test("explains Questions", async () => {
    const response = await adminGet("/admin/features/questions");
    await expectHtmlResponse(
      response,
      200,
      "Questions",
      "Show tools for asking people questions when they book.",
    );
  });

  test("explains API keys", async () => {
    const response = await adminGet("/admin/features/api-keys");
    await expectHtmlResponse(
      response,
      200,
      "API keys",
      "Show tools for creating keys that connect other software.",
    );
  });

  test("explains Servicing", async () => {
    const response = await adminGet("/admin/features/servicing");
    await expectHtmlResponse(
      response,
      200,
      "Servicing",
      "Show tools for reserving listing capacity for your own work.",
    );
  });

  test("returns 404 for an unknown feature", async () => {
    expectStatus(404)(await adminGet("/admin/features/unknown"));
  });

  test("rejects a missing enabled choice", async () => {
    const { response } = await adminFormPost("/admin/features/money", {});
    expect(response.status).toBe(302);
    expectFlash(response, "Choose whether to enable this feature.", false);
    expect(settings.features.money).toBe(false);
  });

  test("enables and disables Money", async () => {
    await expectFeatureSaved("money", true, "Money enabled.");
    expect(settings.features.money).toBe(true);

    await expectFeatureSaved("money", false, "Money disabled.");
    expect(settings.features.money).toBe(false);
  });

  test("publishes and unpublishes Site", async () => {
    await expectFeatureSaved("site", true, "Site enabled.");
    expect(settings.features.site).toBe(true);

    await expectFeatureSaved("site", false, "Site disabled.");
    expect(settings.features.site).toBe(false);
  });

  test("enables and disables unused Logistics", async () => {
    await settings.update.listingDefaults({
      ...settings.listingDefaults,
      usesLogistics: true,
    });
    await expectFeatureSaved("logistics", true, "Logistics enabled.");
    expect(settings.listingDefaults.usesLogistics).toBe(true);

    await expectFeatureSaved("logistics", false, "Logistics disabled.");
    expect(settings.listingDefaults.usesLogistics).toBeUndefined();
  });

  test("disables Logistics without creating a listing default", async () => {
    await expectFeatureSaved("logistics", false, "Logistics disabled.");
    expect(settings.listingDefaults.usesLogistics).toBeUndefined();
  });

  test("does not allow a feature in use to be disabled", async () => {
    await execute(
      "INSERT INTO modifiers (name, calc_kind, calc_value, direction) VALUES ('Fee', 'fixed', 1, 'increase')",
    );
    await setAdminFeatureEnabled("modifiers", true);

    const page = await (await adminGet("/admin/features/modifiers")).text();
    expect(page).toContain("This feature is in use.");
    expect(page).not.toContain('value="false"');

    const { response } = await adminFormPost("/admin/features/modifiers", {
      enabled: "false",
    });
    expect(response.status).toBe(302);
    expectFlash(
      response,
      "This feature is in use. Remove its saved items before you disable it.",
      false,
    );
    expect(settings.features.modifiers).toBe(true);
  });

  test("keeps a feature enabled when its first record appears during disable", async () => {
    await setAdminFeatureEnabled("modifiers", true);
    const db = getDb();
    const originalExecute = db.execute.bind(db);
    let inserted = false;
    const executeStub = stub(db, "execute", async (statement: InStatement) => {
      const result = await originalExecute(statement);
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (!inserted && sql.includes("SELECT json_object")) {
        inserted = true;
        await originalExecute(
          "INSERT INTO modifiers (name, calc_kind, calc_value, direction) VALUES ('Fee', 'fixed', 1, 'increase')",
        );
      }
      return result;
    });
    try {
      const { response } = await adminFormPost("/admin/features/modifiers", {
        enabled: "false",
      });
      expectFlash(
        response,
        "This feature is in use. Remove its saved items before you disable it.",
        false,
      );
    } finally {
      executeStub.restore();
    }
    expect(settings.features.modifiers).toBe(true);
  });
});
