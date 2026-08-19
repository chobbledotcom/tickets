import { afterEach, beforeEach } from "@std/testing/bdd";
import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import {
  buildTemplateData,
  renderEmailContent,
  resetEngine,
  type TemplateData,
} from "#shared/email-renderer.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import { useSetting } from "#test-utils/settings.ts";

export const TICKET_URL = "https://example.com/t/ABC";

export const describeEmailRenderer = (tests: () => void): void => {
  describeWithEnv("email-renderer", { db: true }, () => {
    useSetting({ currency: "GBP" });
    beforeEach(resetEngine);
    afterEach(resetEngine);
    tests();
  });
};

export const buildTestData = (
  entries: ReturnType<typeof makeEntry>[],
  options?: Parameters<typeof buildTemplateData>[3],
): Promise<TemplateData> =>
  buildTemplateData(entries, "GBP", TICKET_URL, options);

export const renderConfirmation = async (): Promise<{
  data: TemplateData;
  result: Awaited<ReturnType<typeof renderEmailContent>>;
}> => {
  settings.invalidateCache();
  await settings.loadKeys(ALL_SETTINGS_KEYS);
  const data = await buildTestData([makeEntry()]);
  const result = await renderEmailContent("confirmation", data);
  return { data, result };
};

export const sampleData: TemplateData = {
  amount_owed: "0",
  attendee: {
    address: "123 St",
    date: null,
    date_range_label: "",
    email: "jane@test.com",
    name: "Jane",
    phone: "555",
    price_paid: "2000",
    quantity: 2,
    special_instructions: "",
  },
  currency: "GBP",
  entries: [
    {
      attendee: {
        address: "123 St",
        date: null,
        date_range_label: "",
        email: "jane@test.com",
        name: "Jane",
        phone: "555",
        price_paid: "2000",
        quantity: 2,
        special_instructions: "",
      },
      listing: { is_paid: true, name: "Concert", slug: "concert" },
    },
  ],
  listing_names: "Concert",
  ticket_url: TICKET_URL,
};
