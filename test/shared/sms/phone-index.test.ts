import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  findAttendeeIdByPhoneIndex,
  setAttendeePhoneIndexIfEmpty,
} from "#db/attendee-phone-index.ts";
import { queryOne } from "#db/client.ts";
import {
  computePhoneIndex,
  normalizeForIndex,
} from "#shared/sms/phone-index.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttendeeDirect,
  createTestAttendeeWithPhone,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createServicingHold } from "#test-utils/servicing.ts";

describeWithEnv("sms phone index", { encryptionKey: true }, () => {
  test("normalizeForIndex keeps the last 9 digits", () => {
    expect(normalizeForIndex("+44 7700 900123")).toBe("700900123");
    expect(normalizeForIndex("07700900123")).toBe("700900123");
    expect(normalizeForIndex("")).toBe("");
  });

  test("computePhoneIndex matches across formats and is empty for empty", async () => {
    const a = await computePhoneIndex("+447700900123");
    const b = await computePhoneIndex("07700 900123");
    expect(a).toBe(b);
    expect(await computePhoneIndex("")).toBe("");
  });
});

describeWithEnv("db > attendee phone index", { db: true }, () => {
  /** The raw stored phone_index column for one attendee row. */
  const storedPhoneIndex = async (attendeeId: number): Promise<string> => {
    const row = await queryOne<{ phone_index: string }>(
      "SELECT phone_index FROM attendees WHERE id = ?",
      [attendeeId],
    );
    return row!.phone_index;
  };

  test("setAttendeePhoneIndexIfEmpty fills an empty column, for that attendee only", async () => {
    const attendee = await createTestAttendeeWithPhone();
    const { attendee: other } = await createTestAttendeeDirect(
      (await createTestListing({ maxAttendees: 100 })).id,
      "Other",
      "other@example.com",
    );
    const idx = await computePhoneIndex("+447700900123");

    await setAttendeePhoneIndexIfEmpty(attendee.id, idx);

    expect(await storedPhoneIndex(attendee.id)).toBe(idx);
    // The write is keyed on the id — the other attendee stays unset.
    expect(await storedPhoneIndex(other.id)).toBe("");
  });

  test("setAttendeePhoneIndexIfEmpty never overwrites an existing index", async () => {
    const attendee = await createTestAttendeeWithPhone();
    const idx = await computePhoneIndex("+447700900123");
    await setAttendeePhoneIndexIfEmpty(attendee.id, idx);

    await setAttendeePhoneIndexIfEmpty(
      attendee.id,
      await computePhoneIndex("+447700900456"),
    );

    expect(await storedPhoneIndex(attendee.id)).toBe(idx);
  });

  test("setAttendeePhoneIndexIfEmpty with an empty index leaves the row unset", async () => {
    const attendee = await createTestAttendeeWithPhone();

    await setAttendeePhoneIndexIfEmpty(attendee.id, "");

    expect(await storedPhoneIndex(attendee.id)).toBe("");
  });

  test("set is idempotent and lookup finds the attendee", async () => {
    const attendee = await createTestAttendeeWithPhone();
    const idx = await computePhoneIndex("+447700900123");

    await setAttendeePhoneIndexIfEmpty(attendee.id, "");
    expect(await findAttendeeIdByPhoneIndex("")).toBeNull();

    await setAttendeePhoneIndexIfEmpty(attendee.id, idx);
    await setAttendeePhoneIndexIfEmpty(attendee.id, "different"); // ignored
    expect(await findAttendeeIdByPhoneIndex(idx)).toBe(attendee.id);
    expect(await findAttendeeIdByPhoneIndex("nope")).toBeNull();
  });

  test("lookup ignores servicing rows even if a phone index exists", async () => {
    const service = await createServicingHold();
    const idx = await computePhoneIndex("+447700900321");

    await setAttendeePhoneIndexIfEmpty(service.id, idx);

    expect(await findAttendeeIdByPhoneIndex(idx)).toBeNull();
  });
});
