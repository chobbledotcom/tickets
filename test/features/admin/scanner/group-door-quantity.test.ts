/** The group scanner's multi-ticket scans: the ask a line owing more than one
 * ticket puts to the door, the pick that answers it, and how the walk and the
 * totals read afterwards. The route suite beside these proves the guards and
 * the stored every-listing rule. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createMultiBookingAttendee } from "#test-utils/db-helpers/attendees.ts";
import { groupDoor, pickTicketsAtDoor, scanAtDoor } from "./support.ts";

describeWithEnv("group scanner multi-ticket scans", { db: true }, () => {
  describe("decideScan's quantity ask at the group door", () => {
    test("checks a member ticket in through the group door", async () => {
      const { group, members } = await groupDoor();
      const ticket = await createMultiBookingAttendee(
        "Ann",
        "ann@example.com",
        [{ listingId: members[0]!.id, quantity: 2 }],
      );
      // A line owing more than one ticket asks how many to admit.
      const { admission } = await pickTicketsAtDoor(
        group.id,
        ticket.ticket_token,
        2,
      );
      const { json } = admission;

      expect(json.status).toBe("checked_in");
      expect(json.name).toBe("Ann");
      expect(json.listingName).toBe("Standard");
      expect(json.quantity).toBe(2);
      expect(json.total).toBe(2);
      expect(json.remaining).toBe(0);
    });

    test("a part admission names its count against the line's total", async () => {
      const { group, members } = await groupDoor();
      const ticket = await createMultiBookingAttendee(
        "Bea",
        "bea@example.com",
        [{ listingId: members[0]!.id, quantity: 3 }],
      );

      const { json } = await scanAtDoor(group.id, {
        quantity: 2,
        token: ticket.ticket_token,
      });

      expect(json.status).toBe("checked_in");
      expect(json.quantity).toBe(2);
      expect(json.total).toBe(3);
      // The line still owes one ticket, so the manual list keeps Bea.
      expect(json.remaining).toBe(1);
      const again = await scanAtDoor(group.id, { token: ticket.ticket_token });
      expect(again.json.status).toBe("checked_in");
      expect(again.json.quantity).toBe(1);
      expect(again.json.total).toBe(3);
      const full = await scanAtDoor(group.id, { token: ticket.ticket_token });
      expect(full.json.status).toBe("already_checked_in");
    });

    test("walks a several-listing ticket one listing per scan", async () => {
      const { group, members } = await groupDoor(2);
      const ticket = await createMultiBookingAttendee(
        "Pat",
        "pat@example.com",
        [
          { listingId: members[0]!.id, quantity: 2 },
          { listingId: members[1]!.id, quantity: 1 },
        ],
      );
      const token = ticket.ticket_token;

      // The first listing owes two tickets, so the door answers its ask first.
      const ask = await scanAtDoor(group.id, { token });
      expect(ask.json.status).toBe("select_quantity");
      expect(ask.json.max).toBe(2);

      const first = await scanAtDoor(group.id, { quantity: 2, token });
      expect(first.json.status).toBe("checked_in");
      expect(first.json.listingName).toBe("Standard");
      expect(first.json.remaining).toBe(1);

      // The second listing owes exactly one, so it admits straight in.
      const second = await scanAtDoor(group.id, { token });
      expect(second.json.status).toBe("checked_in");
      expect(second.json.listingName).toBe("Society");
      expect(second.json.remaining).toBe(0);

      const third = await scanAtDoor(group.id, { token });
      expect(third.json.status).toBe("already_checked_in");
      expect(third.json.listingName).toBe("Standard, Society");
      expect(third.json.quantity).toBe(3);
    });
  });
});
