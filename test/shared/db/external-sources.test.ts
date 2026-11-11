/**
 * The external sources directory, at its storage boundary: what rests sealed,
 * what the blind index finds, and which link writes the two tables refuse.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { HYBRID_PREFIX } from "#crypto/hybrid.ts";
import { queryOne } from "#db/client.ts";
import {
  createExternalSourceLink,
  deleteExternalSource,
  deleteExternalSourceLink,
  externalLinkIndex,
  getAllExternalSources,
  getExternalSource,
  getExternalSourceLink,
  listExternalSourceLinks,
  requireExternalSourceLink,
  updateExternalSourceLink,
} from "#db/external-sources/queries.ts";
import { externalSourcesTable } from "#db/external-sources/tables.ts";
import type {
  ExternalSource,
  ExternalSourceLink,
} from "#db/external-sources/types.ts";
import { externalLinkUrl } from "#db/external-sources/url.ts";
import { requireSuccess } from "#shared/result.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withTestSession } from "#test-utils/session.ts";

const createSource = (
  name: string,
  urlPattern = "https://example.com/{external_id}",
): Promise<ExternalSource> => externalSourcesTable.insert({ name, urlPattern });

/** The row as the database holds it, before any column opens it. */
const storedSource = async (
  id: number,
): Promise<{ name: string; url_pattern: string }> =>
  (await queryOne<{ name: string; url_pattern: string }>(
    "SELECT name, url_pattern FROM external_sources WHERE id = ?",
    [id],
  ))!;

const storedLink = async (
  id: number,
): Promise<{ external_id: string; external_id_index: string }> =>
  (await queryOne<{ external_id: string; external_id_index: string }>(
    "SELECT external_id, external_id_index FROM external_source_links WHERE id = ?",
    [id],
  ))!;

const addListingLink = async (
  sourceId: number,
  externalId = "INV-1001",
  name = `Listing ${sourceId} ${externalId}`,
): Promise<ExternalSourceLink> => {
  const listing = await createTestListing({ name });
  return requireSuccess(
    await createExternalSourceLink(sourceId, {
      externalId,
      linkId: listing.id,
      linkType: "listing",
    }),
  );
};

