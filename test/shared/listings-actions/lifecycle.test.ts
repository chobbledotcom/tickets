import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingWithCount, listingsTable } from "#db/listings/records.ts";
import { t } from "#i18n";
import {
  buildDuplicateListingInput,
  performListingDelete,
  toggleListingActive,
} from "#shared/listings-actions.ts";
import { setDeleteOverride } from "#shared/test-overrides.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { rescuingPageSetup } from "#test-utils/listing-parents/helpers.ts";

describeWithEnv("listing action lifecycle", { db: true }, () => {
  const errors = setupErrorSpy();

  test("duplicates listing fields but clears source-owned attachment data", async () => {
    const source = await createTestListing({
      attachmentName: "guide.pdf",
      attachmentUrl: "guide.pdf",
      name: "Original Listing",
    });

    const duplicate = await buildDuplicateListingInput(source, {
      name: "Copied Listing",
    });

    expect(duplicate.name).toBe("Copied Listing");
    expect(duplicate.attachmentName).toBe("");
    expect(duplicate.attachmentUrl).toBe("");
    expect(duplicate.slug).not.toBe(source.slug);
    expect("created" in duplicate).toBe(false);
  });

  test("labels an attachment failure while still deleting the listing", async () => {
    const listing = await createTestListing({ name: "Delete Failure" });
    await listingsTable.update(listing.id, {
      attachmentName: "guide.pdf",
      attachmentUrl: "guide.pdf",
    });
    setDeleteOverride(new Error("storage unavailable"));
    try {
      await performListingDelete((await getListingWithCount(listing.id))!);
    } finally {
      setDeleteOverride(null);
    }

    expect(errors.contains("listing deletion")).toBe(true);
    expect(await getListingWithCount(listing.id)).toBeNull();
  });

  test("does not toggle off the only page that can offer a child add-on", async () => {
    const { thatPage } = await rescuingPageSetup();
    const listing = (await getListingWithCount(thatPage.id))!;

    expect(await toggleListingActive(thatPage.id, listing, false)).toEqual({
      error: t("modifiers.err_child_only_addon", {
        name: "Child-scoped extra",
      }),
    });
    expect((await getListingWithCount(thatPage.id))?.active).toBe(true);
  });
});
