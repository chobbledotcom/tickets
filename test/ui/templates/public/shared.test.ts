import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { buildTicketListing } from "#booking/model.ts";
import { detectIframeMode } from "#shared/request-context.ts";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import { renderListingImage } from "#templates/public/shared.tsx";
import { ticketViewPage } from "#templates/tickets.tsx";
import {
  registerPublicTemplateHooks,
  ticketListing,
} from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testListingWithCount, testTokenEntry } from "#test-utils/factories.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import type { ListingWithCount } from "#types";

describeWithEnv(
  "listing images",
  { env: { STORAGE_ZONE_KEY: "testkey", STORAGE_ZONE_NAME: "testzone" } },
  () => {
    beforeAll(setupAdminPageTest);
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
        assertStringIncludes(html, "/image/abc123.jpg");
        assertStringIncludes(html, 'alt=""');
        assertStringIncludes(html, 'class="listing-image"');
      });

      test("uses empty alt text for decorative image", () => {
        const html = renderListingImage({
          image_thumb_url: "",
          image_url: "img.jpg",
        });
        assertStringIncludes(html, 'alt=""');
      });

      test("uses escaped alt text when present", () => {
        const html = renderListingImage({
          image_alt_text: 'Front "hero" image',
          image_thumb_url: "",
          image_url: "img.jpg",
        });
        assertStringIncludes(html, 'alt="Front &quot;hero&quot; image"');
      });

      test("uses the thumbnail URL in thumb contexts when one exists", () => {
        const html = renderListingImage(
          { image_thumb_url: "thumb.webp", image_url: "full.webp" },
          "listing-thumbnail",
          { thumb: true },
        );
        assertStringIncludes(html, "/image/thumb.webp");
        assert(!html.includes("/image/full.webp"));
        assertStringIncludes(html, 'class="listing-thumbnail"');
      });

      test("falls back to the full image in thumb contexts when no thumbnail", () => {
        const html = renderListingImage(
          { image_thumb_url: "", image_url: "full.webp" },
          "listing-thumbnail",
          { thumb: true },
        );
        assertStringIncludes(html, "/image/full.webp");
      });

      test("uses the full image outside thumb contexts even when a thumb exists", () => {
        const html = renderListingImage({
          image_thumb_url: "thumb.webp",
          image_url: "full.webp",
        });
        assertStringIncludes(html, "/image/full.webp");
        assert(!html.includes("/image/thumb.webp"));
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

      assertStringIncludes(html, "/image/camp-kit.webp");
      assertStringIncludes(html, 'alt="Camp kit display"');
      assertStringIncludes(
        html,
        '<meta property="og:image" content="https://tickets.example/image/camp-kit.webp">',
      );
      assert(!html.includes('property="og:description"'));
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
        assertStringIncludes(html, "/image/listing-img.jpg");
        assertStringIncludes(html, 'class="listing-image"');
      });

      test("does not show image when image_url is empty", () => {
        const listing = testListingWithCount({ image_url: "" });
        const html = renderSingleListing(listing);
        assert(!html.includes("/image/"));
      });

      test("does not show image in iframe mode", async () => {
        await withRequestContext(() => {
          detectIframeMode(new URL("https://example.com/?iframe=true"));
          const listing = testListingWithCount({
            image_url: "listing-img.jpg",
          });
          const html = renderSingleListing(listing);
          assert(!html.includes("listing-img.jpg"));
        });
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
        assertStringIncludes(html, "/image/img-a.jpg");
        assertStringIncludes(html, "/image/img-b.jpg");
      });

      test("does not show images when image_url is empty", () => {
        const listings = [
          ticketListing({ id: 1, image_url: "", name: "Listing A" }),
        ];
        const html = ticketPage({ listings, slugs: ["slug-a"] });
        assert(!html.includes("/image/"));
      });
    });

    describe("ticketViewPage ticket count", () => {
      const token = "AABB0011CCDDEEFF";

      test("shows '1 Ticket' for single ticket", () => {
        const cards = [
          {
            entry: testTokenEntry({
              attendee: { id: 1 },
              listing: { id: 1 },
            }),
            token,
          },
        ];
        const html = ticketViewPage(cards);
        assertStringIncludes(html, "1 Ticket");
      });

      test("shows '2 Tickets' for multiple tickets", () => {
        const cards = [
          {
            entry: testTokenEntry({
              attendee: { id: 1 },
              listing: { id: 1 },
            }),
            token: "AABB0011CCDDEEF1",
          },
          {
            entry: testTokenEntry({
              attendee: { id: 2 },
              listing: { id: 2 },
            }),
            token: "AABB0011CCDDEEF2",
          },
        ];
        const html = ticketViewPage(cards);
        assertStringIncludes(html, "2 Tickets");
      });
    });

    describe("ticketViewPage with image", () => {
      const token = "AABB0011CCDDEEFF";

      test("shows image when listing has image_url", () => {
        const cards = [
          {
            entry: testTokenEntry({
              listing: { image_url: "ticket-img.jpg" },
            }),
            token,
          },
        ];
        const html = ticketViewPage(cards);
        assertStringIncludes(html, "/image/ticket-img.jpg");
        assertStringIncludes(html, 'class="ticket-card-image"');
      });

      test("does not show image when image_url is empty", () => {
        const cards = [
          {
            entry: testTokenEntry({ listing: { image_url: "" } }),
            token,
          },
        ];
        const html = ticketViewPage(cards);
        assert(!html.includes("ticket-card-image"));
      });
    });
  },
);
