import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { makeParent, ticketGet } from "#test-utils/parents.ts";

describeWithEnv(
  "server > parents booking — group pages",
  { db: true, triggers: true },
  () => {
    test("a group containing a child member still renders (not 404)", async () => {
      // The group page loads members indirectly, so a child member is suppressed
      // /folded — not a reason to 404 the whole group (the buyer isn't starting
      // from the child directly).
      const { group } = await makeParent({ group: { name: "Combo" } });
      const res = await ticketGet(group!.slug);
      expect(res.status).toBe(200);
    });

    test("a group page renders the parent with a child selector but no standalone child quantity row", async () => {
      const { parent, child, group } = await makeParent({
        group: { name: "Combo" },
      });
      const body = await (await ticketGet(group!.slug)).text();
      // The parent still offers its standalone quantity selector and the child
      // appears in the parent's child block (here a sole child, auto-selected and
      // shown informationally); the child must NOT get its own standalone
      // quantity control (`quantity_<childId>`).
      expect(body).toContain(`name="quantity_${parent.id}"`);
      expect(body).toContain(`data-sole-child="${child.id}"`);
      expect(body).not.toContain(`name="quantity_${child.id}"`);
    });

    test("a group page cannot book the child alone", async () => {
      const { child, group } = await makeParent({ group: { name: "Combo" } });
      const { handleRequest } = await import("#routes");
      const { signCsrfToken } = await import("#shared/csrf.ts");
      const res = await handleRequest(
        new Request(`http://localhost/ticket/${group!.slug}`, {
          body: new URLSearchParams({
            csrf_token: await signCsrfToken(),
            email: "a@b.com",
            name: "Ada",
            [`quantity_${child.id}`]: "1",
          }),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: "localhost",
          },
          method: "POST",
        }),
      );
      // The child's quantity field is ignored (it is not a standalone row), so
      // no child attendee is created.
      const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
      expect((await getAttendeesRaw(child.id)).length).toBe(0);
      expect(res.status).not.toBe(500);
    });

    test("a group of ordinary listings is unaffected", async () => {
      const group = await createTestGroup({ name: "Plain combo" });
      const a = await createTestListing({ groupId: group.id, name: "A" });
      const b = await createTestListing({ groupId: group.id, name: "B" });
      const body = await (await ticketGet(group.slug)).text();
      expect(body).toContain(`name="quantity_${a.id}"`);
      expect(body).toContain(`name="quantity_${b.id}"`);
    });

    test("a group whose only member is a child returns 404", async () => {
      // Every member of the group is a child of a parent outside the group, so
      // dropping children empties the page — there is nothing standalone-bookable
      // and a booking can never start from a child, so the group page 404s rather
      // than rendering a 200 empty booking page.
      const group = await createTestGroup({ name: "Child-only group" });
      await makeParent({ children: [{ groupId: group.id }] });
      const res = await ticketGet(group.slug);
      res.body?.cancel();
      expect(res.status).toBe(404);
    });
  },
);
