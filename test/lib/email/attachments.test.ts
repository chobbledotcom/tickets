import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildSvgTicketData,
  buildTicketAttachments,
} from "#lib/email.ts";
import { describeWithEnv, makeTestEntry as makeEntry } from "#test-utils";

describeWithEnv("buildSvgTicketData", { db: true }, () => {
  test("maps entry fields to SvgTicketData", () => {
    const data = buildSvgTicketData(
      makeEntry(
        { name: "Concert" },
        { quantity: 2, price_paid: "1500", ticket_token: "tok123" },
      ),
      "GBP",
    );
    expect(data.eventName).toBe("Concert");
    expect(data.quantity).toBe(2);
    expect(data.pricePaid).toBe("1500");
    expect(data.checkinUrl).toContain("/checkin/tok123");
  });

  test("includes attendee date for daily events", () => {
    const data = buildSvgTicketData(
      makeEntry({}, { date: "2026-06-15" }),
      "GBP",
    );
    expect(data.attendeeDate).toBe("2026-06-15");
  });

  test("includes event date and location from event", () => {
    const data = buildSvgTicketData(
      makeEntry({ date: "2026-07-01T19:00:00Z", location: "Town Hall" }),
      "GBP",
    );
    expect(data.eventDate).toBe("2026-07-01T19:00:00Z");
    expect(data.eventLocation).toBe("Town Hall");
  });

  test("sets purchaseOnly from event flag", () => {
    const data = buildSvgTicketData(
      makeEntry({ purchase_only: true }),
      "GBP",
    );
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

    const binary = atob(attachments[0]!.content);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toContain("<?xml");
    expect(decoded).toContain("<svg");
    expect(decoded).toContain("</svg>");
  });

  test("attachment preserves non-ASCII characters via UTF-8 encoding", async () => {
    const attachments = await buildTicketAttachments(
      [makeEntry({ name: "Cafe Musik", location: "Zurich" })],
      "GBP",
    );

    const binary = atob(attachments[0]!.content);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toContain("Cafe Musik");
    expect(decoded).toContain("Zurich");
  });
});
