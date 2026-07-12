import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryOne } from "#shared/db/client.ts";
import {
  getContactRecord,
  hashEmail,
  hashPhone,
  recordContacts,
} from "#shared/db/contact-preferences.ts";
import {
  getRecentBookingTokens,
  recordBookingActivity,
  recordOrderActivity,
} from "#shared/db/contact-tokens.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const expectOneBookingVisit = async (
  hash: string,
  token: string,
): Promise<void> => {
  const privateKey = await getTestPrivateKey();
  const record = await getContactRecord(hash, privateKey);
  expect({
    publicBookingCount: record.publicBookingCount,
    visits: record.visits,
  }).toEqual({ publicBookingCount: 1, visits: 1 });
  expect(await getRecentBookingTokens(hash, privateKey, 1)).toEqual([
    { source: "public", token },
  ]);
};

const firstMarkerFor = async (hash: string): Promise<string> => {
  const row = await queryOne<{ attendee_tokens_blob: string }>(
    "SELECT attendee_tokens_blob FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );
  return row!.attendee_tokens_blob.split("\n")[0]!.split("\t")[0]!;
};

describeWithEnv("contact booking activity", { db: true }, () => {
  test("splits booking counts by source without changing outreach stats", async () => {
    const privateKey = await getTestPrivateKey();
    const hash = await hashEmail("bookings@example.com");
    await recordContacts([hash], "Newsletter", privateKey);
    await recordBookingActivity(hash, "public", "tok-pub-1");
    await recordBookingActivity(hash, "public", "tok-pub-2");
    await recordBookingActivity(hash, "admin", "tok-adm-1");

    const record = await getContactRecord(hash, privateKey);
    expect({
      adminBookingCount: record.adminBookingCount,
      contactCount: record.contactCount,
      lastSubject: record.lastSubject,
      publicBookingCount: record.publicBookingCount,
    }).toEqual({
      adminBookingCount: 1,
      contactCount: 1,
      lastSubject: "Newsletter",
      publicBookingCount: 2,
    });
    expect(
      await getRecentBookingTokens(hash, privateKey, Number.MAX_SAFE_INTEGER),
    ).toEqual([
      { source: "public", token: "tok-pub-1" },
      { source: "public", token: "tok-pub-2" },
      { source: "admin", token: "tok-adm-1" },
    ]);
  });

  test("records missing booking history without an owner key", async () => {
    const hash = await hashEmail("keyless@example.com");
    await recordBookingActivity(hash, "public", "tok-keyless");
    await expectOneBookingVisit(hash, "tok-keyless");
  });

  test("does not duplicate completed booking history", async () => {
    const hash = await hashEmail("recover-complete@example.com");
    await recordBookingActivity(hash, "public", "tok-recover-complete");
    await recordBookingActivity(hash, "public", "tok-recover-complete");
    await expectOneBookingVisit(hash, "tok-recover-complete");
  });

  test("recordOrderActivity records one replay-safe visit for email and phone", async () => {
    const emailHash = await hashEmail("linked-token@example.com");
    const phoneHash = await hashPhone("07700 900111");
    const record = () =>
      recordOrderActivity(
        "linked-token@example.com",
        "07700 900111",
        "public",
        "tok-linked-contact",
      );
    await record();
    await record();

    expect(await firstMarkerFor(emailHash)).not.toBe(
      await firstMarkerFor(phoneHash),
    );
    await expectOneBookingVisit(emailHash, "tok-linked-contact");
    await expectOneBookingVisit(phoneHash, "tok-linked-contact");
  });
});
