/**
 * What happens to a link when the record it names goes away or moves.
 *
 * The link names its record with two columns, so a record delete must remove
 * only its own kind's links, and a merge must move them to the survivor.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  deleteAttendee,
  repointAttendeeDependents,
} from "#db/attendees/delete.ts";
import { executeBatch } from "#db/client.ts";
import {
  createExternalSourceLink,
  listExternalSourceLinks,
} from "#db/external-sources/queries.ts";
import { externalSourcesTable } from "#db/external-sources/tables.ts";
import type {
  ExternalLinkKind,
  ExternalSourceLink,
} from "#db/external-sources/types.ts";
import { deleteListing } from "#db/listings/delete.ts";
import { deleteGroup } from "#shared/records/groups.ts";
import { requireValue } from "#shared/required-value.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withTestSession } from "#test-utils/session.ts";

const createSource = (name: string) =>
  externalSourcesTable.insert({
    name,
    urlPattern: "https://example.com/{external_id}",
  });

const addLink = async (
  sourceId: number,
  linkType: ExternalLinkKind,
  linkId: number,
  externalId: string,
): Promise<ExternalSourceLink> => {
  const created = await createExternalSourceLink(sourceId, {
    externalId,
    linkId,
    linkType,
  });
  if (!created.ok) throw new Error(created.error);
  return created.value;
};

/** The external ids the source still holds, opened for an admin. */
const externalIds = async (sourceId: number): Promise<string[]> =>
  (
    await withTestSession(() =>
      listExternalSourceLinks(sourceId, { kind: "all" }),
    )
  ).map((link) =>
    requireValue(
      link.external_id,
      "A link in this test carries an external id",
    ),
  );

describeWithEnv("db > external links follow their record", { db: true }, () => {
  test("removes an attendee's links and keeps the other attendee's", async () => {
    const source = await createSource("Invoices");
    const listing = await createTestListing();
    const gone = (
      await createTestAttendeeDirect(listing.id, "Ann", "ann@example.com")
    ).attendee;
    const kept = (
      await createTestAttendeeDirect(listing.id, "Bo", "bo@example.com")
    ).attendee;
    await addLink(source.id, "attendee", gone.id, "INV-1");
    await addLink(source.id, "attendee", kept.id, "INV-2");
    await addLink(source.id, "listing", listing.id, "LIST-1");

    await deleteAttendee(gone.id);

    expect(await externalIds(source.id)).toEqual(["INV-2", "LIST-1"]);
  });

  test("moves an attendee's links to the surviving attendee", async () => {
    const source = await createSource("Invoices");
    const listing = await createTestListing();
    const sourceAttendee = (
      await createTestAttendeeDirect(listing.id, "Ann", "ann@example.com")
    ).attendee;
    const targetAttendee = (
      await createTestAttendeeDirect(listing.id, "Bo", "bo@example.com")
    ).attendee;
    await addLink(source.id, "attendee", sourceAttendee.id, "INV-1");

    await executeBatch(
      repointAttendeeDependents(sourceAttendee.id, targetAttendee.id),
    );

    const moved = await withTestSession(() =>
      listExternalSourceLinks(source.id, {
        kind: "target",
        linkId: targetAttendee.id,
        linkType: "attendee",
      }),
    );
    expect(moved.map((link) => link.external_id)).toEqual(["INV-1"]);
  });

  test("removes a listing's links with the listing", async () => {
    const source = await createSource("Shipping labels");
    const kept = await createTestListing({ name: "Pottery day" });
    const gone = await createTestListing({ name: "Watercolour day" });
    await addLink(source.id, "listing", gone.id, "SHIP-1");
    await addLink(source.id, "listing", kept.id, "SHIP-2");

    await deleteListing(gone.id);

    expect(await externalIds(source.id)).toEqual(["SHIP-2"]);
  });

  test("removes a group's links with the group", async () => {
    const source = await createSource("Imports");
    const gone = await createTestGroup({ name: "Watercolour" });
    const kept = await createTestGroup({ name: "Pottery" });
    await addLink(source.id, "group", gone.id, "GROUP-1");
    await addLink(source.id, "group", kept.id, "GROUP-2");

    await deleteGroup(gone.id);

    expect(await externalIds(source.id)).toEqual(["GROUP-2"]);
  });
});
