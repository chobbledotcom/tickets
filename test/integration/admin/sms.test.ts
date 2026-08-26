/**
 * Branch cover for the SMS routes, beside the story
 * `@story:attendees.sending-somebody-a-text`.
 *
 * The story owns the organiser's journey: the queue count, the warnings that
 * replace the compose form, sending a text and being told, the history, and
 * the refusals a real send can reach.
 *
 * These own what a browser cannot reach or a story cannot be the only cover
 * of: a target that does not exist, target ids the page would never build,
 * the gateway id recorded so an inbound reply can find its way back, and the
 * contact-history write failing after the text has already gone.
 */

import { expect } from "@std/expect";
import { it } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { hashPhone } from "#db/contact-preferences.ts";
import { settings } from "#db/settings.ts";
import { getSmsMessageByProviderId } from "#db/sms-messages.ts";
import { getAttendeeActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

const PHONE = "+447700900123";

const configureGateway = async (): Promise<void> => {
  await settings.update.smsGatewayPassphrase("pass-1");
  await settings.update.smsGatewayUsername("user");
  await settings.update.smsGatewayPassword("pw");
};

const setup = async (phone = PHONE) => {
  const listing = await createTestListing({
    maxAttendees: 100,
    thankYouUrl: "https://example.com",
  });
  const { attendee } = await createTestAttendeeDirect(
    listing.id,
    "Jane Doe",
    "jane@example.com",
    1,
    phone,
  );
  return {
    attendee,
    form: { attendee: String(attendee.id), listing: String(listing.id) },
    smsUrl: `/admin/sms?listing=${listing.id}&attendee=${attendee.id}`,
  };
};

const queuedLog = async (attendeeId: number) =>
  (await getAttendeeActivityLog(attendeeId)).some((e) =>
    e.message.includes("SMS queued"),
  );

describeWithEnv("admin sms", { db: true }, () => {
  it("GET returns 404 for an unknown attendee", async () => {
    const response = await adminGet("/admin/sms?listing=1&attendee=999");
    expect(response.status).toBe(404);
  });

  it("GET treats malformed target ids as no target", async () => {
    await configureGateway();
    await setup();
    const response = await adminGet("/admin/sms?listing=1x&attendee=1");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Messages awaiting delivery:");
    expect(html).not.toContain("Send a text message");
  });

  it("GET renders one person's page and their history", async () => {
    // Branch cover for the targeted GET and its history reader. The story
    // proves what the organiser reads here; this keeps the lines covered,
    // because a Cucumber run does not count towards coverage.
    await configureGateway();
    const { smsUrl, form } = await setup();
    using _fetch = stubFetch(new Response('{"id":"msg-9"}'));
    await adminFormPost("/admin/sms", { ...form, message: "History line" });

    const html = await (await adminGet(smsUrl)).text();
    expect(html).toContain("Send a text message");
    expect(html).toContain("Jane Doe");
    expect(html).toContain(PHONE);
    expect(html).toContain("History line");
  });

  it("POST rejects a message of only spaces", async () => {
    // Branch cover for the empty-message refusal; the story owns the journey.
    await configureGateway();
    const { attendee, form } = await setup();
    const { response } = await adminFormPost("/admin/sms", {
      ...form,
      message: "   ",
    });
    expect(response.status).toBe(302);
    expect(await queuedLog(attendee.id)).toBe(false);
  });

  it("POST on a gateway error logs the failure and records no row", async () => {
    // Branch cover for the catch arm; the story owns what the organiser sees.
    await configureGateway();
    const { attendee, form } = await setup();
    using _fetch = stubFetch(new Response("boom", { status: 500 }));
    await adminFormPost("/admin/sms", { ...form, message: "Hi" });

    const log = await getAttendeeActivityLog(attendee.id);
    expect(log.some((e) => e.message.includes("could not be queued"))).toBe(
      true,
    );
    expect(await queuedLog(attendee.id)).toBe(false);
  });

  it("POST records the gateway id against the attendee", async () => {
    // The webhook that reports delivery or carries a reply knows only the
    // gateway's own id, so this row is the only way back to the person.
    await configureGateway();
    const { attendee, form } = await setup();
    using _fetch = stubFetch(new Response('{"id":"msg-9"}'));
    await adminFormPost("/admin/sms", { ...form, message: "Hello Jane" });

    const row = await getSmsMessageByProviderId("msg-9");
    expect(row).not.toBeNull();
    expect(row?.attendee_id).toBe(attendee.id);
  });

  it("POST still succeeds when the contact-history write throws", async () => {
    await configureGateway();
    const { attendee, form } = await setup();
    // Seed an undecryptable stats_blob for this phone contact so recordContacts
    // throws when it tries to update the per-phone history — the exact failure
    // that must not be allowed to flip an already-sent text into an error.
    await getDb().execute({
      args: [await hashPhone(PHONE)],
      sql: `INSERT INTO contact_preferences (contact_hash, stats_blob) VALUES (?, 'corrupt-blob')
            ON CONFLICT(contact_hash) DO UPDATE SET stats_blob = 'corrupt-blob'`,
    });
    using _fetch = stubFetch(new Response('{"id":"msg-9"}'));
    const { response } = await adminFormPost("/admin/sms", {
      ...form,
      message: "Hello Jane",
    });
    expect(response.status).toBe(302);

    // The gateway accepted the text, so the id→attendee map is recorded and the
    // send is logged as queued; the stats failure must not surface as a "could
    // not be queued" error that would prompt the operator to resend.
    expect(await getSmsMessageByProviderId("msg-9")).not.toBeNull();
    const log = await getAttendeeActivityLog(attendee.id);
    expect(log.some((e) => e.message.includes("queued for Jane Doe"))).toBe(
      true,
    );
    expect(log.some((e) => e.message.includes("could not be queued"))).toBe(
      false,
    );
  });

  it("POST refuses to send when the gateway is unconfigured", async () => {
    // The page offers no compose form without a gateway, so this send is one
    // no browser could have made. The story owns what that page shows.
    const { attendee, form } = await setup();
    await adminFormPost("/admin/sms", { ...form, message: "Hi" });
    expect(await queuedLog(attendee.id)).toBe(false);
  });

  it("POST refuses when the attendee has no phone number", async () => {
    await configureGateway();
    const { attendee, form } = await setup("");
    await adminFormPost("/admin/sms", { ...form, message: "Hi" });
    expect(await queuedLog(attendee.id)).toBe(false);
  });

  it("POST 404s for an unknown attendee", async () => {
    const { response } = await adminFormPost("/admin/sms", {
      attendee: "999",
      listing: "1",
      message: "Hi",
    });
    expect(response.status).toBe(404);
  });

  it("POST rejects malformed target ids before sending", async () => {
    await configureGateway();
    using fetchStub = stubFetch(new Response('{"id":"msg-9"}'));
    const { response } = await adminFormPost("/admin/sms", {
      attendee: "1",
      listing: "1x",
      message: "Hi",
    });
    expect(response.status).toBe(302);
    expect(fetchStub.calls).toHaveLength(0);
  });
});
