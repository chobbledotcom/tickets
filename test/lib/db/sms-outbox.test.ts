import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  enqueueSms,
  getSmsOutboxForAttendee,
  markSmsFailed,
  markSmsSent,
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

/** Read back a single attendee's most-recent row. */
const latestFor = async (attendeeId: number) =>
  (await getSmsOutboxForAttendee(attendeeId))[0]!;

describeWithEnv("db > sms_outbox", { db: true }, () => {
  test("enqueueSms inserts a queued row storing only ciphertext", async () => {
    const { id } = await enqueue();
    const row = await latestFor(1);

    expect(row.id).toBe(id);
    expect(row.status).toBe("queued");
    expect(row.provider_id).toBe("");
    expect(row.error).toBe("");
    expect(row.attempts).toBe(0);
    expect(row.phone_enc).toBe("$aes-256-cbc/pbkdf2-sha1$i=75000$phone$ct");
    expect(row.body_enc).toBe("$aes-256-cbc/pbkdf2-sha1$i=75000$body$ct");
    expect(row.created).not.toBe("");
  });

  test("getSmsOutboxForAttendee returns an empty list for an unknown attendee", async () => {
    expect(await getSmsOutboxForAttendee(999)).toHaveLength(0);
  });

  test("getSmsOutboxForAttendee filters by attendee, newest first", async () => {
    const a1 = await enqueue({ attendeeId: 7 });
    const a2 = await enqueue({ attendeeId: 7 });
    await enqueue({ attendeeId: 8 });

    const rows = await getSmsOutboxForAttendee(7);
    expect(rows.map((r) => r.id)).toEqual([a2.id, a1.id]);
  });

  test("markSmsSent records the provider id and counts an attempt", async () => {
    await enqueue();
    await markSmsSent((await latestFor(1)).id, "cloud-abc");
    const row = await latestFor(1);

    expect(row.status).toBe("sent");
    expect(row.provider_id).toBe("cloud-abc");
    expect(row.attempts).toBe(1);
    expect(row.updated).not.toBe("");
  });

  test("markSmsFailed records the error and counts an attempt", async () => {
    await enqueue();
    await markSmsFailed((await latestFor(1)).id, "network down");
    const row = await latestFor(1);

    expect(row.status).toBe("failed");
    expect(row.error).toBe("network down");
    expect(row.attempts).toBe(1);
    expect(row.updated).not.toBe("");
  });
});
