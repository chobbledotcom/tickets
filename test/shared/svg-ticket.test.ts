import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildInfoLines,
  extractSvgContent,
  extractViewBox,
  generateSvgTicket,
  type SvgTicketData,
} from "#shared/svg-ticket.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { has, says } from "#test-utils/says.ts";

const makeTicketData = (
  overrides: Partial<SvgTicketData> = {},
): SvgTicketData => ({
  attendeeDate: null,
  checkinUrl: "https://example.com/checkin/abc123",
  currency: "GBP",
  listingDate: "",
  listingLocation: "",
  listingName: "Summer Concert",
  pricePaid: "0",
  quantity: 1,
  ...overrides,
});

describeWithEnv("svg-ticket", { db: true }, () => {
  describe("extractSvgContent", () => {
    test("extracts inner content from svg element", () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect/></svg>';
      expect(extractSvgContent(svg)).toBe("<rect/>");
    });

    test("returns empty string when no svg element found", () => {
      expect(extractSvgContent("<div>not svg</div>")).toBe("");
    });
  });

  describe("extractViewBox", () => {
    test("parses viewBox dimensions", () => {
      const svg = '<svg viewBox="0 0 33 33"><rect/></svg>';
      expect(extractViewBox(svg)).toEqual({ height: 33, width: 33 });
    });

    test("returns default size when no viewBox", () => {
      const svg = "<svg><rect/></svg>";
      expect(extractViewBox(svg)).toEqual({ height: 180, width: 180 });
    });

    test("falls back to defaults for incomplete viewBox", () => {
      const svg = '<svg viewBox="0 0"><rect/></svg>';
      expect(extractViewBox(svg)).toEqual({ height: 180, width: 180 });
    });
  });

  describe("buildInfoLines", () => {
    test("includes quantity for free listing", () => {
      const lines = buildInfoLines(makeTicketData());
      expect(lines).toEqual(["Qty: 1"]);
    });

    test("includes price for paid listing", () => {
      const lines = buildInfoLines(makeTicketData({ pricePaid: "2500" }));
      expect(lines).toContainEqual("Qty: 1");
      expect(lines.some((l) => l.includes("Price:"))).toBe(true);
    });

    test("includes listing date when provided", () => {
      const lines = buildInfoLines(
        makeTicketData({ listingDate: "2026-06-15T18:00:00.000Z" }),
      );
      expect(lines.length).toBeGreaterThan(1);
      says(lines[0], "June");
    });

    test("includes location when provided", () => {
      const lines = buildInfoLines(
        makeTicketData({ listingLocation: "The Venue" }),
      );
      has(lines, "The Venue");
    });

    test("includes booking date for daily listings", () => {
      const lines = buildInfoLines(
        makeTicketData({ attendeeDate: "2026-06-15" }),
      );
      expect(lines.some((l) => l.startsWith("Booking:"))).toBe(true);
    });

    test("omits price when zero", () => {
      const lines = buildInfoLines(makeTicketData({ pricePaid: "0" }));
      expect(lines.every((l) => !l.includes("Price:"))).toBe(true);
    });
  });

  describe("generateSvgTicket", () => {
    test("returns valid SVG document with XML declaration", async () => {
      const svg = await generateSvgTicket(makeTicketData());
      expect(svg).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
      says(svg, '<svg xmlns="http://www.w3.org/2000/svg"');
      says(svg, "</svg>");
    });

    test("includes listing name", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ listingName: "Jazz Night" }),
      );
      says(svg, "Jazz Night");
    });

    test("escapes HTML in listing name", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ listingName: "A <B> & C" }),
      );
      says(svg, "A &lt;B&gt; &amp; C");
      assert(!svg.includes("<B>"));
    });

    test("includes QR code content", async () => {
      const svg = await generateSvgTicket(makeTicketData());
      // QR code generates path elements
      says(svg, "<path");
    });

    test("different checkin URLs produce different SVGs", async () => {
      const svg1 = await generateSvgTicket(
        makeTicketData({ checkinUrl: "https://example.com/checkin/aaa" }),
      );
      const svg2 = await generateSvgTicket(
        makeTicketData({ checkinUrl: "https://example.com/checkin/bbb" }),
      );
      expect(svg1).not.toBe(svg2);
    });

    test("includes quantity in output", async () => {
      const svg = await generateSvgTicket(makeTicketData({ quantity: 3 }));
      says(svg, "Qty: 3");
    });

    test("includes price for paid tickets", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ pricePaid: "1500" }),
      );
      says(svg, "Price:");
    });

    test("includes location when provided", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ listingLocation: "Main Hall" }),
      );
      says(svg, "Main Hall");
    });

    test("includes listing date when provided", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ listingDate: "2026-06-15T18:00:00.000Z" }),
      );
      says(svg, "June");
    });

    test("omits QR code when purchaseOnly is true", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ purchaseOnly: true }),
      );
      says(svg, "Summer Concert");
      assert(!svg.includes("<path"));
      assert(!svg.includes("checkin"));
    });

    test("includes listing name and info lines when purchaseOnly is true", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({
          listingLocation: "Online",
          pricePaid: "1000",
          purchaseOnly: true,
        }),
      );
      says(svg, "Summer Concert");
      says(svg, "Online");
      says(svg, "Price:");
    });
  });
});
