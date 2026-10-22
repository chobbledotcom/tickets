/** Direct tests for the ticket view route's own dispatch. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingsTable } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { routeTicketView } from "#routes/tickets/index.ts";
import { generateQrSvg } from "#shared/qr.ts";
import { buildCheckinUrl } from "#shared/ticket-url.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { mockRequest } from "#test-utils/mocks.ts";

describe("routeTicketView", () => {
  test("claims no route for a method other than GET", async () => {
    const request = new Request("http://localhost/t/some-token", {
      method: "POST",
    });
    const result = await routeTicketView(request, "/t/some-token", "POST");
    expect(result).toBeNull();
  });

  test("claims no route when the path carries no token", async () => {
    const request = new Request("http://localhost/t/", { method: "GET" });
    const result = await routeTicketView(request, "/t/", "GET");
    expect(result).toBeNull();
  });
});

describeWithEnv("ticket view (/t/:tokens)", { db: true }, () => {
  test("the site footer's image reference renders the image's uid URL", async () => {
    const image = await makeImage("FooterPoster");
    await settings.update.siteFooter(
      `Thanks for coming.![FooterPoster](img#${image.id})`,
    );
    const { token } = await createTestAttendeeWithToken("Ada", "ada@test.com");
    const response = await handleRequest(mockRequest(`/t/${token}`));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      `<img src="/image/${image.filename}" alt="FooterPoster">`,
    );
    expect(html).not.toContain("img#");
  });

  test("shows the holder their ticket and its attachment link", async () => {
    const { listing, token } = await createTestAttendeeWithToken(
      "Ada",
      "ada@test.com",
    );
    await listingsTable.update(listing.id, {
      attachmentName: "Guide.pdf",
      attachmentUrl: "guide.pdf",
    });
    const request = new Request(`http://localhost/t/${token}`);
    const response = await routeTicketView(request, `/t/${token}`, "GET");
    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(200);
    // The signed attachment link renders only for a listing that has one.
    expect(await response!.text()).toContain("/attachment/");
  });

  test("serves the QR SVG with a full-year cache", async () => {
    const { token } = await createTestAttendeeWithToken("Eve", "eve@test.com");
    const request = new Request(`http://localhost/t/${token}/svg`);
    const response = await routeTicketView(request, `/t/${token}/svg`, "GET");
    // A ticket's code never changes, so the image caches for exactly one
    // year and the CDN serves it on every scan.
    expect(response).toBeInstanceOf(Response);
    expect(response!.headers.get("content-type")).toBe("image/svg+xml");
    expect(response!.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    // The code is this token's own check-in URL, encoded as a QR.
    expect(await response!.text()).toBe(
      await generateQrSvg(buildCheckinUrl(token)),
    );
  });
});
