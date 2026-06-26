import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  adminFormPost,
  adminGet,
  describeWithEnv,
  expectFlashRedirect,
  mockRequest,
} from "#test-utils";

describeWithEnv("integration: theme settings", { db: true }, () => {
  test("default theme is light", async () => {
    const response = await adminGet("/admin/settings");
    const html = await response.text();
    expect(html).toContain('data-theme="light"');
  });

  test("changing theme to dark via admin settings", async () => {
    const { response } = await adminFormPost("/admin/settings/theme", {
      theme: "dark",
    });
    await expectFlashRedirect(
      "/admin/settings?form=settings-theme#settings-theme",
      "Theme set to dark",
    )(response);
  });

  test("dark theme is reflected in HTML after changing", async () => {
    await adminFormPost("/admin/settings/theme", { theme: "dark" });

    const response = await adminGet("/admin/settings");
    const html = await response.text();
    expect(html).toContain('data-theme="dark"');
  });

  test("dark theme is reflected on public pages", async () => {
    await settings.update.showPublicSite(true);
    await adminFormPost("/admin/settings/theme", { theme: "dark" });

    const response = await handleRequest(mockRequest("/"));
    const html = await response.text();
    expect(html).toContain('data-theme="dark"');
  });

  test("switching back to light theme", async () => {
    await adminFormPost("/admin/settings/theme", { theme: "dark" });
    await adminFormPost("/admin/settings/theme", { theme: "light" });

    const response = await adminGet("/admin/settings");
    const html = await response.text();
    expect(html).toContain('data-theme="light"');
  });

  test("links are not underlined by default (no data-underline-links)", async () => {
    const response = await adminGet("/admin/settings");
    const html = await response.text();
    expect(html).not.toContain("data-underline-links");
  });

  test("enabling underline links adds data-underline-links to the page", async () => {
    await adminFormPost("/admin/settings/theme", {
      theme: "light",
      underline_links: "true",
    });

    const response = await adminGet("/admin/settings");
    const html = await response.text();
    expect(html).toContain("data-underline-links");
  });

  test("underline links setting is reflected on public pages", async () => {
    await settings.update.showPublicSite(true);
    await adminFormPost("/admin/settings/theme", {
      theme: "light",
      underline_links: "true",
    });

    const response = await handleRequest(mockRequest("/"));
    const html = await response.text();
    expect(html).toContain("data-underline-links");
  });
});
