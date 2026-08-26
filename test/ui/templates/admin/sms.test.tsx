/**
 * Branch cover for the texting page's own markup, beside the story
 * `@story:attendees.sending-somebody-a-text`.
 *
 * The story drives this page through the server and proves what the organiser
 * reads on it. These render it directly, so every arm of the page keeps a
 * cover a Cucumber run cannot supply.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { smsPage } from "#templates/admin/sms.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import type { Attendee, ListingWithCount } from "#types";

const PHONE = "+447700900123";

const LISTING = { id: 7, name: "Pottery" } as unknown as ListingWithCount;

const attendeeWith = (phone: string): Attendee =>
  ({ id: 3, name: "Nina", phone }) as unknown as Attendee;

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
      history: [],
      queueCount: 2,
    });

    expect(html).toContain("Messages awaiting delivery: 2");
    expect(html).not.toContain("Send a text message");
    expect(html).not.toContain("Message history");
  });

  test("offers the compose form for somebody with a number", () => {
    const html = render();

    expect(html).toContain("Contact Nina");
    expect(html).toContain(PHONE);
    expect(html).toContain("Send a text message");
    expect(html).toContain('name="message"');
    expect(html).toContain('value="7"');
    expect(html).toContain('value="3"');
  });

  test("warns and offers no form when the gateway is not configured", () => {
    const html = render({ configured: false });

    expect(html).toContain("The SMS gateway is not configured.");
    expect(html).not.toContain("Send a text message");
  });

  test("says the number is not on file and offers no form without one", () => {
    const html = render({
      target: { attendee: attendeeWith(""), listing: LISTING },
    });

    expect(html).toContain("(none on file)");
    expect(html).not.toContain("Send a text message");
  });

  test("says so plainly when nothing has been sent yet", () => {
    expect(render()).toContain("No text messages yet.");
  });

  test("lists what was sent, newest first, with when it went", () => {
    const html = render({
      history: [
        { created: "2026-08-26T10:00:00.000Z", message: "SMS queued: Later" },
        { created: "2026-08-25T10:00:00.000Z", message: "SMS queued: Earlier" },
      ],
    });

    expect(html).not.toContain("No text messages yet.");
    expect(html).toContain("Later");
    expect(html).toContain("Earlier");
    expect(html.indexOf("Later")).toBeLessThan(html.indexOf("Earlier"));
  });
});
