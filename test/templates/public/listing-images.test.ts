import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTicketListing } from "#shared/booking/model.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import { renderListingImage } from "#templates/public/shared.tsx";
import { ticketViewPage } from "#templates/tickets.tsx";
import { describeWithEnv } from "#test-utils/db.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

import { registerPublicTemplateHooks, ticketListing } from "./helpers.ts";

describeWithEnv(
  "listing images",
  { env: { STORAGE_ZONE_KEY: "testkey", STORAGE_ZONE_NAME: "testzone" } },
  () => {
    registerPublicTemplateHooks();

    describe("renderListingImage", () => {
      test("returns empty string when image_url is empty", () => {
        const html = renderListingImage({ image_thumb_url: "", image_url: "" });
        expect(html).toBe("");
      });

      test("renders img tag with proxy URL when image_url is set", () => {
        const html = renderListingImage({
          image_thumb_url: "",
          image_url: "abc123.jpg",
        });
        expect(html).toContain("/image/abc123.jpg");
        expect(html).toContain('alt=""');
        expect(html).toContain('class="listing-image"');
      });

      test("uses empty alt text for decorative image", () => {
        const html = renderListingImage({
          image_thumb_url: "",
          image_url: "img.jpg",
        });
        expect(html).toContain('alt=""');
      });

      test("uses escaped alt text when present", () => {
        const html = renderListingImage({
          image_alt_text: 'Front "hero" image',
          image_thumb_url: "",
          image_url: "img.jpg",
        });
        expect(html).toContain('alt="Front &quot;hero&quot; image"');
      });

      test("uses the thumbnail URL in thumb contexts when one exists", () => {
        const html = renderListingImage(
          { image_thumb_url: "thumb.webp", image_url: "full.webp" },
          "listing-thumbnail",
          { thumb: true },
        );
        expect(html).toContain("/image/thumb.webp");
        expect(html).not.toContain("/image/full.webp");
        expect(html).toContain('class="listing-thumbnail"');
      });

      test("falls back to the full image in thumb contexts when no thumbnail", () => {
        const html = renderListingImage(
          { image_thumb_url: "", image_url: "full.webp" },
          "listing-thumbnail",
          { thumb: true },
        );
        expect(html).toContain("/image/full.webp");
      });

      test("uses the full image outside thumb contexts even when a thumb exists", () => {
        const html = renderListingImage({
          image_thumb_url: "thumb.webp",
          image_url: "full.webp",
        });
        expect(html).toContain("/image/full.webp");
        expect(html).not.toContain("/image/thumb.webp");
      });
    });

    test("renders a group image in the ticket header", () => {
      const html = ticketPage({
        baseUrl: "https://tickets.example",
        groupImage: {
          image_alt_text: "Camp kit display",
          image_thumb_url: "camp-kit-thumb.webp",
          image_url: "camp-kit.webp",
        },
        groupName: "Camp Kit",
        listings: [
          buildTicketListing(testListingWithCount(), false, undefined),
        ],
        slugs: ["camp-kit"],
      });

      expect(html).toContain("/image/camp-kit.webp");
      expect(html).toContain('alt="Camp kit display"');
      expect(html).toContain(
        '<meta property="og:image" content="https://tickets.example/image/camp-kit.webp">',
      );
      expect(html).not.toContain('property="og:description"');
    });

    describe("ticketPage with image", () => {
      const renderSingleListing = (ev: ListingWithCount) =>
        ticketPage({
          dates: [],
          listings: [buildTicketListing(ev, false, undefined)],
          slugs: [ev.slug],
          terms: null,
        });

      test("shows listing image when image_url is set", () => {
        const listing = testListingWithCount({ image_url: "listing-img.jpg" });
        const html = renderSingleListing(listing);
        expect(html).toContain("/image/listing-img.jpg");
        expect(html).toContain('class="listing-image"');
      });

      test("does not show image when image_url is empty", () => {
        const listing = testListingWithCount({ image_url: "" });
        const html = renderSingleListing(listing);
        expect(html).not.toContain("/image/");
      });

      test("does not show image in iframe mode", () => {
        detectIframeMode(new URL("https://example.com/?iframe=true"));
        const listing = testListingWithCount({ image_url: "listing-img.jpg" });
        const html = renderSingleListing(listing);
        expect(html).not.toContain("listing-img.jpg");
        detectIframeMode(new URL("https://example.com/"));
      });
    });

    describe("ticketPage with images", () => {
      test("shows image before each listing with image_url", () => {
        const listings = [
          ticketListing({
            id: 1,
            image_url: "img-a.jpg",
            name: "Listing A",
          }),
          ticketListing({
            id: 2,
            image_url: "img-b.jpg",
            name: "Listing B",
          }),
        ];
        const html = ticketPage({ listings, slugs: ["slug-a", "slug-b"] });
        expect(html).toContain("/image/img-a.jpg");
        expect(html).toContain("/image/img-b.jpg");
      });

      test("does not show images when image_url is empty", () => {
        const listings = [
          ticketListing({ id: 1, image_url: "", name: "Listing A" }),
        ];
        const html = ticketPage({ listings, slugs: ["slug-a"] });
        expect(html).not.toContain("/image/");
      });
    });

    describe("ticketViewPage ticket count", () => {
      const token = "AABB0011CCDDEEFF";

      test("shows '1 Ticket' for single ticket", () => {
        const cards = [
          {
            entry: {
              attendee: testAttendee({ id: 1 }),
              listing: testListingWithCount({ id: 1 }),
            },
            token,
          },
        ];
        const html = ticketViewPage(cards);
        expect(html).toContain("1 Ticket");
      });

      test("shows '2 Tickets' for multiple tickets", () => {
        const cards = [
          {
            entry: {
              attendee: testAttendee({ id: 1 }),
              listing: testListingWithCount({ id: 1 }),
            },
            token: "AABB0011CCDDEEF1",
          },
          {
            entry: {
              attendee: testAttendee({ id: 2 }),
              listing: testListingWithCount({ id: 2 }),
            },
            token: "AABB0011CCDDEEF2",
          },
        ];
        const html = ticketViewPage(cards);
        expect(html).toContain("2 Tickets");
      });
    });

    describe("ticketViewPage with image", () => {
      const token = "AABB0011CCDDEEFF";

      test("shows image when listing has image_url", () => {
        const cards = [
          {
            entry: {
              attendee: testAttendee(),
              listing: testListingWithCount({ image_url: "ticket-img.jpg" }),
            },
            token,
          },
        ];
        const html = ticketViewPage(cards);
        expect(html).toContain("/image/ticket-img.jpg");
        expect(html).toContain('class="ticket-card-image"');
      });

      test("does not show image when image_url is empty", () => {
        const cards = [
          {
            entry: {
              attendee: testAttendee(),
              listing: testListingWithCount({ image_url: "" }),
            },
            token,
          },
        ];
        const html = ticketViewPage(cards);
        expect(html).not.toContain("ticket-card-image");
      });
    });
  },
);
