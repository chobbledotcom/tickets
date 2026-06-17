import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  deleteSmsMessage,
  getSmsMessageByProviderId,
  pruneSmsMessagesBefore,
  recordSmsMessage,
} from "#shared/db/sms-messages.ts";
import { describeWithEnv } from "#test-utils";

const record = (over: Partial<Parameters<typeof recordSmsMessage>[0]> = {}) =>
  recordSmsMessage({
    attendeeId: 1,
    listingId: 1,
    providerId: "msg-1",
    ...over,
  });

describeWithEnv("db > sms_messages", { db: true }, () => {
  test("records a PII-free row keyed by the gateway message id", async () => {
    await record({ attendeeId: 7, listingId: 3, providerId: "abc" });
    const row = await getSmsMessageByProviderId("abc");

    expect(row).not.toBeNull();
    expect(row!.attendee_id).toBe(7);
    expect(row!.listing_id).toBe(3);
    expect(row!.provider_id).toBe("abc");
    expect(row!.created).not.toBe("");
  });

  test("lookup returns null for an empty or unknown id", async () => {
    await record({ providerId: "known" });
    expect(await getSmsMessageByProviderId("")).toBeNull();
    expect(await getSmsMessageByProviderId("missing")).toBeNull();
  });

  test("deleteSmsMessage removes the row", async () => {
    await record({ providerId: "gone" });
    const row = await getSmsMessageByProviderId("gone");
    await deleteSmsMessage(row!.id);
    expect(await getSmsMessageByProviderId("gone")).toBeNull();
  });

  test("pruneSmsMessagesBefore drops rows older than the cutoff", async () => {
    await record({ providerId: "old" });
    // Cutoff in the future → the just-created row is older than it
    await pruneSmsMessagesBefore("2999-01-01T00:00:00.000Z");
    expect(await getSmsMessageByProviderId("old")).toBeNull();
  });

  test("pruneSmsMessagesBefore keeps rows newer than the cutoff", async () => {
    await record({ providerId: "fresh" });
    await pruneSmsMessagesBefore("2000-01-01T00:00:00.000Z");
    expect(await getSmsMessageByProviderId("fresh")).not.toBeNull();
  });
});
