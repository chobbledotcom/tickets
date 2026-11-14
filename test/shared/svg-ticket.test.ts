import { assert, assertArrayIncludes, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildInfoLines,
  extractSvgContent,
  extractViewBox,
  generateSvgTicket,
  type SvgTicketData,
  ticketBodyBlock,
} from "#shared/svg-ticket.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";

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
    test("reads the content the SVG element wraps, and nothing else", () => {
      expect(
        extractSvgContent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect/></svg>',
        ),
      ).toBe("<rect/>");
      expect(extractSvgContent("<div>not svg</div>")).toBe("");
    });
  });

  describe("extractViewBox", () => {
    test("reads the width and height the viewBox names", () => {
      expect(extractViewBox('<svg viewBox="0 0 33 44"><rect/></svg>')).toEqual({
        height: 44,
        width: 33,
      });
    });

    test("defaults a side the viewBox does not name", () => {
      expect(extractViewBox("<svg><rect/></svg>")).toEqual({
        height: 180,
        width: 180,
      });
      expect(extractViewBox('<svg viewBox="0 0">')).toEqual({
        height: 180,
        width: 180,
      });
    });

    test("keeps a zero side instead of the default", () => {
      const flat = extractViewBox('<svg viewBox="0 0 33 0">');
      const thin = extractViewBox('<svg viewBox="0 0 0 44">');

      expect([flat.width, flat.height]).toEqual([33, 0]);
      expect([thin.width, thin.height]).toEqual([0, 44]);
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
      assertStringIncludes(lines[0] ?? "", "June");
    });

    test("includes location when provided", () => {
      const lines = buildInfoLines(
        makeTicketData({ listingLocation: "The Venue" }),
      );
      assertArrayIncludes(lines, ["The Venue"]);
    });

    test("includes booking date for daily listings", () => {
      const lines = buildInfoLines(
        makeTicketData({ attendeeDate: "2026-06-15" }),
      );
      expect(lines.some((l) => l.startsWith("Booking:"))).toBe(true);
    });

    test("includes a price above zero and omits a zero price", () => {
      expect(buildInfoLines(makeTicketData({ pricePaid: "0" }))).toEqual([
        "Qty: 1",
      ]);
      const paid = buildInfoLines(makeTicketData({ pricePaid: "1" }));
      expect(paid).toHaveLength(2);
      expect(paid[1]).toMatch(/^Price:/);
    });
  });

  describe("ticketBodyBlock", () => {
    test("draws the ticket facts and the QR picture", () => {
      const block = ticketBodyBlock(
        makeTicketData({ listingLocation: "The Venue" }),
        "ticket.png",
      );

      expectIncludesAll(block, [
        '<div style="margin:24px 0;max-width:400px;',
        "Summer Concert",
        "Qty: 1",
        "The Venue",
        '<img src="cid:ticket.png" alt="Ticket QR code"',
        "</div>",
      ]);
      expect(block).toContain(
        'The Venue</p><p style="margin:4px 0;font-size:13px;color:#555">Qty: 1',
      );
    });

    test("escapes the facts a reader sees", () => {
      const block = ticketBodyBlock(
        makeTicketData({
          listingLocation: "<Hall>",
          listingName: "A <B> & C",
        }),
        null,
      );

      expectIncludesAll(block, ["A &lt;B&gt; &amp; C", "&lt;Hall&gt;"]);
      assert(!block.includes("<B>"));
    });

    test("leaves out the picture when the ticket has no QR code", () => {
      const block = ticketBodyBlock(makeTicketData(), null);

      assert(!block.includes("<img"));
      assertStringIncludes(block, "Qty: 1");
      expect(block.endsWith("</p></div>")).toBe(true);
    });
  });

  describe("generateSvgTicket", () => {
    test("returns valid SVG document with XML declaration", async () => {
      const svg = await generateSvgTicket(makeTicketData());
      expect(svg).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
      expectIncludesAll(svg, [
        '<svg xmlns="http://www.w3.org/2000/svg"',
        "</svg>",
      ]);
    });

    test("includes listing name", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ listingName: "Jazz Night" }),
      );
      assertStringIncludes(svg, "Jazz Night");
    });

    test("escapes HTML in listing name", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ listingName: "A <B> & C" }),
      );
      assertStringIncludes(svg, "A &lt;B&gt; &amp; C");
      assert(!svg.includes("<B>"));
    });

    test("includes QR code content", async () => {
      const svg = await generateSvgTicket(makeTicketData());
      // QR code generates path elements
      assertStringIncludes(svg, "<path");
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

    test("includes the quantity, price, place and date", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({
          listingDate: "2026-06-15T18:00:00.000Z",
          listingLocation: "Main Hall",
          pricePaid: "1500",
          quantity: 3,
        }),
      );

      expectIncludesAll(svg, ["Qty: 3", "Price:", "Main Hall", "June"]);
    });

    test("places each info line one line height below the last", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({
          attendeeDate: "2026-06-15",
          listingLocation: "The Venue",
        }),
      );

      expectIncludesAll(svg, ['y="62"', 'y="84"', 'y="106"']);
      expect(svg).toContain('</text>\n    <text x="24" y="84"');
    });

    test("sets the document height from the facts", async () => {
      expect(await generateSvgTicket(makeTicketData())).toContain(
        'height="282" viewBox="0 0 400 282"',
      );
      expect(
        await generateSvgTicket(makeTicketData({ purchaseOnly: true })),
      ).toContain('height="86" viewBox="0 0 400 86"');
    });

    test("centres the QR code and scales it into the ticket", async () => {
      const svg = await generateSvgTicket(makeTicketData());

      expect(svg).toContain(
        '<g transform="translate(110, 78) scale(0.5806451612903226)"',
      );
    });

    test("omits QR code when purchaseOnly is true", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({ purchaseOnly: true }),
      );
      assertStringIncludes(svg, "Summer Concert");
      assert(!svg.includes("<path"));
      assert(!svg.includes("checkin"));
      expect(svg.endsWith("</text>\n</svg>")).toBe(true);
    });

    test("includes listing name and info lines when purchaseOnly is true", async () => {
      const svg = await generateSvgTicket(
        makeTicketData({
          listingLocation: "Online",
          pricePaid: "1000",
          purchaseOnly: true,
        }),
      );
      expectIncludesAll(svg, ["Summer Concert", "Online", "Price:"]);
    });
  });
});
