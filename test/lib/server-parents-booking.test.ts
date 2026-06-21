import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setChildIds } from "#shared/db/listing-parents.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

/** GET a `/ticket/<slugs>` booking page. */
const ticketGet = async (slugs: string): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  return handleRequest(
    new Request(`http://localhost/ticket/${slugs}`, {
      headers: { host: "localhost" },
    }),
  );
};

describeWithEnv(
  "server > parents booking gate (flag on)",
  { db: true, env: { LISTING_PARENTS_ENABLED: "true" } },
  () => {
    test("a child slug cannot start a booking (404)", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const res = await ticketGet(child.slug);
      expect(res.status).toBe(404);
    });

    test("a parent slug still renders its booking page", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const res = await ticketGet(parent.slug);
      expect(res.status).toBe(200);
    });

    test("a child mixed into a multi-slug URL rejects the whole request", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      const other = await createTestListing({ name: "Unrelated" });
      await setChildIds(parent.id, [child.id]);
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

describeWithEnv(
  "server > parents booking gate (flag off)",
  { db: true },
  () => {
    test("a child slug still books normally when the flag is off", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const res = await ticketGet(child.slug);
      expect(res.status).toBe(200);
    });
  },
);