describeWithEnv("db > external sources", { db: true }, () => {
  test("stores a source's name and URL pattern sealed, and opens them for an admin", async () => {
    const source = await createSource(
      "Stripe invoices",
      "https://dashboard.stripe.com/invoices/{external_id}",
    );

    const stored = await storedSource(source.id);
    expect(stored.name.startsWith(HYBRID_PREFIX)).toBe(true);
    expect(stored.url_pattern.startsWith(HYBRID_PREFIX)).toBe(true);
    expect(stored.name).not.toContain("Stripe");

    const opened = await withTestSession(() => getExternalSource(source.id));
    expect(opened).toEqual({
      created: source.created,
      id: source.id,
      name: "Stripe invoices",
      url_pattern: "https://dashboard.stripe.com/invoices/{external_id}",
    });
  });

  test("lists every source in the order it was added", async () => {
    const first = await createSource("Invoices");
    const second = await createSource("Shipping labels");

    const sources = await withTestSession(getAllExternalSources);
    expect(sources.map((source) => source.name)).toEqual([
      first.name,
      second.name,
    ]);
  });

  test("stores an external id sealed and finds it through its blind index", async () => {
    const source = await createSource("Invoices");
    const link = await addListingLink(source.id, "INV-1001");

    const stored = await storedLink(link.id);
    expect(stored.external_id.startsWith(HYBRID_PREFIX)).toBe(true);
    expect(stored.external_id).not.toContain("INV-1001");
    expect(stored.external_id_index).toBe(
      await externalLinkIndex(source.id, "INV-1001"),
    );

    const found = await withTestSession(() =>
      listExternalSourceLinks(source.id, {
        externalId: "INV-1001",
        kind: "external",
      }),
    );
    expect(found).toEqual([link]);
  });

  test("stores a link the other system has not named yet with no index", async () => {
    const source = await createSource("Diary");
    const listing = await createTestListing({ name: "Watercolour day" });
    const created = await createExternalSourceLink(source.id, {
      externalId: null,
      linkId: listing.id,
      linkType: "listing",
    });
    if (!created.ok) throw new Error(created.error);

    const stored = await queryOne<{
      external_id: string | null;
      external_id_index: string | null;
    }>(
      "SELECT external_id, external_id_index FROM external_source_links WHERE id = ?",
      [created.value.id],
    );
    expect(stored).toEqual({ external_id: null, external_id_index: null });

    const found = await withTestSession(() =>
      listExternalSourceLinks(source.id, { kind: "all" }),
    );
    expect(found).toEqual([created.value]);
  });

  test("keeps separate sources' external ids from matching each other", async () => {
    const invoices = await createSource("Invoices");
    const imports = await createSource("Imports");
    await addListingLink(invoices.id, "SHARED-1");
    await addListingLink(imports.id, "SHARED-1");

    const found = await withTestSession(() =>
      listExternalSourceLinks(invoices.id, {
        externalId: "SHARED-1",
        kind: "external",
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.source_id).toBe(invoices.id);
  });

  test("filters a source's links by the record they point at", async () => {
    const source = await createSource("Invoices");
    const listing = await createTestListing({ name: "Watercolour day" });
    const other = await createTestListing({ name: "Pottery day" });
    await createExternalSourceLink(source.id, {
      externalId: "INV-1",
      linkId: listing.id,
      linkType: "listing",
    });
    await createExternalSourceLink(source.id, {
      externalId: "INV-2",
      linkId: other.id,
      linkType: "listing",
    });

    const found = await withTestSession(() =>
      listExternalSourceLinks(source.id, {
        kind: "target",
        linkId: listing.id,
        linkType: "listing",
      }),
    );
    expect(found.map((link) => link.external_id)).toEqual(["INV-1"]);

    const all = await withTestSession(() =>
      listExternalSourceLinks(source.id, { kind: "all" }),
    );
    expect(all.map((link) => link.external_id)).toEqual(["INV-1", "INV-2"]);
  });

  test("links every kind of record a source may name", async () => {
    const source = await createSource("Imports");
    const listing = await createTestListing({ name: "Watercolour day" });
    const attendee = await bookTestAttendee([listing.id]);
    const group = await createTestGroup({ name: "Summer school" });

    const written = await Promise.all([
      createExternalSourceLink(source.id, {
        externalId: "L-1",
        linkId: listing.id,
        linkType: "listing",
      }),
      createExternalSourceLink(source.id, {
        externalId: "A-1",
        linkId: attendee.id,
        linkType: "attendee",
      }),
      createExternalSourceLink(source.id, {
        externalId: "G-1",
        linkId: group.id,
        linkType: "group",
      }),
    ]);

    expect(written.every((result) => result.ok)).toBe(true);
  });

  test("refuses a link to a record that does not exist", async () => {
    const source = await createSource("Invoices");

    const refused = await createExternalSourceLink(source.id, {
      externalId: "INV-404",
      linkId: 999_999,
      linkType: "listing",
    });

    expect(refused).toEqual({
      error: "No listing has id 999999",
      ok: false,
    });
  });

  test("lets one external id name several records", async () => {
    const source = await createSource("Invoices");
    const first = await addListingLink(
      source.id,
      "INV-1001",
      "Watercolour day",
    );
    const second = await addListingLink(source.id, "INV-1001", "Pottery day");

    const found = await withTestSession(() =>
      listExternalSourceLinks(source.id, {
        externalId: "INV-1001",
        kind: "external",
      }),
    );
    expect(found.map((link) => link.id)).toEqual([first.id, second.id]);
  });

  test("refuses the same record twice with one external id", async () => {
    const source = await createSource("Invoices");
    const first = await addListingLink(source.id, "INV-1001");

    const refused = await createExternalSourceLink(source.id, {
      externalId: "INV-1001",
      linkId: first.link_id,
      linkType: "listing",
    });

    expect(refused).toEqual({
      error: "This source already links that record to that external id",
      ok: false,
    });
  });

  test("changes a link's external id and the index that finds it", async () => {
    const source = await createSource("Invoices");
    const link = await addListingLink(source.id, "INV-1001");

    const changed = await updateExternalSourceLink(link, {
      externalId: "INV-2002",
      linkId: link.link_id,
      linkType: "listing",
    });
    expect(changed).toEqual({ ok: true, value: true });

    const stored = await withTestSession(() =>
      requireExternalSourceLink(source.id, link.id),
    );
    expect(stored.external_id).toBe("INV-2002");
    expect(stored.external_id_index).toBe(
      await externalLinkIndex(source.id, "INV-2002"),
    );

    const oldIndex = await withTestSession(() =>
      listExternalSourceLinks(source.id, {
        externalId: "INV-1001",
        kind: "external",
      }),
    );
    expect(oldIndex).toEqual([]);
  });

  test("deletes one link, and a source with all of its links", async () => {
    const source = await createSource("Invoices");
    const first = await addListingLink(source.id, "INV-1");
    await addListingLink(source.id, "INV-2");

    await deleteExternalSourceLink(first);
    expect(await getExternalSourceLink(source.id, first.id)).toBeNull();

    await deleteExternalSource(source.id);
    expect(await getExternalSource(source.id)).toBeNull();
    const remaining = await withTestSession(() =>
      listExternalSourceLinks(source.id, { kind: "all" }),
    );
    expect(remaining).toEqual([]);
  });

  test("reports a link that a write was about to answer with as missing", async () => {
    const source = await createSource("Invoices");

    await expect(requireExternalSourceLink(source.id, 999_999)).rejects.toThrow(
      "External source link 999999 is missing from source",
    );
  });

  test("fills a source's pattern with the external id", async () => {
    expect(
      externalLinkUrl(
        "https://dashboard.stripe.com/invoices/{external_id}",
        "in_3Nx8Yz",
      ),
    ).toBe("https://dashboard.stripe.com/invoices/in_3Nx8Yz");
  });

  test("encodes an external id that would change the address's shape", () => {
    expect(
      externalLinkUrl("https://diary.example/events/{external_id}", "a/b c"),
    ).toBe("https://diary.example/events/a%2Fb%20c");
  });

  test("gives a link with no external id no address", () => {
    expect(
      externalLinkUrl("https://diary.example/new-booking", null),
    ).toBeNull();
  });

  test("keeps a destination pattern's own address when it holds no id", () => {
    expect(externalLinkUrl("https://diary.example/new-booking", "EVT-1")).toBe(
      "https://diary.example/new-booking",
    );
  });
});
