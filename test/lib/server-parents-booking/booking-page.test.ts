import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createTestListing,
  describeWithEnv,
  makeParent,
  ticketGet,
} from "#test-utils";

describeWithEnv(
  "server > parents booking — booking page",
  { db: true, triggers: true },
  () => {
    test("a child slug cannot start a booking (404)", async () => {
      const { child } = await makeParent();
      const res = await ticketGet(child.slug);
      expect(res.status).toBe(404);
    });

    test("a parent slug still renders its booking page", async () => {
      const { parent } = await makeParent();
      const res = await ticketGet(parent.slug);
      expect(res.status).toBe(200);
    });

    test("a child mixed into a multi-slug URL rejects the whole request", async () => {
      const { child } = await makeParent();
      const other = await createTestListing({ name: "Unrelated" });
      const res = await ticketGet(`${child.slug}+${other.slug}`);
      expect(res.status).toBe(404);
    });

    test("an ordinary (non-child) listing is unaffected", async () => {
      const listing = await createTestListing({ name: "Plain" });
      const res = await ticketGet(listing.slug);
      expect(res.status).toBe(200);
    });
  },
);
