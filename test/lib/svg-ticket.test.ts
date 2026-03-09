import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  buildInfoLines,
  extractSvgContent,
  extractViewBox,
  generateSvgTicket,
  type SvgTicketData,
} from "#lib/svg-ticket.ts";
import { setCurrencyCodeForTest } from "#lib/currency.ts";
import { createTestDbWithSetup, resetDb } from "#test-utils";

const makeTicketData = (overrides: Partial<SvgTicketData> = {}): SvgTicketData => ({
  eventName: "Summer Concert",
  eventDate: "",
  eventLocation: "",
  attendeeDate: null,
  quantity: 1,
  pricePaid: "0",
  currency: "GBP",
  checkinUrl: "https://example.com/checkin/abc123",
  ...overrides,
});

describe("svg-ticket", () => {
  beforeEach(async () => {
    setCurrencyCodeForTest("GBP");
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("extractSvgContent", () => {
    test("extracts inner content from svg element", () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect/></svg>';
      expect(extractSvgContent(svg)).toBe("<rect/>");
    });

    test("returns empty string when no svg element found", () => {
      expect(extractSvgContent("<div>not svg</div>")).toBe("");
    });
  });

  describe("extractViewBox", () => {
    test("parses viewBox dimensions", () => {
      const svg = '<svg viewBox="0 0 33 33"><rect/></svg>';
      expect(extractViewBox(svg)).toEqual({ width: 33, height: 33 });
    });

    test("returns default size when no viewBox", () => {
      const svg = '<svg><rect/></svg>';
      expect(extractViewBox(svg)).toEqual({ width: 180, height: 180 });
    });

    test("falls back to defaults for incomplete viewBox", () => {
      const svg = '<svg viewBox="0 0"><rect/></svg>';
      expect(extractViewBox(svg)).toEqual({ width: 180, height: 180 });
    });
  });

  describe("buildInfoLines", () => {
    test("includes quantity for free event", () => {
      const lines = buildInfoLines(makeTicketData());
      expect(lines).toEqual(["Qty: 1"]);
    });

    test("includes price for paid event", () => {
      const lines = buildInfoLines(makeTicketData({ pricePaid: "2500" }));
      expect(lines).toContainEqual("Qty: 1");
      expect(lines.some((l) => l.includes("Price:"))).toBe(true);
    });

    test("includes event date when provided", () => {
      const lines = buildInfoLines(makeTicketData({ eventDate: "2026-06-15T18:00:00.000Z" }));
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[0]).toContain("June");
    });

    test("includes location when provided", () => {
      const lines = buildInfoLines(makeTicketData({ eventLocation: "The Venue" }));
      expect(lines).toContain("The Venue");
    });

    test("includes booking date for daily events", () => {
      const lines = buildInfoLines(makeTicketData({ attendeeDate: "2026-06-15" }));
      expect(lines.some((l) => l.startsWith("Booking:"))).toBe(true);
    });

    test("omits price when zero", () => {
      const lines = buildInfoLines(makeTicketData({ pricePaid: "0" }));
      expect(lines.every((l) => !l.includes("Price:"))).toBe(true);
    });
  });

  describe("generateSvgTicket", () => {
    test("returns valid SVG document", async () => {
      const svg = await generateSvgTicket(makeTicketData());
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain("</svg>");
    });

    test("includes event name", async () => {
      const svg = await generateSvgTicket(makeTicketData({ eventName: "Jazz Night" }));
      expect(svg).toContain("Jazz Night");
    });

    test("escapes HTML in event name", async () => {
      const svg = await generateSvgTicket(makeTicketData({ eventName: "A <B> & C" }));
      expect(svg).toContain("A &lt;B&gt; &amp; C");
      expect(svg).not.toContain("<B>");
    });

    test("includes QR code content", async () => {
      const svg = await generateSvgTicket(makeTicketData());
      // QR code generates path elements
      expect(svg).toContain("<path");
    });

    test("different checkin URLs produce different SVGs", async () => {
      const svg1 = await generateSvgTicket(makeTicketData({ checkinUrl: "https://example.com/checkin/aaa" }));
      const svg2 = await generateSvgTicket(makeTicketData({ checkinUrl: "https://example.com/checkin/bbb" }));
      expect(svg1).not.toBe(svg2);
    });

    test("includes quantity in output", async () => {
      const svg = await generateSvgTicket(makeTicketData({ quantity: 3 }));
      expect(svg).toContain("Qty: 3");
    });

    test("includes price for paid tickets", async () => {
      const svg = await generateSvgTicket(makeTicketData({ pricePaid: "1500" }));
      expect(svg).toContain("Price:");
    });

    test("includes location when provided", async () => {
      const svg = await generateSvgTicket(makeTicketData({ eventLocation: "Main Hall" }));
      expect(svg).toContain("Main Hall");
    });

    test("includes event date when provided", async () => {
      const svg = await generateSvgTicket(makeTicketData({ eventDate: "2026-06-15T18:00:00.000Z" }));
      expect(svg).toContain("June");
    });
  });
});
