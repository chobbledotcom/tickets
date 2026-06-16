/**
 * SMS Gateway webhook receiver: POST /sms/webhook
 *
 * Receives delivery/failure/inbound events from the SMS Gateway app. Requests
 * are authenticated with an HMAC-SHA256 signature over `rawBody + timestamp`
 * using the shared webhook secret. Events are recorded in the (encrypted)
 * activity log against the relevant attendee; message text and the sender
 * number arrive end-to-end encrypted and are decrypted with the gateway
 * passphrase. No message content is persisted outside the activity log.
 */

import * as v from "valibot";
import { jsonResponse } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { constantTimeEqual } from "#shared/crypto/utils.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { findAttendeeIdByPhoneIndex } from "#shared/db/attendee-phone-index.ts";
import { settings } from "#shared/db/settings.ts";
import {
  getSmsByProviderId,
  markSmsDelivered,
  markSmsFailed,
  type SmsOutboxRow,
} from "#shared/db/sms-outbox.ts";
import { decryptField } from "#shared/sms/e2e.ts";
import { computePhoneIndex } from "#shared/sms/phone-index.ts";

const EnvelopeSchema = v.object({
  event: v.string(),
  payload: v.record(v.string(), v.unknown()),
});

/** Hex HMAC-SHA256 of a message with the given secret. */
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

/** Verify the X-Signature / X-Timestamp headers against the raw body. */
const isValidSignature = async (
  request: Request,
  rawBody: string,
  secret: string,
): Promise<boolean> => {
  const signature = request.headers.get("x-signature");
  const timestamp = request.headers.get("x-timestamp");
  if (!signature || !timestamp) return false;
  const expected = await hmacHex(secret, rawBody + timestamp);
  return constantTimeEqual(expected, signature);
};

/** Decrypt an E2E field, falling back to the raw value if it isn't encrypted. */
const tryDecrypt = async (
  value: string,
  passphrase: string,
): Promise<string> => {
  try {
    return await decryptField(value, passphrase);
  } catch {
    return value;
  }
};

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** Run `fn` with the outbound row a status event refers to, if it exists. */
const withReferencedRow = async (
  payload: Record<string, unknown>,
  fn: (row: SmsOutboxRow) => Promise<void>,
): Promise<void> => {
  const row = await getSmsByProviderId(
    str(payload.messageId) || str(payload.id),
  );
  if (row) await fn(row);
};

/** Handle a delivery (`sms:delivered`) or failure (`sms:failed`) status event. */
const handleStatus = (
  event: string,
  payload: Record<string, unknown>,
): Promise<void> =>
  withReferencedRow(payload, async (row) => {
    const delivered = event === "sms:delivered";
    const reason = str(payload.reason) || "unknown";
    const note = delivered
      ? "Text message delivered"
      : `Text message failed: ${reason}`;
    await (delivered
      ? markSmsDelivered(row.id)
      : markSmsFailed(row.id, reason));
    await logActivity(note, row.listing_id, row.attendee_id);
  });

const handleReceived = async (
  payload: Record<string, unknown>,
  passphrase: string,
): Promise<void> => {
  const message = await tryDecrypt(str(payload.message), passphrase);
  const sender = await tryDecrypt(str(payload.sender), passphrase);
  const attendeeId = await findAttendeeIdByPhoneIndex(
    await computePhoneIndex(sender),
  );
  await logActivity(`Text message received: ${message}`, null, attendeeId);
};

/** Handle POST /sms/webhook */
export const handleSmsWebhook = async (request: Request): Promise<Response> => {
  const secret = settings.smsGatewayWebhookSecret;
  if (!secret) return jsonResponse({ error: "Not configured" }, 404);

  const rawBody = await request.text();
  if (!(await isValidSignature(request, rawBody, secret))) {
    return jsonResponse({ error: "Invalid signature" }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const parsed = v.safeParse(EnvelopeSchema, body);
  if (!parsed.success) return jsonResponse({ error: "Invalid payload" }, 400);

  const { event, payload } = parsed.output;
  if (event === "sms:delivered" || event === "sms:failed") {
    await handleStatus(event, payload);
  } else if (event === "sms:received") {
    await handleReceived(payload, settings.smsGatewayPassphrase);
  }

  return jsonResponse({ ok: true });
};

export const smsWebhookRoutes = defineRoutes({
  "POST /sms/webhook": handleSmsWebhook,
});

export const routeSmsWebhook = createRouter(smsWebhookRoutes);
