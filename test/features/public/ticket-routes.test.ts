/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { handleTicketQrGet } from "#routes/public/ticket-routes.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

/* jscpd:ignore-end */

describeWithEnv("public ticket routes", { db: true }, () => {
  test("a listing's QR answers with an SVG of its ticket address", async () => {
    await enablePublicSite();
    const listing = await createTestListing({ name: "Kayak Tour" });
    const response = await handleTicketQrGet(mockRequest("/"), {
      slug: listing.slug,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(await response.text()).toContain("svg");
  });

  test("an unknown slug has no QR", async () => {
    const response = await handleTicketQrGet(mockRequest("/"), {
      slug: "no-such-thing",
    });
    expect(response.status).toBe(404);
  });

  test("a group's QR exists only while the group offers something bookable", async () => {
    await enablePublicSite();
    // A memberless group renders no bookable quantity, so its QR 404s.
    const empty = await createTestGroup({ name: "Empty Barn" });
    const refused = await handleTicketQrGet(mockRequest("/"), {
      slug: empty.slug,
    });
    expect(refused.status).toBe(404);

    const bookable = await createTestGroup({ name: "Full Barn" });
    await createTestListing({ groupId: bookable.id, name: "Full Barn Stall" });
    const served = await handleTicketQrGet(mockRequest("/"), {
      slug: bookable.slug,
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/svg+xml");
  });

  test("the ticket page answers a group slug the listing path cannot", async () => {
    await enablePublicSite();
    const group = await createTestGroup({ name: "Stargazing" });
    await createTestListing({ groupId: group.id, name: "Stargazing Slot" });
    const response = await handleRequest(mockRequest(`/ticket/${group.slug}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Stargazing");
  });
});
