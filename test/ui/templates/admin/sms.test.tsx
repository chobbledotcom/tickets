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

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { formatDatetimeShort } from "#shared/dates.ts";
import { SMS_MESSAGE_MAX_LENGTH } from "#shared/sms/message-limit.ts";
import { smsPage } from "#templates/admin/sms.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

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

    says(html, "<title>Text messages</title>");
    says(html, "Messages awaiting delivery: 2");
    says(html, 'href="/admin/guide#sms"');
    assert(!html.includes(COMPOSE_FORM));
    // Nobody is chosen, so there is no history to show. One shown here would
    // be somebody's messages on a page that never says whose.
    assert(!html.includes("Message history"));
    assert(!html.includes("Ignored"));
  });

  test("offers the compose form for somebody with a number", () => {
    const html = render();

    says(html, "<title>Contact: Nina</title>");
    says(html, "Contact Nina");
    says(html, `<strong>Phone:</strong> ${PHONE}`);
    // The way back to the person this page is about.
    says(html, 'href="/admin/attendees/3"');
    says(html, COMPOSE_FORM);
    says(html, "Send a text message");
    // The box's own limit: the route refuses the same count, so a send past
    // it fails even from a crafted POST.
    expect(html).toMatch(
      new RegExp(
        `name="message"[^>]*maxlength="${SMS_MESSAGE_MAX_LENGTH}"|maxlength="${SMS_MESSAGE_MAX_LENGTH}"[^>]*name="message"`,
      ),
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

    assert(!html.includes("<script>alert(1)</script>"));
    says(html, "&lt;script&gt;");
  });

  test("warns and offers no form when the gateway is not configured", () => {
    const html = render({ configured: false });

    says(html, 'class="warning"');
    says(html, "The SMS gateway is not configured.");
    // The warning says what to put right, so it has to carry the way to do
    // it. A warning with no route out leaves the owner told and stuck.
    says(html, GATEWAY_SETTINGS);
    assert(!html.includes(COMPOSE_FORM));
  });

  test("says the number is not on file and offers no form without one", () => {
    const html = render({
      target: { attendee: attendeeWith(""), listing: LISTING },
    });

    says(html, "<strong>Phone:</strong> (none on file)");
    assert(!html.includes(COMPOSE_FORM));
    // A missing number is not a missing gateway. Warning about the gateway
    // here would send the owner to settings that are already right.
    assert(!html.includes('class="warning"'));
    assert(!html.includes(GATEWAY_SETTINGS));
  });

  test("says so plainly when nothing has been sent yet", () => {
    const html = render();

    says(html, "<h3>Message history</h3>");
    says(html, "No text messages yet.");
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

    assert(!html.includes("No text messages yet."));
    says(html, "Later");
    says(html, "Earlier");
    expect(html.indexOf("Later")).toBeLessThan(html.indexOf("Earlier"));
    // When each one went, under its own heading. The message alone leaves the
    // organiser unable to tell a text sent this morning from one sent a year
    // ago, and the site's own short format is what the other tables use.
    says(html, "<th>When</th><th>Message</th>");
    says(html, formatDatetimeShort(later));
    says(html, formatDatetimeShort(earlier));
    assert(!html.includes(later));
  });
});
