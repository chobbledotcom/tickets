import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import {
  adminGet,
  assertAdminHtml,
  describeWithEnv,
  expectHtmlResponse,
} from "#test-utils";

describeWithEnv("integration: header image in layout", { db: true }, () => {
  test("no header image rendered by default", async () => {
    const html = await assertAdminHtml("/admin/settings");
    expect(html).not.toContain('class="header-image"');
  });

  test("header image rendered in page when set via DB", async () => {
    await settings.update.headerImageUrl("my-header.jpg");

    const response = await adminGet("/admin/settings");
    await expectHtmlResponse(
      response,
      200,
      'class="header-image"',
      "/image/my-header.jpg",
    );
  });

  test("header image removed from page after clearing", async () => {
    await settings.update.headerImageUrl("temp-header.jpg");
    await settings.update.headerImageUrl("");

    const html = await assertAdminHtml("/admin/settings");
    expect(html).not.toContain('class="header-image"');
  });
});
