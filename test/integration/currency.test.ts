import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { says } from "#test-utils/says.ts";
import { adminGet } from "#test-utils/session.ts";
import { seedCountry } from "#test-utils/settings.ts";

describeWithEnv("integration: currency from country", { db: true }, () => {
  test("default country GB uses GBP (pound symbol)", async () => {
    const response = await adminGet("/admin/guide");
    const html = await response.text();
    // The guide page renders formatCurrency(1000) which is £10.00 for GBP
    says(html, "£10");
  });

  test("country US derives USD (dollar symbol)", async () => {
    await seedCountry("US");

    const response = await adminGet("/admin/guide");
    const html = await response.text();
    says(html, "$10");
  });

  test("country JP derives JPY (yen symbol, no decimals)", async () => {
    await seedCountry("JP");

    const response = await adminGet("/admin/guide");
    const html = await response.text();
    says(html, "¥");
  });

  test("country DE derives EUR (euro symbol)", async () => {
    await seedCountry("DE");

    const response = await adminGet("/admin/guide");
    const html = await response.text();
    says(html, "€");
  });

  test("currency is reflected on admin dashboard", async () => {
    await seedCountry("US");
    await createTestListing({ unitPrice: 1000 });

    const response = await adminGet("/admin");
    const html = await response.text();
    // Dashboard shows income with formatCurrency, should use $ for USD
    says(html, "$");
  });
});
