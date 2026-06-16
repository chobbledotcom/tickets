import { expect } from "@std/expect";
import { it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getAttendeeActivityLog } from "#shared/db/activityLog.ts";
import { settings } from "#shared/db/settings.ts";
import { getSmsOutboxForAttendee } from "#shared/db/sms-outbox.ts";
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
    contactUrl: `/admin/listing/${listing.id}/attendee/${attendee.id}/contact`,
  };
};

const okFetch = () =>
  stub(globalThis, "fetch", () =>
    Promise.resolve(new Response('{"id":"msg-9"}', { status: 200 })),
  );

describeWithEnv("admin attendee contact", { db: true }, () => {
  it("GET shows the compose form when configured", async () => {
    await configureGateway();
    const { contactUrl } = await setup();
    const { response } = await adminGet(contactUrl);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Send a text message");
    expect(html).toContain("Jane Doe");
    expect(html).toContain(PHONE);
  });

  it("GET warns and hides the form when not configured", async () => {
    const { contactUrl } = await setup();
    const { response } = await adminGet(contactUrl);
    const html = await response.text();

    expect(html).toContain("not configured");
    expect(html).not.toContain("Send a text message");
  });

  it("GET shows '(none on file)' and no form when the attendee has no phone", async () => {
    await configureGateway();
    const { contactUrl } = await setup("");
    const { response } = await adminGet(contactUrl);
    const html = await response.text();

    expect(html).toContain("(none on file)");
    expect(html).not.toContain("Send a text message");
  });

  it("POST sends a text, stores ciphertext, and marks it sent", async () => {
    await configureGateway();
    const { attendee, contactUrl } = await setup();
    const fetchStub = okFetch();
    try {
      const { response } = await adminFormPost(contactUrl, {
        message: "Hello Jane",
      });
      expect(response.status).toBe(302);
    } finally {
      fetchStub.restore();
    }

    const rows = await getSmsOutboxForAttendee(attendee.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("sent");
    expect(rows[0]!.provider_id).toBe("msg-9");
    // Stored value is ciphertext, never the plaintext message
    expect(rows[0]!.body_enc).not.toContain("Hello Jane");
    expect(rows[0]!.phone_enc).not.toContain(PHONE);
  });

  it("POST marks the row failed when the gateway errors", async () => {
    await configureGateway();
    const { attendee, contactUrl } = await setup();
    const fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response("boom", { status: 500 })),
    );
    try {
      await adminFormPost(contactUrl, { message: "Hi" });
    } finally {
      fetchStub.restore();
    }

    const rows = await getSmsOutboxForAttendee(attendee.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error).not.toBe("");
  });

  it("logs a successful send against the attendee", async () => {
    await configureGateway();
    const { attendee, contactUrl } = await setup();
    const fetchStub = okFetch();
    try {
      await adminFormPost(contactUrl, { message: "Hi" });
    } finally {
      fetchStub.restore();
    }

    const log = await getAttendeeActivityLog(attendee.id);
    expect(log.some((e) => e.message.includes("Text message sent"))).toBe(true);
  });

  it("logs a failed send against the attendee, with the error", async () => {
    await configureGateway();
    const { attendee, contactUrl } = await setup();
    const fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response("boom", { status: 500 })),
    );
    try {
      await adminFormPost(contactUrl, { message: "Hi" });
    } finally {
      fetchStub.restore();
    }

    const log = await getAttendeeActivityLog(attendee.id);
    expect(log.some((e) => e.message.includes("failed to send"))).toBe(true);
  });

  it("POST rejects an empty message without enqueuing", async () => {
    await configureGateway();
    const { attendee, contactUrl } = await setup();
    await adminFormPost(contactUrl, { message: "   " });
    expect(await getSmsOutboxForAttendee(attendee.id)).toHaveLength(0);
  });

  it("POST refuses to send when the gateway is unconfigured", async () => {
    const { attendee, contactUrl } = await setup();
    await adminFormPost(contactUrl, { message: "Hi" });
    expect(await getSmsOutboxForAttendee(attendee.id)).toHaveLength(0);
  });

  it("POST refuses when the attendee has no phone number", async () => {
    await configureGateway();
    const { attendee, contactUrl } = await setup("");
    await adminFormPost(contactUrl, { message: "Hi" });
    expect(await getSmsOutboxForAttendee(attendee.id)).toHaveLength(0);
  });

  it("GET renders decrypted send history", async () => {
    await configureGateway();
    const { contactUrl } = await setup();
    const fetchStub = okFetch();
    try {
      await adminFormPost(contactUrl, { message: "History line" });
    } finally {
      fetchStub.restore();
    }

    const { response } = await adminGet(contactUrl);
    const html = await response.text();
    expect(html).toContain("History line");
  });

  it("GET renders history without bodies when the gateway is unconfigured", async () => {
    await configureGateway();
    const { contactUrl } = await setup();
    const fetchStub = okFetch();
    try {
      await adminFormPost(contactUrl, { message: "Earlier message" });
    } finally {
      fetchStub.restore();
    }
    // Remove the passphrase so the gateway reads as unconfigured
    await settings.update.smsGatewayPassphrase("");

    const { response } = await adminGet(contactUrl);
    const html = await response.text();
    expect(html).toContain("not configured");
    // A history row still renders (with an empty, undecryptable body)
    expect(html).toContain("sent");
    expect(html).not.toContain("Earlier message");
  });

  it("GET shows a placeholder when history can't be decrypted", async () => {
    await configureGateway();
    const { contactUrl } = await setup();
    const fetchStub = okFetch();
    try {
      await adminFormPost(contactUrl, { message: "Secret" });
    } finally {
      fetchStub.restore();
    }
    // Rotate the passphrase so the stored ciphertext no longer decrypts
    await settings.update.smsGatewayPassphrase("a-different-passphrase");

    const { response } = await adminGet(contactUrl);
    const html = await response.text();
    expect(html).toContain("unable to decrypt");
    expect(html).not.toContain("Secret");
  });
});
