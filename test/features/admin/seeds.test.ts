import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllListings } from "#db/listings/records.ts";
import { t } from "#i18n";
import { MAX_SEED_LISTINGS, SEED_MAX_ATTENDEES } from "#shared/seeds.ts";
import { seedsForm } from "#templates/fields/seeds.ts";
import {
  expectFlashRedirect,
  expectIncludesAll,
  inputNamed,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { postSeeds } from "#test-utils/seeds.ts";
import { testCookie } from "#test-utils/session.ts";

describeWithEnv("admin seeds handler", { db: true }, () => {
  // The expected attributes are written out here, not read back from the form
  // definition, so a changed default or bound fails this test instead of
  // moving the expectation along with it.
  const expectedBoxes = [
    {
      from: "1",
      id: "listing_count",
      name: "listingCount",
      starts: "5",
      upTo: MAX_SEED_LISTINGS,
    },
    {
      from: "0",
      id: "attendees_per_listing",
      name: "attendeesPerListing",
      starts: "10",
      upTo: SEED_MAX_ATTENDEES,
    },
  ];

  for (const box of expectedBoxes) {
    test(`serves the ${box.name} box with its bounds and default`, () => {
      expectIncludesAll(inputNamed(seedsForm.render(), box.name), [
        `id="${box.id}"`,
        `min="${box.from}"`,
        `max="${box.upTo}"`,
        `value="${box.starts}"`,
        "required",
      ]);
    });
  }
  test("serves the seeds page at its own address", async () => {
    const response = await awaitTestRequest("/admin/seeds", {
      cookie: await testCookie(),
    });
    expect(response.status).toBe(200);
    assertStringIncludes(await response.text(), t("admin.seeds.heading"));
  });

  test("creates the asked-for listings and says exactly what was made", async () => {
    const response = await postSeeds({
      attendeesPerListing: "0",
      listingCount: "2",
    });

    await expectFlashRedirect(
      "/admin/seeds",
      t("admin.seeds.created", { attendees: 0, listings: 2 }),
    )(response);
    expect((await getAllListings()).length).toBe(2);
  });

  test("refuses a listing count past the declared ceiling", async () => {
    const response = await postSeeds({
      attendeesPerListing: "0",
      listingCount: "999",
    });

    await expectFlashRedirect(
      "/admin/seeds",
      t("fields.validation.max_value", {
        label: t("admin.seeds.listing_count_label"),
        max: MAX_SEED_LISTINGS,
      }),
      false,
    )(response);
  });

  test("refuses counts below the declared minimums", async () => {
    const response = await postSeeds({
      attendeesPerListing: "-10",
      listingCount: "-5",
    });

    await expectFlashRedirect(
      "/admin/seeds",
      t("fields.validation.min_value", {
        label: t("admin.seeds.listing_count_label"),
        min: 1,
      }),
      false,
    )(response);
  });

  test("rejects a non-numeric listing count", async () => {
    const response = await postSeeds({
      attendeesPerListing: "2",
      listingCount: "abc",
    });

    await expectFlashRedirect(
      "/admin/seeds",
      "Number of listings must be a whole number",
      false,
    )(response);
  });

  test("rejects non-numeric attendees per listing", async () => {
    const response = await postSeeds({
      attendeesPerListing: "abc",
      listingCount: "1",
    });

    await expectFlashRedirect(
      "/admin/seeds",
      "Attendees per listing must be a whole number",
      false,
    )(response);
  });
});
