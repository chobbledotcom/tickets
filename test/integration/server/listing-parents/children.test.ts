import type { Client } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { getDb, setDb } from "#shared/db/client.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { linkedParentChild } from "#test/test-utils/listing-parents/helpers.ts";
import { getListingActivityLog } from "#test-utils/activity-log.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  listingEditPageHtml,
  listingRosterPageHtml,
  postChildren,
} from "#test-utils/parents.ts";

/** The rendered edit-page HTML for the first attendee of a booking result. */
const attendeeEditHtml = async (result: unknown): Promise<string> => {
  const { adminGet } = await import("#test-utils/session.ts");
  const attendee = (result as { success: true; attendees: { id: number }[] })
    .attendees[0]!;
  const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
  return response.text();
};

describeWithEnv("server > listing parents > children", { db: true }, () => {
  test("saves the chosen children and redirects", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const res = await postChildren(parent.id, [child.id]);
    expect(res.headers.get("location")).toContain(
      `/admin/listing/${parent.id}/edit`,
    );
    // A success flash, not an error one.
    expectFlash(res, "Required children updated");
    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
    // The save is recorded in the listing's activity log, with the count
    // singularised ("1 listing", not "1 listings").
    const logs = await getListingActivityLog(parent.id);
    const entry = logs.find((l) =>
      l.message.includes("required children set to"),
    );
    expect(entry?.message).toBe(
      "Listing 'Base unit' required children set to 1 listing",
    );
  });

  test("shows a validation error when a child vanishes before the write", async () => {
    const parent = await createTestListing({ name: "Race parent" });
    const child = await createTestListing({ name: "Race child" });
    const real = getDb();
    let deleted = false;
    const raceClient = new Proxy(real, {
      get(target, property) {
        if (property === "transaction") {
          return async (...args: Parameters<Client["transaction"]>) => {
            if (!deleted) {
              deleted = true;
              await target.execute({
                args: [child.id],
                sql: "DELETE FROM listings WHERE id = ?",
              });
            }
            return target.transaction(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    setDb(raceClient);

    let response: Response;
    try {
      response = await postChildren(parent.id, [child.id]);
    } finally {
      setDb(real);
    }

    expect(response.headers.get("location")).toContain("/admin/listings");
    expectFlash(response, t("error.child_listing_deleted"), false);
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("drops self-edges and unknown ids", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await postChildren(parent.id, [parent.id, child.id, parent.id + 9999]);
    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });

  test("renders the section with the chosen child checked", async () => {
    const { parent, child } = await linkedParentChild();
    const html = await listingEditPageHtml(parent.id);
    expect(html).toContain("Required child listings");
    expect(html).toContain(
      `<input checked name="child_listing_ids" type="checkbox" value="${child.id}">`,
    );
  });

  test("saves multiple children", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const childA = await createTestListing({ name: "Add-on A" });
    const childB = await createTestListing({ name: "Add-on B" });
    const response = await postChildren(parent.id, [childA.id, childB.id]);
    expectFlash(response, "Required children updated");
    expect(await listingChildren.getIds(parent.id)).toEqual(
      [childA.id, childB.id].sort((a, b) => a - b),
    );
    const logs = await getListingActivityLog(parent.id);
    expect(
      logs
        .filter((entry) => entry.message.includes("required children set to"))
        .map((entry) => entry.message),
    ).toEqual(["Listing 'Base unit' required children set to 2 listings"]);
  });

  test("renders unticked siblings without the checked attribute", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const other = await createTestListing({ name: "Unrelated" });
    await postChildren(parent.id, [child.id]);
    const html = await listingEditPageHtml(parent.id);
    expect(html).toContain(
      `<input checked name="child_listing_ids" type="checkbox" value="${child.id}">`,
    );
    expect(html).toContain(
      `<input name="child_listing_ids" type="checkbox" value="${other.id}">`,
    );
  });

  test("shows what a child is offered under", async () => {
    const { child } = await linkedParentChild();
    const html = await listingEditPageHtml(child.id);
    expect(html).toContain("This listing is itself offered under: Base unit.");
  });

  test("pre-disables a candidate that is itself a parent (usability #4)", async () => {
    // `child` already has its own child `grandchild`, so it can't also be a
    // child of `parent` — its candidate checkbox is disabled with the reason,
    // so the operator can't tick an edge the save would reject.
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Mid" });
    const grandchild = await createTestListing({ name: "Leaf" });
    await postChildren(child.id, [grandchild.id]);
    const html = await listingEditPageHtml(parent.id);
    expect(html).toContain(
      `<input disabled name="child_listing_ids" type="checkbox" value="${child.id}">`,
    );
    expect(html).toContain("already has its own child listings");
  });

  test("pre-disables a daily candidate under a non-daily parent (usability #4)", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const daily = await createTestListing({
      listingType: "daily",
      name: "Daily add-on",
    });
    const html = await listingEditPageHtml(parent.id);
    expect(html).toContain(
      `<input disabled name="child_listing_ids" type="checkbox" value="${daily.id}">`,
    );
  });

  test("a child listing's edit page shows the inherited-fields banner (usability #3)", async () => {
    const { child } = await linkedParentChild();
    const html = await listingEditPageHtml(child.id);
    expect(html).toContain("This listing is offered as a child of Base unit");
    expect(html).toContain(
      "Inherited from the parent when this listing is chosen as a child",
    );
  });

  test("a non-child listing's edit page shows no inherited-fields banner", async () => {
    const standalone = await createTestListing({ name: "Standalone" });
    const html = await listingEditPageHtml(standalone.id);
    expect(html).not.toContain("This listing is offered as a child of");
    expect(html).not.toContain(
      "Inherited from the parent when this listing is chosen as a child",
    );
  });

  test("a parent's detail page warns when manually adding an attendee (usability #2b)", async () => {
    const { parent } = await linkedParentChild();
    const html = await listingRosterPageHtml(parent.id);
    expect(html).toContain("This listing requires a child listing (Add-on)");
  });

  test("a non-parent's detail page shows no manual-add child warning", async () => {
    const standalone = await createTestListing({ name: "Standalone" });
    const html = await listingRosterPageHtml(standalone.id);
    expect(html).not.toContain("requires a child listing");
  });

  test("editing an attendee who booked only a parent warns its child is missing (usability #6)", async () => {
    const { bookAttendee } = await import(
      "#test-utils/db-helpers/attendee-payments.ts"
    );
    const { parent } = await linkedParentChild();
    // bookAttendee writes through the atomic path (no gate), creating exactly the
    // lone-parent state an admin manual add would.
    const result = await bookAttendee(parent, { name: "Ada" });
    const html = await attendeeEditHtml(result);
    expect(html).toContain(
      "requires one of its child listings to be booked too (Add-on)",
    );
  });

  test("editing an attendee who booked both parent and child shows no missing-child warning", async () => {
    const { attendeesApi } = await import("#shared/db/attendees/api.ts");
    const { parent, child } = await linkedParentChild();
    // Both lines booked on the one attendee — the gate is satisfied.
    const result = await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: parent.id }, { listingId: child.id }],
      email: "a@b.com",
      name: "Ada",
    });
    const html = await attendeeEditHtml(result);
    expect(html).not.toContain("requires one of its child listings");
  });

  test("notes when there are no other listings to choose from", async () => {
    const only = await createTestListing({ name: "Solo" });
    const html = await listingEditPageHtml(only.id);
    expect(html).toContain("No other listings to choose from yet.");
  });
});
