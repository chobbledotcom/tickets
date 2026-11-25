/** A listing that is deleted leaves its child bookings behind, with their
 * answers. The attendee page still opens, and it names the missing parent by
 * its number. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  addGlowPack,
  attendeeIds,
  attendeePage,
  book,
  fieldFor,
  openDiscos,
  withPupilName,
} from "#test/blackbox/discos.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv(
  "the attendee page after a parent listing is deleted",
  { db: true },
  () => {
    test("still shows the answers of the child line, naming the parent by its number", async () => {
      const shop = await withPupilName(await openDiscos());
      const glow = await addGlowPack(shop, [shop.discoA]);
      await book(shop, [1, 0], {
        [fieldFor(shop.question, shop.discoA)]: "Ava",
        [fieldFor(shop.question, glow, { parent: shop.discoA })]: "Kit",
      });
      const [id] = await attendeeIds(shop.api, glow);
      const removed = await shop.api.delete(
        `/api/admin/listings/${shop.discoA.id}`,
        { confirm_identifier: "Disco A" },
      );
      const page = await shop.owner.get(`/admin/attendees/${id}`);

      expect([removed.status, page.status]).toEqual([200, 200]);
      expect(await attendeePage(shop, glow)).toContain(
        `Pupil name (Glow Pack with #${shop.discoA.id}) Kit`,
      );
    });
  },
);
