import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { invalidateListingsCache } from "#db/listings/records.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  expectIncludesAll,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  adminFormPost,
  adminGet,
  createTestEditorSession,
  postFormAs,
} from "#test-utils/session.ts";

/** The listing names in the order every list shows them. */
const shownOrder = async (): Promise<string[]> => {
  invalidateListingsCache();
  return (await loadSortedListings()).listings.map((listing) => listing.name);
};

/** Three undated listings, which the automatic order sorts by name. */
const threeListings = async () => ({
  alpha: (await createTestListing({ name: "Alpha" })).id,
  bravo: (await createTestListing({ name: "Bravo" })).id,
  charlie: (await createTestListing({ name: "Charlie" })).id,
});

const move = async (
  id: number,
  place: "after" | "before",
  anchor: number,
  extra: Record<string, string> = {},
) =>
  (
    await adminFormPost(`/admin/listing/${id}/move-${place}`, {
      anchor: String(anchor),
      ...extra,
    })
  ).response;

describeWithEnv("listing order", { db: true }, () => {
  test("the up arrow moves a listing before the one above", async () => {
    const { bravo, charlie } = await threeListings();

    await expectFlashRedirect(
      "/admin/listings",
      "Listing moved",
    )(await move(charlie, "before", bravo));

    expect(await shownOrder()).toEqual(["Alpha", "Charlie", "Bravo"]);
  });

  test("a drop moves a listing several places, and the order stays", async () => {
    const { alpha, charlie } = await threeListings();

    await move(alpha, "after", charlie);

    expect(await shownOrder()).toEqual(["Bravo", "Charlie", "Alpha"]);
  });

  test("a new listing shows first, before the moved ones", async () => {
    const { alpha, bravo } = await threeListings();
    await move(alpha, "after", bravo);

    await createTestListing({ name: "Zulu" });

    expect(await shownOrder()).toEqual(["Zulu", "Bravo", "Alpha", "Charlie"]);
  });

  test("a move beside a filtered neighbour keeps the hidden listing's place", async () => {
    // A filter shows Alpha and Charlie only. Charlie's up arrow names Alpha.
    const { alpha, charlie } = await threeListings();

    await move(charlie, "before", alpha);

    expect(await shownOrder()).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  test("brings the operator back to the page with its filters", async () => {
    const { alpha, bravo } = await threeListings();

    await expectFlashRedirect(
      "/admin/listings?group=4",
      "Listing moved",
    )(
      await move(alpha, "after", bravo, {
        returnUrl: "/admin/listings?group=4",
      }),
    );
  });

  test("an editor can move a listing", async () => {
    const { alpha, bravo } = await threeListings();
    const { cookie } = await createTestEditorSession();

    const response = await postFormAs(
      `/admin/listing/${alpha}/move-after`,
      cookie,
      { anchor: String(bravo) },
    );

    expect(response.status).toBe(302);
    expect(await shownOrder()).toEqual(["Bravo", "Alpha", "Charlie"]);
  });

  test("answers 404 for a listing that is not there", async () => {
    const { alpha } = await threeListings();

    expect((await move(99999, "before", alpha)).status).toBe(404);
  });

  test("the listings page offers the handle and the arrows", async () => {
    const { alpha, bravo } = await threeListings();

    const html = await expectHtmlResponse(
      await adminGet("/admin/listings"),
      200,
    );

    expectIncludesAll(html, [
      '<tbody data-sortable="">',
      `data-sortable-path="/admin/listing/${alpha}"`,
      `action="/admin/listing/${alpha}/move-after"`,
      `<input name="anchor" type="hidden" value="${bravo}"`,
      `action="/admin/listing/${bravo}/move-before"`,
    ]);
  });

  test("the dashboard lists listings without moves", async () => {
    await threeListings();

    const html = await expectHtmlResponse(await adminGet("/admin"), 200);

    expect(html.includes("data-sortable")).toBe(false);
  });
});
