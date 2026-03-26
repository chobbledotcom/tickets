import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#lib/db/settings.ts";
import { adminGet, createTestEvent, describeWithEnv } from "#test-utils";

describeWithEnv("integration: currency from country", { db: true }, () => {
  test("default country GB uses GBP (pound symbol)", async () => {
    const { response } = await adminGet("/admin/guide");
    const html = await response.text();
    // The guide page renders formatCurrency(1000) which is £10.00 for GBP
    expect(html).toContain("£10");
  });

  test("switching country to US uses USD (dollar symbol)", async () => {
    await settings.update.country("US");

    const { response } = await adminGet("/admin/guide");
    const html = await response.text();
    expect(html).toContain("$10");
  });

  test("switching country to JP uses JPY (yen symbol, no decimals)", async () => {
    await settings.update.country("JP");

    const { response } = await adminGet("/admin/guide");
    const html = await response.text();
    expect(html).toContain("¥");
  });

  test("switching country to DE uses EUR (euro symbol)", async () => {
    await settings.update.country("DE");

    const { response } = await adminGet("/admin/guide");
    const html = await response.text();
    expect(html).toContain("€");
  });

  test("currency is reflected on admin dashboard", async () => {
    await settings.update.country("US");
    await createTestEvent({ unitPrice: 1000 });

    const { response } = await adminGet("/admin");
    const html = await response.text();
    // Dashboard shows income with formatCurrency, should use $ for USD
    expect(html).toContain("$");
  });
});
