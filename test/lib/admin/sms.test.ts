import { expect } from "@std/expect";
import { it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getAttendeeActivityLog } from "#shared/db/activityLog.ts";
import { settings } from "#shared/db/settings.ts";
import {
  getSmsMessageByProviderId,
  recordSmsMessage,
} from "#shared/db/sms-messages.ts";
import {
  adminFormPost,
  adminGet,
  createTestAttendeeDirect,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

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

const okFetch = () =>
  stub(globalThis, "fetch", () =>
    Promise.resolve(new Response('{"id":"msg-9"}', { status: 200 })),
  );

const queuedLog = async (attendeeId: number) =>
  (await getAttendeeActivityLog(attendeeId)).some((e) =>
    e.message.includes("SMS queued"),
  );

describeWithEnv("admin sms", { db: true }, () => {
  it("GET without a target shows the queue count", async () => {
    await recordSmsMessage({ attendeeId: 1, listingId: 1, providerId: "a" });
    await recordSmsMessage({ attendeeId: 1, listingId: 1, providerId: "b" });
    const { response } = await adminGet("/admin/sms");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Messages awaiting delivery: 2");
    expect(html).not.toContain("Send a text message");
  });

  it("GET shows the compose form when configured", async () => {
    await configureGateway();
    const { smsUrl } = await setup();
    const { response } = await adminGet(smsUrl);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Send a text message");
    expect(html).toContain("Jane Doe");
    expect(html).toContain(PHONE);
  });

  it("GET warns and hides the form when not configured", async () => {
    const { smsUrl } = await setup();
    const { response } = await adminGet(smsUrl);
    const html = await response.text();

    expect(html).toContain("not configured");
    expect(html).not.toContain("Send a text message");
  });

  it("GET shows '(none on file)' and no form when the attendee has no phone", async () => {
    await configureGateway();
    const { smsUrl } = await setup("");
    const { response } = await adminGet(smsUrl);
    const html = await response.text();

    expect(html).toContain("(none on file)");
    expect(html).not.toContain("Send a text message");
  });

  it("GET returns 404 for an unknown attendee", async () => {
    const { response } = await adminGet("/admin/sms?listing=1&attendee=999");
    expect(response.status).toBe(404);
  });

  it("GET treats malformed target ids as no target", async () => {
    await configureGateway();
    await setup();
    const { response } = await adminGet("/admin/sms?listing=1x&attendee=1");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Messages awaiting delivery:");
    expect(html).not.toContain("Send a text message");
  });

  it("POST queues a text: records the id→attendee map and logs it", async () => {
    await configureGateway();
    const { attendee, form } = await setup();
    const fetchStub = okFetch();
    try {
      const { response } = await adminFormPost("/admin/sms", {
        ...form,
        message: "Hello Jane",
      });
      expect(response.status).toBe(302);
    } finally {
      fetchStub.restore();
    }

    const row = await getSmsMessageByProviderId("msg-9");
    expect(row).not.toBeNull();
    expect(row!.attendee_id).toBe(attendee.id);

    const log = await getAttendeeActivityLog(attendee.id);
    expect(
      log.some((e) => e.message.includes("queued for Jane Doe: Hello Jane")),
    ).toBe(true);
  });

  it("POST on a gateway error logs the failure and records no row", async () => {
    await configureGateway();
    const { attendee, form } = await setup();
    const fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response("boom", { status: 500 })),
    );
    try {
      await adminFormPost("/admin/sms", { ...form, message: "Hi" });
    } finally {
      fetchStub.restore();
    }

    const log = await getAttendeeActivityLog(attendee.id);
    expect(log.some((e) => e.message.includes("could not be queued"))).toBe(
      true,
    );
    expect(await queuedLog(attendee.id)).toBe(false);
  });

  it("POST rejects an empty message", async () => {
    await configureGateway();
    const { attendee, form } = await setup();
    await adminFormPost("/admin/sms", { ...form, message: "   " });
    expect(await queuedLog(attendee.id)).toBe(false);
  });

  it("POST refuses to send when the gateway is unconfigured", async () => {
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
    const fetchStub = okFetch();
    try {
      const { response } = await adminFormPost("/admin/sms", {
        attendee: "1",
        listing: "1x",
        message: "Hi",
      });
      expect(response.status).toBe(302);
      expect(fetchStub.calls).toHaveLength(0);
    } finally {
      fetchStub.restore();
    }
  });

  it("GET renders the conversation history from the activity log", async () => {
    await configureGateway();
    const { smsUrl, form } = await setup();
    const fetchStub = okFetch();
    try {
      await adminFormPost("/admin/sms", { ...form, message: "History line" });
    } finally {
      fetchStub.restore();
    }

    const { response } = await adminGet(smsUrl);
    const html = await response.text();
    expect(html).toContain("History line");
  });

  it("GET still shows history (and the warning) when unconfigured", async () => {
    await configureGateway();
    const { smsUrl, form } = await setup();
    const fetchStub = okFetch();
    try {
      await adminFormPost("/admin/sms", {
        ...form,
        message: "Earlier message",
      });
    } finally {
      fetchStub.restore();
    }
    // Remove the passphrase so the gateway reads as unconfigured
    await settings.update.smsGatewayPassphrase("");

    const { response } = await adminGet(smsUrl);
    const html = await response.text();
    expect(html).toContain("not configured");
    expect(html).toContain("Earlier message");
  });
});
