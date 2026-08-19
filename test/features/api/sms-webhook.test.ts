import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { setAttendeePhoneIndexIfEmpty } from "#db/attendee-phone-index.ts";
import { execute } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import {
  getSmsMessageByProviderId,
  recordSmsMessage,
} from "#db/sms-messages.ts";
import { handleRequest } from "#routes";
import { encryptField } from "#shared/sms/e2e.ts";
import { computePhoneIndex } from "#shared/sms/phone-index.ts";
import {
  getAllActivityLog,
  getAttendeeActivityLog,
} from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithPhone } from "#test-utils/db-helpers/attendees.ts";

const SECRET = "whsec-123";
const PASS = "gateway-pass";

const hmacHex = async (secret: string, message: string): Promise<string> => {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret) as BufferSource,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return new Uint8Array(sig).toHex();
};

const currentTimestamp = (offsetSeconds = 0): string =>
  String(Math.floor(Date.now() / 1000) + offsetSeconds);

const postWebhook = async (
  body: unknown,
  opts: { sign?: boolean; rawBody?: string; timestamp?: string } = {},
): Promise<Response> => {
  const raw = opts.rawBody ?? JSON.stringify(body);
  const ts = opts.timestamp ?? currentTimestamp();
  // Force the next request to re-read settings written directly in the test.
  settings.invalidateCache();
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.sign !== false) {
    headers.set("x-signature", await hmacHex(SECRET, raw + ts));
    if (opts.timestamp !== "") headers.set("x-timestamp", ts);
  }
  return handleRequest(
    new Request("http://localhost/sms/webhook", {
      body: raw,
      headers,
      method: "POST",
    }),
  );
};

const configure = () => settings.update.smsGatewayWebhookSecret(SECRET);

