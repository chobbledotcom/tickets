import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildSvgTicketData, buildTicketAttachments } from "#shared/email.ts";
import { describeWithEnv, makeTestEntry as makeEntry } from "#test-utils";

const decodeAttachmentContent = (attachment: { content: string }): string => {
  const binary = atob(attachment.content);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

describeWithEnv("buildSvgTicketData", { db: true }, () => {
  test("maps entry fields to SvgTicketData", () => {
    const data = buildSvgTicketData(
      makeEntry(
        { name: "Concert" },
        { price_paid: "1500", quantity: 2, ticket_token: "tok123" },
      ),
      "GBP",
    );
    expect(data.listingName).toBe("Concert");
    expect(data.quantity).toBe(2);
    expect(data.pricePaid).toBe("1500");
    expect(data.checkinUrl).toContain("/checkin/tok123");
  });

  test("includes attendee date for daily listings", () => {
    const data = buildSvgTicketData(
      makeEntry({}, { date: "2026-06-15" }),
      "GBP",
    );
    expect(data.attendeeDate).toBe("2026-06-15");
  });

  test("includes listing date and location from listing", () => {
    const data = buildSvgTicketData(
      makeEntry({ date: "2026-07-01T19:00:00Z", location: "Town Hall" }),
      "GBP",
    );
    expect(data.listingDate).toBe("2026-07-01T19:00:00Z");
    expect(data.listingLocation).toBe("Town Hall");
  });

  test("sets purchaseOnly from listing flag", () => {
    const data = buildSvgTicketData(makeEntry({ purchase_only: true }), "GBP");
    expect(data.purchaseOnly).toBe(true);
  });

  test("passes currency through to ticket data", () => {
    const data = buildSvgTicketData(makeEntry(), "USD");
    expect(data.currency).toBe("USD");
  });
});

describe("buildTicketAttachments", () => {
  test("generates one attachment per entry", async () => {
    const entries = [
      makeEntry({}, { ticket_token: "tok1" }),
      makeEntry({}, { ticket_token: "tok2" }),
    ];
    const attachments = await buildTicketAttachments(entries, "GBP");

    expect(attachments.length).toBe(2);
    expect(attachments[0]!.filename).toBe("ticket-1.svg");
    expect(attachments[1]!.filename).toBe("ticket-2.svg");
    expect(attachments[0]!.contentType).toBe("image/svg+xml");
  });

  test("uses 'ticket.svg' filename for single entry", async () => {
    const attachments = await buildTicketAttachments([makeEntry()], "GBP");

    expect(attachments.length).toBe(1);
    expect(attachments[0]!.filename).toBe("ticket.svg");
  });

  test("attachment content is base64-encoded UTF-8 SVG", async () => {
    const attachments = await buildTicketAttachments([makeEntry()], "GBP");

    const decoded = decodeAttachmentContent(attachments[0]!);
    expect(decoded).toContain("<?xml");
    expect(decoded).toContain("<svg");
    expect(decoded).toContain("</svg>");
  });

  test("attachment preserves non-ASCII characters via UTF-8 encoding", async () => {
    const attachments = await buildTicketAttachments(
      [makeEntry({ location: "Zurich", name: "Cafe Musik" })],
      "GBP",
    );

    const decoded = decodeAttachmentContent(attachments[0]!);
    expect(decoded).toContain("Cafe Musik");
    expect(decoded).toContain("Zurich");
  });
});
