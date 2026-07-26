import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { smsPage } from "#templates/admin/sms.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

const LISTING = testListingWithCount({ id: 9, name: "Summer show" });

describe("SMS page template", () => {
  beforeAll(setupAdminPageTest);

  test("renders only the queue summary when no attendee is targeted", () => {
    const html = smsPage(OWNER_SESSION, {
      configured: false,
      flash: {},
      history: [{ created: "2026-01-02T03:04:05Z", message: "Ignored" }],
      queueCount: 3,
    });

    expect(html).toContain("<title>Text messages</title>");
    expect(html).toContain("<p>Messages awaiting delivery: 3</p>");
    expect(html).toContain('href="/admin/guide#sms"');
    expect(html).not.toContain("Ignored");
    expect(html).not.toContain("Message history");
    expect(html).not.toContain('action="/admin/sms"');
  });

  test("shows the setup warning and empty history when SMS is unconfigured", () => {
    const attendee = testAttendee({ id: 4, name: "Ada", phone: "07123" });
    const html = smsPage(OWNER_SESSION, {
      configured: false,
      flash: { error: "Gateway unavailable" },
      history: [],
      queueCount: 1,
      target: { attendee, listing: LISTING },
    });

    expect(html).toContain("<title>Contact: Ada</title>");
    expect(html).toContain("Gateway unavailable");
    expect(html).toContain('href="/admin/attendees/4"');
    expect(html).toContain("<strong>Phone:</strong> 07123");
    expect(html).toContain('class="warning"');
    expect(html).toContain(
      'href="/admin/settings-advanced#settings-sms-gateway"',
    );
    expect(html).not.toContain('action="/admin/sms"');
    expect(html).toContain("<h3>Message history</h3>");
    expect(html).toContain("<p>No text messages yet.</p>");
  });

  test("does not offer a send form when the attendee has no phone", () => {
    const attendee = testAttendee({ id: 5, name: "No Phone", phone: "" });
    const html = smsPage(OWNER_SESSION, {
      configured: true,
      flash: { success: "Previous text sent." },
      history: [],
      queueCount: 0,
      target: { attendee, listing: LISTING },
    });

    expect(html).toContain("Previous text sent.");
    expect(html).toContain("<strong>Phone:</strong> (none on file)");
    expect(html).not.toContain('class="warning"');
    expect(html).not.toContain('action="/admin/sms"');
    expect(html).not.toContain('name="message"');
  });

  test("renders a configured compose form and escaped conversation history", () => {
    const attendee = testAttendee({ id: 6, name: "Grace", phone: "+44123" });
    const html = smsPage(OWNER_SESSION, {
      configured: true,
      flash: {},
      history: [
        { created: "2026-01-02T03:04:05Z", message: "First <reply>" },
        { created: "2026-01-03T04:05:06Z", message: "Second reply" },
      ],
      queueCount: 2,
      target: { attendee, listing: LISTING },
    });

    expect(html).toContain('action="/admin/sms"');
    expect(html).toContain('<input name="listing" type="hidden" value="9">');
    expect(html).toContain('<input name="attendee" type="hidden" value="6">');
    expect(html).toContain(
      '<textarea id="sms-message" maxlength="1000" name="message" required rows="4"></textarea>',
    );
    expect(html).toContain("<legend>Send a text message</legend>");
    expect(html).toContain("Send text");
    expect(html).toContain("<th>When</th><th>Message</th>");
    expect(html).toContain("2026-01-02 03:04");
    expect(html).toContain("First &lt;reply&gt;");
    expect(html).not.toContain("First <reply>");
    expect(html.indexOf("First &lt;reply&gt;")).toBeLessThan(
      html.indexOf("Second reply"),
    );
    expect(html).not.toContain("No text messages yet.");
  });
});
