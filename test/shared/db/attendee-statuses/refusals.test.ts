import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeStatusDeleteMessage,
  attendeeStatuses,
  attendeeStatusSaveMessage,
  attendeeStatusWrites,
  heldAttendeeCount,
  statusDeleteBlocker,
  statusDeleteProspects,
} from "#db/attendee-statuses.ts";
import { getDb } from "#db/client.ts";
import { records } from "#db/record-table.ts";
import { sql } from "#db/sql.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const flags = (isPublicDefault: boolean, isPaidDefault: boolean) => ({
  isPaidDefault,
  isPublicDefault,
});

const createAttendeeWithStatus = async (statusId: number): Promise<number> => {
  const attendee = await getDb().execute(
    sql`INSERT INTO attendees (created, pii_blob, status_id) VALUES (${new Date().toISOString()}, '', ${statusId})`,
  );
  return Number(attendee.lastInsertRowid);
};

test("a refused status save reads as the exact message for its code", () => {
  expect(attendeeStatusSaveMessage("paid_default_required")).toBe(
    "Choose another paid default before clearing this one",
  );
  expect(attendeeStatusSaveMessage("public_default_required")).toBe(
    "Choose another public default before clearing this one",
  );
});

test("a refused status delete reads as the exact message for its code", () => {
  expect(attendeeStatusDeleteMessage("last_status")).toBe(
    "You must keep at least one status",
  );
  expect(attendeeStatusDeleteMessage("paid_default")).toBe(
    "Choose another paid default before deleting this status",
  );
  expect(attendeeStatusDeleteMessage("public_default")).toBe(
    "Choose another public default before deleting this status",
  );
  expect(attendeeStatusDeleteMessage("status_in_use")).toBe(
    "Choose another status for its attendees before deleting",
  );
});

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
    const other = await records.attendee_statuses.insert({
      name: "Waitlist",
      sortOrder: 1,
    });

    const ofSeed = await statusDeleteProspects(seed.id);
    expect(ofSeed.blocker).toBe("public_default");
    expect(ofSeed.others.map((status) => status.id)).toEqual([other.id]);

    const ofOther = await statusDeleteProspects(other.id);
    expect(ofOther.blocker).toBeNull();
    expect(ofOther.others.map((status) => status.id)).toEqual([seed.id]);
  });

  test("a delete with a reassign target moves every held attendee and logs the count", async () => {
    const busy = await records.attendee_statuses.insert({
      name: "Busy",
      sortOrder: 1,
    });
    const landing = await records.attendee_statuses.insert({
      name: "Landing",
      sortOrder: 2,
    });
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
    const busy = await records.attendee_statuses.insert({
      name: "Self target",
      sortOrder: 1,
    });
    await createAttendeeWithStatus(busy.id);

    expect(await attendeeStatusWrites.delete(busy.id, busy.id)).toEqual({
      error: "status_in_use",
      ok: false,
    });
    expect(await heldAttendeeCount(busy.id)).toBe(1);
  });
});
