import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { MAX_SEED_LISTINGS, seedsForm } from "#routes/admin/seeds.ts";
import { getDb } from "#shared/db/client.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { SEED_MAX_ATTENDEES } from "#shared/seeds.ts";
import {
  expectFlashRedirect,
  expectHtmlContains,
  inputNamed,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { postSeeds } from "#test-utils/seeds.ts";
import { testCookie } from "#test-utils/session.ts";

describeWithEnv("admin seeds handler", { db: true }, () => {
  // The expected attributes are written out here, not read back from the form
  // definition, so a changed default or bound fails this test instead of
  // moving the expectation along with it. The two shared ceilings are the
  // constants the clamp itself uses.
  const expectedBoxes = [
    { from: "1", name: "listing_count", starts: "5", upTo: MAX_SEED_LISTINGS },
    {
      from: "0",
      name: "attendees_per_listing",
      starts: "10",
      upTo: SEED_MAX_ATTENDEES,
    },
  ];

  for (const box of expectedBoxes) {
    test(`serves the ${box.name} box with its bounds and default`, () => {
      expectHtmlContains(inputNamed(seedsForm.render(), box.name), [
        `id="${box.name}"`,
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
    expect(await response.text()).toContain(t("admin.seeds.heading"));
  });

  test("creates the asked-for listings and says exactly what was made", async () => {
    const response = await postSeeds({
      attendees_per_listing: "0",
      listing_count: "2",
    });

    await expectFlashRedirect(
      "/admin/seeds",
      t("admin.seeds.created", { attendees: 0, listings: 2 }),
    )(response);
    expect((await getAllListings()).length).toBe(2);
  });

  test("clamps a listing count past the ceiling down to the ceiling", async () => {
    const response = await postSeeds({
      attendees_per_listing: "0",
      listing_count: "999",
    });

    await expectFlashRedirect(
      "/admin/seeds",
      t("admin.seeds.created", { attendees: 0, listings: MAX_SEED_LISTINGS }),
    )(response);
  });

  test("clamps negative counts up to the floor", async () => {
    const response = await postSeeds({
      attendees_per_listing: "-10",
      listing_count: "-5",
    });

    await expectFlashRedirect(
      "/admin/seeds",
      t("admin.seeds.created", { attendees: 0, listings: 1 }),
    )(response);
  });

  test("says seed data could not be made when setup is incomplete", async () => {
    // Remove the public key so creating seed attendees cannot work.
    await getDb().execute("DELETE FROM settings WHERE key = 'public_key'");
    settings.invalidateCache();

    const response = await postSeeds({
      attendees_per_listing: "0",
      listing_count: "1",
    });

    await expectFlashRedirect(
      "/admin/seeds",
      t("admin.seeds.failed"),
      false,
    )(response);
  });

  test("rejects a non-numeric listing count", async () => {
    const response = await postSeeds({
      attendees_per_listing: "2",
      listing_count: "abc",
    });

    await expectFlashRedirect(
      "/admin/seeds",
      "Number of listings is invalid.",
      false,
    )(response);
  });

  test("rejects non-numeric attendees per listing", async () => {
    const response = await postSeeds({
      attendees_per_listing: "abc",
      listing_count: "1",
    });

    await expectFlashRedirect(
      "/admin/seeds",
      "Attendees per listing is invalid.",
      false,
    )(response);
  });
});
