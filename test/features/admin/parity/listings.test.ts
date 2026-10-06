// Behaviour pins for the listing resource: what each surface answers today,
// one test per fact. The page posts to /admin/listing (multipart, owner
// cookie); the JSON API posts to /api/admin/listings (CONTENT_API). The role
// parity, editor field locks, and money redaction are pinned in
// listing-write-roles.test.ts and the api-*.test.ts suites.
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingGroups } from "#db/groups/table.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import {
  assertJson,
  expectFlashRedirect,
  expectRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { buildCreateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { doAuthenticatedMultipartFormRequest } from "#test-utils/db-helpers/request.ts";
import { testListingInput } from "#test-utils/factories.ts";
import {
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";
import type { ListingWithCount } from "#types";
import { ownerApiPost, ownerPagePost } from "./helpers.ts";

describeWithEnv("Listing parity pins", { db: true }, () => {
  test("api create parses day prices, dropping day zero", async () => {
    await assertJson(
      ownerApiPost("/api/admin/listings", {
        day_prices: { 0: 900, 1: 0, 2: 1200 },
        listing_type: "standard",
        max_attendees: 10,
        name: "Pinned Day Prices",
      }),
      201,
      (body) => {
        expect(body.listing.day_prices).toEqual({ 1: 0, 2: 1200 });
      },
    );
  });

  test("api create links the posted groups", async () => {
    const group = await createTestGroup({ name: "Pinned Price Group" });
    const created = await assertJson<{ listing: { id: number } }>(
      ownerApiPost("/api/admin/listings", {
        group_ids: [group.id],
        listing_type: "standard",
        max_attendees: 10,
        name: "Pinned Grouped Listing",
      }),
      201,
    );
    expect(await listingGroups.getIds(created.listing.id)).toEqual([group.id]);
  });

  test("page create links the posted groups the same way", async () => {
    const group = await createTestGroup({ name: "Pinned Page Grouped Group" });
    // The real multipart page request carries group_ids, so this pin proves
    // the create route persists the join — no test helper writes it.
    const listing = await doAuthenticatedMultipartFormRequest(
      "/admin/listing",
      {
        ...buildCreateListingForm(
          testListingInput({ name: "Pinned Page Grouped Listing" }),
        ),
        group_ids: [String(group.id)],
      },
      async () => {
        const { getAllListings } = await import("#db/listings/records.ts");
        const listings = await getAllListings();
        return listings[0] as ListingWithCount;
      },
      "create listing",
    );
    expect(await listingGroups.getIds(listing.id)).toEqual([group.id]);
  });

  test("api update refuses a non-string name with the field message", async () => {
    // Issue #2476: the shared update parser refused to coerce a non-string
    // name into stored text.
    const listing = await createTestListing({ name: "Pinned Name Type" });
    const response = await handleRequest(
      requestAsSession(
        `/api/admin/listings/${listing.id}`,
        {
          cookie: await testCookie(),
          csrfToken: await testCsrfToken(),
        },
        {
          body: JSON.stringify({ name: 123 }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        },
      ),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("name must be a string");
    expect((await getListingWithCount(listing.id))?.name).toBe(
      "Pinned Name Type",
    );
  });

  test("both deactivate routes flip active and refuse a repeat", async () => {
    const pageListing = await createTestListing({ name: "Pinned Page Toggle" });
    const apiListing = await createTestListing({ name: "Pinned Api Toggle" });

    // The page toggle is a typed-identifier confirmation: the form re-states
    // the listing name.
    const page = await ownerPagePost(
      `/admin/listing/${pageListing.id}/deactivate`,
      {
        confirm_identifier: "Pinned Page Toggle",
      },
    );
    expectRedirectWithFlash(
      `/admin/listing/${pageListing.id}`,
      "Listing deactivated",
    )(page);
    expect((await getListingWithCount(pageListing.id))?.active).toBe(false);

    // The page guard refuses an already deactivated listing with the same
    // plain-words rule the JSON API applies, so the surfaces agree.
    const pageRepeat = await ownerPagePost(
      `/admin/listing/${pageListing.id}/deactivate`,
      {
        confirm_identifier: "Pinned Page Toggle",
      },
    );
    await expectFlashRedirect(
      `/admin/listing/${pageListing.id}/deactivate`,
      t("error.listing_already_deactivated"),
      false,
    )(pageRepeat);
    expect((await getListingWithCount(pageListing.id))?.active).toBe(false);

    const deactivateViaApi = (id: number) =>
      ownerApiPost(`/api/admin/listings/${id}/deactivate`, {});
    const api = await deactivateViaApi(apiListing.id);
    expect(api.status).toBe(200);
    expect((await getListingWithCount(apiListing.id))?.active).toBe(false);

    const apiRepeat = await deactivateViaApi(apiListing.id);
    expect(apiRepeat.status).toBe(400);
    expect((await apiRepeat.json()).error).toContain("already deactivated");
  });
});
