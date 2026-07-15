import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
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
    expect(html).toContain('href="/admin/features/modifiers"');
    expect(html).toContain('href="/admin/features/serving-events"');
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

  test("explains API keys", async () => {
    const response = await adminGet("/admin/features/api-keys");
    await expectHtmlResponse(
      response,
      200,
      "API keys",
      "Show tools for creating keys that connect other software.",
    );
  });

  test("explains Serving events", async () => {
    const response = await adminGet("/admin/features/serving-events");
    await expectHtmlResponse(
      response,
      200,
      "Serving events",
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
    expect(settings.enabledFeatures.money).toBe(false);
  });

  test("enables and disables Money", async () => {
    await expectFeatureSaved("money", true, "Money enabled.");
    expect(settings.enabledFeatures.money).toBe(true);

    await expectFeatureSaved("money", false, "Money disabled.");
    expect(settings.enabledFeatures.money).toBe(false);
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
    await settings.update.enabledFeatures({
      ...settings.enabledFeatures,
      modifiers: true,
    });

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
    expect(settings.enabledFeatures.modifiers).toBe(true);
  });
});