describeWithEnv("api > sms webhook", { db: true }, () => {
  test("404 when the webhook secret is not configured", async () => {
    const res = await postWebhook({ event: "sms:received", payload: {} });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not configured" });
  });

  test("401 on an invalid signature", async () => {
    await configure();
    const res = await postWebhook(
      { event: "sms:received", payload: {} },
      {
        sign: false,
      },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid signature" });
  });

  test("valid signature with a current timestamp succeeds", async () => {
    await configure();
    const res = await postWebhook({ event: "sms:received", payload: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("timestamp at the future tolerance boundary succeeds", async () => {
    await configure();
    const clock = new FakeTime(Date.now());
    try {
      const ts = String(Math.floor(Date.now() / 1000) + 300);
      const res = await postWebhook(
        { event: "sms:sent", payload: {} },
        { timestamp: ts },
      );
      expect(res.status).toBe(200);
    } finally {
      clock.restore();
    }
  });

  test("missing timestamp fails", async () => {
    await configure();
    const res = await postWebhook(
      { event: "sms:received", payload: {} },
      { timestamp: "" },
    );
    expect(res.status).toBe(401);
  });

  test("malformed timestamp fails", async () => {
    await configure();
    const res = await postWebhook(
      { event: "sms:received", payload: {} },
      { timestamp: "not-a-unix-second" },
    );
    expect(res.status).toBe(401);
  });

  test("unsafe integer timestamp fails", async () => {
    await configure();
    const res = await postWebhook(
      { event: "sms:received", payload: {} },
      { timestamp: "999999999999999999999" },
    );
    expect(res.status).toBe(401);
  });

  test("timestamp older than tolerance fails", async () => {
    await configure();
    const res = await postWebhook(
      { event: "sms:received", payload: {} },
      { timestamp: currentTimestamp(-301) },
    );
    expect(res.status).toBe(401);
  });

  test("timestamp too far in the future fails", async () => {
    await configure();
    const res = await postWebhook(
      { event: "sms:received", payload: {} },
      { timestamp: currentTimestamp(302) },
    );
    expect(res.status).toBe(401);
  });

  test("400 on invalid JSON", async () => {
    await configure();
    const res = await postWebhook(null, { rawBody: "not json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
  });

  test("400 on a payload missing the event", async () => {
    await configure();
    const res = await postWebhook({ payload: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid payload" });
  });

  test("cleanup preserves a provider-message row within retention and prunes an expired one", async () => {
    await configure();
    const attendee = await createTestAttendeeWithPhone();
    await recordSmsMessage({
      attendeeId: attendee.id,
      listingId: 1,
      providerId: "msg-fresh",
    });
    await recordSmsMessage({
      attendeeId: attendee.id,
      listingId: 1,
      providerId: "msg-stale",
    });
    await execute(
      "UPDATE sms_messages SET created = datetime('now', '-1 day') WHERE provider_id = ?",
      ["msg-fresh"],
    );
    await execute(
      "UPDATE sms_messages SET created = datetime('now', '-31 days') WHERE provider_id = ?",
      ["msg-stale"],
    );

    await postWebhook({ event: "sms:sent", payload: {} });

    expect((await getSmsMessageByProviderId("msg-fresh"))?.provider_id).toBe(
      "msg-fresh",
    );
    expect(await getSmsMessageByProviderId("msg-stale")).toBeNull();
  });

  test("delivered logs against the attendee and clears the row", async () => {
    await configure();
    const attendee = await createTestAttendeeWithPhone();
    await recordSmsMessage({
      attendeeId: attendee.id,
      listingId: 1,
      providerId: "msg-1",
    });

    const res = await postWebhook({
      event: "sms:delivered",
      payload: { messageId: "msg-1" },
    });
    expect(res.status).toBe(200);
    expect(await getSmsMessageByProviderId("msg-1")).toBeNull();
    const log = await getAttendeeActivityLog(attendee.id);
    expect(log.some((e) => e.message.includes("delivered"))).toBe(true);
  });

  test("failed logs the reason against the attendee", async () => {
    await configure();
    const attendee = await createTestAttendeeWithPhone();
    await recordSmsMessage({
      attendeeId: attendee.id,
      listingId: 1,
      providerId: "msg-2",
    });

    await postWebhook({
      event: "sms:failed",
      payload: { messageId: "msg-2", reason: "no signal" },
    });
    const log = await getAttendeeActivityLog(attendee.id);
    expect(log.some((e) => e.message.includes("failed: no signal"))).toBe(true);
  });

  test("delivered falls back to the `id` field when messageId is absent", async () => {
    await configure();
    const attendee = await createTestAttendeeWithPhone();
    await recordSmsMessage({
      attendeeId: attendee.id,
      listingId: 1,
      providerId: "msg-3",
    });

    await postWebhook({ event: "sms:delivered", payload: { id: "msg-3" } });
    expect(await getSmsMessageByProviderId("msg-3")).toBeNull();
  });

  test("ignores non-string payload fields", async () => {
    await configure();
    await settings.update.smsGatewayPassphrase(PASS);
    const res = await postWebhook({
      event: "sms:received",
      payload: { message: 123, sender: 456 },
    });
    expect(res.status).toBe(200);
    const all = await getAllActivityLog();
    expect(all.some((e) => e.message === "SMS received: ")).toBe(true);
  });

  test("failed for an unknown id is a no-op; a missing reason defaults", async () => {
    await configure();
    expect(
      (
        await postWebhook({
          event: "sms:failed",
          payload: { messageId: "ghost" },
        })
      ).status,
    ).toBe(200);

    const attendee = await createTestAttendeeWithPhone();
    await recordSmsMessage({
      attendeeId: attendee.id,
      listingId: 1,
      providerId: "msg-4",
    });
    await postWebhook({ event: "sms:failed", payload: { messageId: "msg-4" } });

    const log = await getAttendeeActivityLog(attendee.id);
    expect(log.some((e) => e.message.includes("failed: unknown"))).toBe(true);
  });

  test("status events for unknown ids are a no-op", async () => {
    await configure();
    const res = await postWebhook({
      event: "sms:delivered",
      payload: { messageId: "ghost" },
    });
    expect(res.status).toBe(200);
  });

  test("unknown events are accepted and ignored", async () => {
    await configure();
    const res = await postWebhook({ event: "sms:sent", payload: {} });
    expect(res.status).toBe(200);
  });

  test("received decrypts the reply and logs it against the attendee", async () => {
    await configure();
    await settings.update.smsGatewayPassphrase(PASS);
    const attendee = await createTestAttendeeWithPhone();
    await setAttendeePhoneIndexIfEmpty(
      attendee.id,
      await computePhoneIndex("+447700900123"),
    );

    await postWebhook({
      event: "sms:received",
      payload: {
        id: "inbound-1",
        message: await encryptField("see you there", PASS),
        sender: await encryptField("07700900123", PASS),
      },
    });

    const log = await getAttendeeActivityLog(attendee.id);
    expect(log.some((e) => e.message.includes("received: see you there"))).toBe(
      true,
    );
  });

  test("replaying the same inbound id does not duplicate activity", async () => {
    await configure();
    await settings.update.smsGatewayPassphrase(PASS);

    const body = {
      event: "sms:received",
      payload: {
        id: "inbound-replay",
        message: "hi once",
        sender: "+440000000000",
      },
    };
    expect((await postWebhook(body)).status).toBe(200);
    expect((await postWebhook(body)).status).toBe(200);

    const all = await getAllActivityLog();
    expect(
      all.filter((e) => e.message.includes("received: hi once")).length,
    ).toBe(1);
  });

  test("replayed delivered event remains idempotent", async () => {
    await configure();
    const attendee = await createTestAttendeeWithPhone();
    await recordSmsMessage({
      attendeeId: attendee.id,
      listingId: 1,
      providerId: "msg-replay",
    });
    const body = {
      event: "sms:delivered",
      payload: { messageId: "msg-replay" },
    };

    expect((await postWebhook(body)).status).toBe(200);
    expect((await postWebhook(body)).status).toBe(200);

    const log = await getAttendeeActivityLog(attendee.id);
    expect(log.filter((e) => e.message.includes("SMS delivered")).length).toBe(
      1,
    );
  });

  test("received with plaintext, unmatched sender logs unattributed", async () => {
    await configure();
    await settings.update.smsGatewayPassphrase(PASS);

    await postWebhook({
      event: "sms:received",
      payload: { message: "hi", sender: "+440000000000" },
    });

    const all = await getAllActivityLog();
    expect(all.some((e) => e.message.includes("received: hi"))).toBe(true);
  });
});
