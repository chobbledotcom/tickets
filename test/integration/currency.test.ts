import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  adminGet,
  createTestListing,
  describeWithEnv,
  seedCountry,
} from "#test-utils";

describeWithEnv("integration: currency from country", { db: true }, () => {
  test("default country GB uses GBP (pound symbol)", async () => {
    const response = await adminGet("/admin/guide");
    const html = await response.text();
    // The guide page renders formatCurrency(1000) which is £10.00 for GBP
    expect(html).toContain("£10");
  });

  test("country US derives USD (dollar symbol)", async () => {
    await seedCountry("US");

    const response = await adminGet("/admin/guide");
    const html = await response.text();
    expect(html).toContain("$10");
  });

  test("country JP derives JPY (yen symbol, no decimals)", async () => {
    await seedCountry("JP");

    const response = await adminGet("/admin/guide");
    const html = await response.text();
    expect(html).toContain("¥");
  });

  test("country DE derives EUR (euro symbol)", async () => {
    await seedCountry("DE");

    const response = await adminGet("/admin/guide");
    const html = await response.text();
    expect(html).toContain("€");
  });

  test("currency is reflected on admin dashboard", async () => {
    await seedCountry("US");
    await createTestListing({ unitPrice: 1000 });

    const response = await adminGet("/admin");
    const html = await response.text();
    // Dashboard shows income with formatCurrency, should use $ for USD
    expect(html).toContain("$");
  });
});
