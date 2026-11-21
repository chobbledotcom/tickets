import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type AttendeeStatusDeleteError,
  type AttendeeStatusSaveError,
  attendeeStatusDeleteMessage,
  attendeeStatuses,
  attendeeStatusSaveMessage,
  attendeeStatusWrites,
  heldAttendeeCount,
  statusDeleteBlocker,
  statusDeleteProspects,
} from "#db/attendee-statuses.ts";
import { records } from "#db/record-table.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createAttendeeWithStatus } from "./held.ts";

const flags = (isPublicDefault: boolean, isPaidDefault: boolean) => ({
  isPaidDefault,
  isPublicDefault,
});

/** A refusal code and the exact message it reads as. */
type Refusal<Code extends string> = readonly [Code, string];

const SAVE_MESSAGES: readonly Refusal<AttendeeStatusSaveError>[] = [
  [
    "paid_default_required",
    "Choose another paid default before clearing this one",
  ],
  [
    "public_default_required",
    "Choose another public default before clearing this one",
  ],
];

const DELETE_MESSAGES: readonly Refusal<AttendeeStatusDeleteError>[] = [
  ["last_status", "You must keep at least one status"],
  ["paid_default", "Choose another paid default before deleting this status"],
  [
    "public_default",
    "Choose another public default before deleting this status",
  ],
  ["status_in_use", "Choose another status for its attendees before deleting"],
];

/** Adds a status with the given name and place in the list. */
const addStatus = (name: string, sortOrder: number) =>
  records.attendee_statuses.insert({ name, sortOrder });

for (const [code, message] of SAVE_MESSAGES) {
  test(`a refused status save reads as the exact message for ${code}`, () => {
    expect(attendeeStatusSaveMessage(code)).toBe(message);
  });
}

for (const [code, message] of DELETE_MESSAGES) {
  test(`a refused status delete reads as the exact message for ${code}`, () => {
    expect(attendeeStatusDeleteMessage(code)).toBe(message);
  });
}

test("the delete blocker is the last status first, then the public default, then the paid default", () => {
  expect(statusDeleteBlocker(flags(false, false), false)).toBe("last_status");
  expect(statusDeleteBlocker(flags(true, true), false)).toBe("last_status");
  expect(statusDeleteBlocker(flags(true, true), true)).toBe("public_default");
  expect(statusDeleteBlocker(flags(true, false), true)).toBe("public_default");
  expect(statusDeleteBlocker(flags(false, true), true)).toBe("paid_default");
  expect(statusDeleteBlocker(flags(false, false), true)).toBeNull();
});

describeWithEnv("db > attendee status refusals", { db: true }, () => {
  test("a delete of the only status is blocked as the last status", async () => {
    const seed = (await attendeeStatuses.getAll())[0]!;

    expect(await statusDeleteProspects(seed.id)).toEqual({
      blocker: "last_status",
      others: [],
    });
  });

  test("a delete prospect lists the other statuses and the blocker of the default", async () => {
    const seed = (await attendeeStatuses.getAll())[0]!;
    const other = await addStatus("Waitlist", 1);

    const ofSeed = await statusDeleteProspects(seed.id);
    expect(ofSeed.blocker).toBe("public_default");
    expect(ofSeed.others.map((status) => status.id)).toEqual([other.id]);

    const ofOther = await statusDeleteProspects(other.id);
    expect(ofOther.blocker).toBeNull();
    expect(ofOther.others.map((status) => status.id)).toEqual([seed.id]);
  });

  test("a delete with a reassign target moves every held attendee and logs the count", async () => {
    const busy = await addStatus("Busy", 1);
    const landing = await addStatus("Landing", 2);
    await createAttendeeWithStatus(busy.id);
    await createAttendeeWithStatus(busy.id);
    expect(await heldAttendeeCount(busy.id)).toBe(2);
    expect(await heldAttendeeCount(landing.id)).toBe(0);

    expect(await attendeeStatusWrites.delete(busy.id, landing.id)).toEqual({
      ok: true,
      value: undefined,
    });

    expect(await heldAttendeeCount(landing.id)).toBe(2);
    const messages = (await getAllActivityLog()).map((entry) => entry.message);
    expect(messages).toContain(
      "2 attendee(s) moved from status 'Busy' to 'Landing'",
    );
  });

  test("a delete that names the status itself as the target keeps everything", async () => {
    const busy = await addStatus("Self target", 1);
    await createAttendeeWithStatus(busy.id);

    expect(await attendeeStatusWrites.delete(busy.id, busy.id)).toEqual({
      error: "status_in_use",
      ok: false,
    });
    expect(await heldAttendeeCount(busy.id)).toBe(1);
  });
});
