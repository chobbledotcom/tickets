import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildInfoLines,
  extractSvgContent,
  extractViewBox,
  generateSvgTicket,
  type SvgTicketData,
} from "#shared/svg-ticket.ts";
import { describeWithEnv } from "#test-utils";

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
      expect(lines[0]).toContain("June");
    });

    test("includes location when provided", () => {
      const lines = buildInfoLines(
        makeTicketData({ listingLocation: "The Venue" }),
      );
      expect(lines).toContain("The Venue");
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
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain("</svg>");
    });

    test("includes listing name", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ listingName: "Jazz Night" }),
      );
      expect(svg).toContain("Jazz Night");
    });

    test("escapes HTML in listing name", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ listingName: "A <B> & C" }),
      );
      expect(svg).toContain("A &lt;B&gt; &amp; C");
      expect(svg).not.toContain("<B>");
    });

    test("includes QR code content", async () => {
      const svg = await generateSvgTicket(makeTicketData());
      // QR code generates path elements
      expect(svg).toContain("<path");
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
      expect(svg).toContain("Qty: 3");
    });

    test("includes price for paid tickets", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ pricePaid: "1500" }),
      );
      expect(svg).toContain("Price:");
    });

    test("includes location when provided", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ listingLocation: "Main Hall" }),
      );
      expect(svg).toContain("Main Hall");
    });

    test("includes listing date when provided", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ listingDate: "2026-06-15T18:00:00.000Z" }),
      );
      expect(svg).toContain("June");
    });

    test("omits QR code when purchaseOnly is true", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ purchaseOnly: true }),
      );
      expect(svg).toContain("Summer Concert");
      expect(svg).not.toContain("<path");
      expect(svg).not.toContain("checkin");
    });

    test("includes listing name and info lines when purchaseOnly is true", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({
          listingLocation: "Online",
          pricePaid: "1000",
          purchaseOnly: true,
        }),
      );
      expect(svg).toContain("Summer Concert");
      expect(svg).toContain("Online");
      expect(svg).toContain("Price:");
    });
  });
});
