import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  makeParent,
  soldOutParentInGroup,
  ticketGet,
} from "#test-utils/parents.ts";

describeWithEnv(
  "server > parents booking — group QR",
  { db: true, triggers: true },
  () => {
    test("a group QR 404s when its only active member is a child", async () => {
      // The group's only active member is a child of a parent outside the group,
      // so `/ticket/<group>` drops it and 404s — its QR encodes that dead link,
      // so the QR route must 404 too.
      const group = await createTestGroup({ name: "Child-only QR group" });
      await makeParent({ children: [{ groupId: group.id }] });
      const res = await ticketGet(`${group.slug}/qr`);
      res.body?.cancel();
      expect(res.status).toBe(404);
    });

    test("a group QR 404s when its only standalone member is a no-bookable-child parent", async () => {
      // The group's only non-child member is a parent whose required child is
      // sold out, so /ticket/<group> renders no bookable quantity. The QR
      // encodes that dead page, so it must 404 — the SAME gate as the /listings
      // CTA (a parent projected sold out is not a bookable member).
      const { group } = await soldOutParentInGroup("Sold-out-parent QR group");
      const res = await ticketGet(`${group.slug}/qr`);
      res.body?.cancel();
      expect(res.status).toBe(404);
    });

    test("an ordinary group's QR still renders", async () => {
      const group = await createTestGroup({ name: "Plain QR group" });
      await createTestListing({ groupId: group.id, name: "A" });
      await createTestListing({ groupId: group.id, name: "B" });
      const res = await ticketGet(`${group.slug}/qr`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      const body = await res.text();
      expect(body).toContain("<svg");
    });
  },
);
