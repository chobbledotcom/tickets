/**
 * Branch cover for the texting page's own markup, beside the story
 * `@story:attendees.sending-somebody-a-text`.
 *
 * The story drives this page through the server and proves what the organiser
 * reads on it, including the flash messages a real send produces. These render
 * it directly, so every arm of the page keeps a cover a Cucumber run cannot
 * supply, and so the links and titles it offers are pinned by something that
 * reads the markup rather than the words.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { formatDatetimeShort } from "#shared/dates.ts";
import { smsPage } from "#templates/admin/sms.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

const PHONE = "+447700900123";

/** Where the page sends what the organiser writes. Its absence is what proves
 * there is no way to write; the heading alone would not, because a form that
 * lost its fieldset would still take a message. */
const COMPOSE_FORM = 'action="/admin/sms"';

/** Where the gateway warning sends an owner to put the gateway right. */
const GATEWAY_SETTINGS = 'href="/admin/settings-advanced#settings-sms-gateway"';

const LISTING = testListingWithCount({ id: 7, name: "Pottery" });

const attendeeWith = (phone: string) =>
  testAttendee({ id: 3, name: "Nina", phone });

const render = (
  overrides: Partial<Parameters<typeof smsPage>[1]> = {},
): string =>
  smsPage(OWNER_SESSION, {
    configured: true,
    flash: {},
    history: [],
    queueCount: 0,
    target: { attendee: attendeeWith(PHONE), listing: LISTING },
    ...overrides,
  });

describe("admin sms page", () => {
  beforeAll(setupAdminPageTest);

  test("counts what is waiting and offers nobody to write to", () => {
    // Built without a target rather than with an undefined one: the page's
    // own type says a target is either there or the key is absent.
    const html = smsPage(OWNER_SESSION, {
      configured: true,
      flash: {},
      history: [{ created: "2026-08-26T10:00:00.000Z", message: "Ignored" }],
      queueCount: 2,
    });

    expect(html).toContain("<title>Text messages</title>");
    expect(html).toContain("Messages awaiting delivery: 2");
    expect(html).toContain('href="/admin/guide#sms"');
    expect(html).not.toContain(COMPOSE_FORM);
    // Nobody is chosen, so there is no history to show. One shown here would
    // be somebody's messages on a page that never says whose.
    expect(html).not.toContain("Message history");
    expect(html).not.toContain("Ignored");
  });

  test("offers the compose form for somebody with a number", () => {
    const html = render();

    expect(html).toContain("<title>Contact: Nina</title>");
    expect(html).toContain("Contact Nina");
    expect(html).toContain(`<strong>Phone:</strong> ${PHONE}`);
    // The way back to the person this page is about.
    expect(html).toContain('href="/admin/attendees/3"');
    expect(html).toContain(COMPOSE_FORM);
    expect(html).toContain("Send a text message");
    // The box's own limit: the route trims and refuses an empty message but
    // sets no maximum, so this attribute is the only length guard a normal
    // send meets.
    expect(html).toMatch(
      /name="message"[^>]*maxlength="1000"|maxlength="1000"[^>]*name="message"/,
    );
    // Each hidden value bound to its own field: two loose values would pass
    // just as well with the listing and the attendee swapped.
    expect(html).toMatch(
      /name="listing"[^>]*value="7"|value="7"[^>]*name="listing"/,
    );
    expect(html).toMatch(
      /name="attendee"[^>]*value="3"|value="3"[^>]*name="attendee"/,
    );
  });

  test("shows a message's markup as text, never as markup", () => {
    // An inbound text is somebody else's words. The webhook puts them in the
    // activity log and this table renders them, so markup that survived would
    // be markup a stranger chose.
    const html = render({
      history: [
        {
          created: "2026-08-26T10:00:00.000Z",
          message: "<script>alert(1)</script>",
        },
      ],
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("warns and offers no form when the gateway is not configured", () => {
    const html = render({ configured: false });

    expect(html).toContain('class="warning"');
    expect(html).toContain("The SMS gateway is not configured.");
    // The warning says what to put right, so it has to carry the way to do
    // it. A warning with no route out leaves the owner told and stuck.
    expect(html).toContain(GATEWAY_SETTINGS);
    expect(html).not.toContain(COMPOSE_FORM);
  });

  test("says the number is not on file and offers no form without one", () => {
    const html = render({
      target: { attendee: attendeeWith(""), listing: LISTING },
    });

    expect(html).toContain("<strong>Phone:</strong> (none on file)");
    expect(html).not.toContain(COMPOSE_FORM);
    // A missing number is not a missing gateway. Warning about the gateway
    // here would send the owner to settings that are already right.
    expect(html).not.toContain('class="warning"');
    expect(html).not.toContain(GATEWAY_SETTINGS);
  });

  test("says so plainly when nothing has been sent yet", () => {
    const html = render();

    expect(html).toContain("<h3>Message history</h3>");
    expect(html).toContain("No text messages yet.");
  });

  test("lists what was sent, newest first, with when it went", () => {
    const later = "2026-08-26T10:00:00.000Z";
    const earlier = "2026-08-25T10:00:00.000Z";
    const html = render({
      history: [
        { created: later, message: "SMS queued: Later" },
        { created: earlier, message: "SMS queued: Earlier" },
      ],
    });

    expect(html).not.toContain("No text messages yet.");
    expect(html).toContain("Later");
    expect(html).toContain("Earlier");
    expect(html.indexOf("Later")).toBeLessThan(html.indexOf("Earlier"));
    // When each one went, under its own heading. The message alone leaves the
    // organiser unable to tell a text sent this morning from one sent a year
    // ago, and the site's own short format is what the other tables use.
    expect(html).toContain("<th>When</th><th>Message</th>");
    expect(html).toContain(formatDatetimeShort(later));
    expect(html).toContain(formatDatetimeShort(earlier));
    expect(html).not.toContain(later);
  });
});
