/**
 * Every named record refuses a name past the input limit, before its own rule
 * or write command runs. No record can store a name that its edit form then
 * refuses.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { attributeRecord } from "#shared/records/attributes.ts";
import { builtSiteRecord } from "#shared/records/built-sites.ts";
import { externalSourceRecord } from "#shared/records/external-sources.ts";
import { groupRecord } from "#shared/records/groups.ts";
import { holidayRecord } from "#shared/records/holidays.ts";
import { imageRecord } from "#shared/records/images.ts";
import { listingRecord } from "#shared/records/listings.ts";
import { logisticsAgentRecord } from "#shared/records/logistics-agents.ts";
import { modifierRecord } from "#shared/records/modifiers.ts";
import { newsRecord } from "#shared/records/news.ts";
import { sitePageRecord } from "#shared/records/site-pages.ts";
import { statusRecord } from "#shared/records/statuses.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { groupInput } from "#test/features/admin/groups/helpers.ts";
import { builtSiteFormInput } from "#test/shared/db/built-sites/fixtures.ts";
import { inputFor } from "#test/shared/listings-actions/helpers.ts";
import { statusInput } from "#test-utils/db-helpers/attendee-statuses.ts";

const SOURCE_PATTERN = "https://dashboard.stripe.com/invoices/{external_id}";

/** One named record, and a create of it that carries a name. */
type NamedRecordCase = {
  create: (name: string) => Promise<unknown>;
  name: string;
};

const CASES: readonly NamedRecordCase[] = [
  { create: (name) => attributeRecord.create({ name }), name: "Attribute" },
  {
    create: (name) => builtSiteRecord.create(builtSiteFormInput({ name })),
    name: "Built site",
  },
  {
    create: (name) =>
      externalSourceRecord.create({ name, urlPattern: SOURCE_PATTERN }),
    name: "Source",
  },
  {
    create: async (name) => groupRecord.create(await groupInput({ name })),
    name: "Group",
  },
  {
    create: (name) =>
      holidayRecord.create({
        endDate: parseDateStringOrThrow("2026-07-02", "the holiday end date"),
        name,
        startDate: parseDateStringOrThrow(
          "2026-07-01",
          "the holiday start date",
        ),
      }),
    name: "Holiday",
  },
  {
    create: (name) =>
      imageRecord.create({
        altText: "",
        filename: nonEmptyString("name.webp"),
        filenameThumb: nonEmptyString("name-thumb.webp"),
        name,
      }),
    name: "Image",
  },
  {
    create: (name) => listingRecord.create(inputFor({ name })),
    name: "Listing",
  },
  {
    create: (name) => logisticsAgentRecord.create({ name }),
    name: "Logistics agent",
  },
  {
    create: (name) =>
      modifierRecord.create({
        active: true,
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        minVisits: 0,
        name,
        scope: "listings",
        trigger: "automatic",
      }),
    name: "Modifier",
  },
  {
    create: (name) =>
      newsRecord.create({
        content: "",
        metaDescription: "",
        metaTitle: "",
        name,
        snippet: "",
      }),
    name: "News post",
  },
  {
    create: (name) =>
      sitePageRecord.create({
        content: "",
        hidden: false,
        metaDescription: "",
        metaTitle: "",
        name,
        slug: "about",
      }),
    name: "Page",
  },
  {
    create: (name) => statusRecord.create(statusInput(name)),
    name: "Attendee status",
  },
];

describe("the name limit every named record applies", () => {
  for (const { create, name } of CASES) {
    test(`${name} refuses a name past the input limit`, async () => {
      expect(await create("x".repeat(MAX_INPUT_LENGTH + 1))).toEqual({
        kind: "refused",
        message: t("fields.validation.name_max", { max: MAX_INPUT_LENGTH }),
      });
    });
  }
});

describe("the name limit on an update", () => {
  const refusal = {
    kind: "refused",
    message: t("fields.validation.name_max", { max: MAX_INPUT_LENGTH }),
  };
  const longName = "x".repeat(MAX_INPUT_LENGTH + 1);

  test("a table record refuses it before reading the row", async () => {
    expect(await attributeRecord.update(1, { name: longName })).toEqual(
      refusal,
    );
  });

  test("a record with a write command refuses it before its command", async () => {
    expect(
      await sitePageRecord.update(1, {
        content: "",
        hidden: false,
        metaDescription: "",
        metaTitle: "",
        name: longName,
        slug: "about",
      }),
    ).toEqual(refusal);
  });
});
