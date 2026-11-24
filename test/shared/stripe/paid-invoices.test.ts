import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#db/settings.ts";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  stripeClient,
  stripePaidInvoice,
} from "#test-utils/stripe/fixtures.ts";

/** Read the paid invoices while Stripe answers `invoices`. */
const readAnswering = async (
  invoices: ReturnType<typeof stripePaidInvoice>[],
) => {
  const client = await stripeClient();
  const list = stub(client.invoices, "listPaid", () =>
    Promise.resolve(invoices),
  );
  try {
    return await stripeApi.readPaidInvoices("sub_1");
  } finally {
    list.restore();
  }
};

describeWithEnv("Stripe paid invoices", { db: true }, () => {
  test("finds the invoices in the site currency", async () => {
    const invoice = stripePaidInvoice({
      currency: settings.currency.toLowerCase(),
    });
    expect(await readAnswering([invoice])).toEqual({
      resource: [invoice],
      status: "found",
    });
  });

  test("finds invoices in another currency, for the recorder to judge", async () => {
    const site = stripePaidInvoice({
      currency: settings.currency.toLowerCase(),
      id: "in_site",
    });
    const foreign = stripePaidInvoice({ currency: "jpy", id: "in_foreign" });
    expect(await readAnswering([site, foreign])).toEqual({
      resource: [site, foreign],
      status: "found",
    });
  });
});
