import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  enqueueSms,
  getQueuedSms,
  getSmsOutboxById,
  getSmsOutboxForAttendee,
  markSmsDelivered,
  markSmsFailed,
  markSmsSent,
  smsOutboxApi,
} from "#shared/db/sms-outbox.ts";
import { describeWithEnv } from "#test-utils";

const enqueue = (over: Partial<Parameters<typeof enqueueSms>[0]> = {}) =>
  enqueueSms({
    attendeeId: 1,
    bodyEnc: "$aes-256-cbc/pbkdf2-sha1$i=75000$body$ct",
    listingId: 1,
    phoneEnc: "$aes-256-cbc/pbkdf2-sha1$i=75000$phone$ct",
    ...over,
  });

describeWithEnv("db > sms_outbox", { db: true }, () => {
  test("enqueueSms inserts a queued row storing only ciphertext", async () => {
    const { id } = await enqueue();
    const row = await getSmsOutboxById(id);

    expect(row).not.toBeNull();
    expect(row!.status).toBe("queued");
    expect(row!.provider_id).toBe("");
    expect(row!.error).toBe("");
    expect(row!.attempts).toBe(0);
    expect(row!.phone_enc).toBe("$aes-256-cbc/pbkdf2-sha1$i=75000$phone$ct");
    expect(row!.body_enc).toBe("$aes-256-cbc/pbkdf2-sha1$i=75000$body$ct");
    expect(row!.created).not.toBe("");
  });

  test("getSmsOutboxById returns null for a missing id", async () => {
    expect(await getSmsOutboxById(999)).toBeNull();
  });

  test("getQueuedSms returns only queued rows, oldest first", async () => {
    const first = await enqueue();
    const second = await enqueue();
    const third = await enqueue();
    await markSmsSent(second.id, "msg-2");

    const queued = await getQueuedSms();
    expect(queued.map((r) => r.id)).toEqual([first.id, third.id]);
  });

  test("getQueuedSms honours the limit", async () => {
    await enqueue();
    await enqueue();
    await enqueue();
    expect(await getQueuedSms(2)).toHaveLength(2);
  });

  test("getSmsOutboxForAttendee filters by attendee, newest first", async () => {
    const a1 = await enqueue({ attendeeId: 7 });
    const a2 = await enqueue({ attendeeId: 7 });
    await enqueue({ attendeeId: 8 });

    const rows = await getSmsOutboxForAttendee(7);
    expect(rows.map((r) => r.id)).toEqual([a2.id, a1.id]);
  });

  test("markSmsSent records the provider id and counts an attempt", async () => {
    const { id } = await enqueue();
    await markSmsSent(id, "cloud-abc");
    const row = await getSmsOutboxById(id);

    expect(row!.status).toBe("sent");
    expect(row!.provider_id).toBe("cloud-abc");
    expect(row!.attempts).toBe(1);
    expect(row!.updated).not.toBe("");
  });

  test("markSmsFailed records the error and counts an attempt", async () => {
    const { id } = await enqueue();
    await markSmsFailed(id, "network down");
    const row = await getSmsOutboxById(id);

    expect(row!.status).toBe("failed");
    expect(row!.error).toBe("network down");
    expect(row!.attempts).toBe(1);
    expect(row!.updated).not.toBe("");
  });

  test("markSmsDelivered moves a sent row to delivered", async () => {
    const { id } = await enqueue();
    await markSmsSent(id, "cloud-xyz");
    await markSmsDelivered(id);
    const row = await getSmsOutboxById(id);

    expect(row!.status).toBe("delivered");
    // attempts unchanged by delivery (still 1 from the send)
    expect(row!.attempts).toBe(1);
  });

  test("the new table is created by migrations (no rows initially)", async () => {
    const result = await getDb().execute(
      "SELECT COUNT(*) AS c FROM sms_outbox",
    );
    expect(Number(result.rows[0]?.c ?? 0)).toBe(0);
  });

  test("smsOutboxApi exposes the operations", () => {
    expect(typeof smsOutboxApi.enqueueSms).toBe("function");
    expect(typeof smsOutboxApi.markSmsSent).toBe("function");
    expect(typeof smsOutboxApi.markSmsDelivered).toBe("function");
  });
});
