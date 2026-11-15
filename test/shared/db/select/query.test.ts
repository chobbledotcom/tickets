import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import { TYPED_SCHEMA } from "#db/migrations/schema/index.ts";
import { columnFacts } from "#db/migrations/schema/scalar-columns.ts";
import {
  among,
  count,
  desc,
  equal,
  greaterThan,
  literal,
  sum,
} from "#db/select/expression.ts";
import { from, inQuery, via } from "#db/select/query.ts";
import { referenceOf, type TableHandle, tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { placed } from "#test-utils/sql-text.ts";

describe("from", () => {
  test("reads named values of one table under its singular word", () => {
    expect(
      placed(
        from(tables.listings)
          .where((listing) => equal(listing.id, 7))
          .select((listing) => ({
            cap: listing.max_attendees,
            id: listing.id,
          })),
      ),
    ).toEqual({
      args: [7],
      sql: "SELECT listing.max_attendees AS cap, listing.id AS id FROM listings AS listing WHERE listing.id = ?",
    });
  });

  test("reads every row when it says no condition", () => {
    expect(
      from(tables.holidays).select((holiday) => ({ id: holiday.id })).sql,
    ).toBe("SELECT holiday.id AS id FROM holidays AS holiday");
  });

  test("adds each where call to the conditions", () => {
    const read = from(tables.listings)
      .where((listing) => equal(listing.active, literal(1)))
      .where((listing) => [greaterThan(listing.max_attendees, 0), true])
      .values((listing) => listing.id);
    expect(read.sql).toBe(
      "SELECT listing.id FROM listings AS listing WHERE listing.active = 1 AND listing.max_attendees > ?1",
    );
  });

  test("groups, orders and limits", () => {
    expect(
      placed(
        from(tables.listing_attendees)
          .groupBy((line) => [line.listing_id])
          .orderBy((line) => [desc(sum(line.quantity)), line.listing_id])
          .limit(3)
          .select((line) => ({
            booked: sum(line.quantity),
            listing_id: line.listing_id,
          })),
      ),
    ).toEqual({
      args: [3],
      sql: "SELECT SUM(listingAttendee.quantity) AS booked, listingAttendee.listing_id AS listing_id FROM listing_attendees AS listingAttendee GROUP BY listingAttendee.listing_id ORDER BY SUM(listingAttendee.quantity) DESC, listingAttendee.listing_id LIMIT ?",
    });
  });

  test("keeps the read it was built from unchanged", () => {
    const all = from(tables.holidays);
    all.limit(1).where((holiday) => equal(holiday.id, 1));
    expect(all.values((holiday) => holiday.id).sql).toBe(
      "SELECT holiday.id FROM holidays AS holiday",
    );
  });
});

describe("joins", () => {
  test("follow a reference by the column name without _id", () => {
    expect(
      from(tables.listing_attendees, { listing: {} }).values(
        (line) => line.listing.name,
      ).sql,
    ).toBe(
      "SELECT listing.name FROM listing_attendees AS listingAttendee JOIN listings AS listing ON listing.id = listingAttendee.listing_id",
    );
  });

  test("join left along a column that can hold nothing, and below it", () => {
    expect(
      from(tables.attendee_answers, { answer: { question: {} } }).values(
        (given) => given.answer.question.id,
      ).sql,
    ).toBe(
      "SELECT question.id FROM attendee_answers AS attendeeAnswer LEFT JOIN answers AS answer ON answer.id = attendeeAnswer.answer_id LEFT JOIN questions AS question ON question.id = answer.question_id",
    );
  });

  test("give a key that SQL reads as its own word another word", () => {
    expect(
      from(tables.group_listings, { group: {} }).values(
        (membership) => membership.group.max_attendees,
      ).sql,
    ).toBe(
      "SELECT groupRow.max_attendees FROM group_listings AS groupListing JOIN groups AS groupRow ON groupRow.id = groupListing.group_id",
    );
  });

  test("join the rows that refer back to the parent", () => {
    const memberships = via(tables.group_listings, "listing", { group: {} });
    expect(
      from(tables.listings, { memberships }).values(
        (listing) => listing.memberships.group.id,
      ).sql,
    ).toBe(
      "SELECT groupRow.id FROM listings AS listing JOIN group_listings AS memberships ON memberships.listing_id = listing.id JOIN groups AS groupRow ON groupRow.id = memberships.group_id",
    );
    expect(
      from(tables.listings, { memberships: memberships.optional() }).values(
        (listing) => listing.memberships.group.id,
      ).sql,
    ).toBe(
      "SELECT groupRow.id FROM listings AS listing LEFT JOIN group_listings AS memberships ON memberships.listing_id = listing.id LEFT JOIN groups AS groupRow ON groupRow.id = memberships.group_id",
    );
  });

  test("join on a condition where no reference leads", () => {
    const read = from(tables.listing_attendees)
      .as("line")
      .join("membership", tables.group_listings, (line) =>
        equal(line.membership.listing_id, line.listing_id),
      )
      .leftJoin(
        "status",
        tables.attendee_statuses,
        (line) => [equal(line.status.id, 1)][0]!,
      )
      .values((line) => line.membership.group_id);
    expect(placed(read)).toEqual({
      args: [1],
      sql: "SELECT membership.group_id FROM listing_attendees AS line JOIN group_listings AS membership ON membership.listing_id = line.listing_id LEFT JOIN attendee_statuses AS status ON status.id = ?",
    });
  });

  test("refuse a key that is not a reference", () => {
    // @ts-expect-error a listing has no status to join
    from(tables.listings, { status: {} });
    // @ts-expect-error this reference of the child does not point at listings
    from(tables.listings, { rows: via(tables.group_listings, "group") });
    expect(() => referenceOf(tables.listings as TableHandle, "status")).toThrow(
      "listings has no status_id column to join along",
    );
    expect(() =>
      referenceOf(tables.listings as TableHandle, "slug_index_no"),
    ).toThrow("listings has no slug_index_no_id column to join along");
    expect(() =>
      referenceOf(tables.external_source_links as TableHandle, "external"),
    ).toThrow("external_source_links.external_id does not refer to a table");
  });

  test("refuse two tables under one word", () => {
    expect(() =>
      from(tables.listings)
        .join("listing", tables.listings, () => true)
        .values((listing) => listing.id),
    ).toThrow("A read names two tables listing. Give one another word.");
  });

  test("refuse a join that hides a column", () => {
    expect(() =>
      from(tables.listings)
        .join("name", tables.groups, () => true)
        .values((listing) => listing.id),
    ).toThrow("The join name hides a column or a join of that name.");
  });
});

describe("a read inside another", () => {
  const bookedBy = (listingId: Parameters<typeof equal<number>>[1]) =>
    from(tables.listing_attendees).where((line) =>
      equal(line.listing_id, listingId),
    );

  test("asks whether a row exists", () => {
    expect(
      placed(
        from(tables.listings)
          .where((listing) => bookedBy(listing.id).exists())
          .values((listing) => listing.id),
      ).sql,
    ).toBe(
      "SELECT listing.id FROM listings AS listing WHERE EXISTS (SELECT 1 FROM listing_attendees AS listingAttendee WHERE listingAttendee.listing_id = listing.id)",
    );
  });

  test("reads one value as an expression", () => {
    expect(
      placed(
        from(tables.listings).select((listing) => ({
          booked: bookedBy(listing.id).scalar((line) => sum(line.quantity)),
        })),
      ).sql,
    ).toBe(
      "SELECT (SELECT SUM(listingAttendee.quantity) FROM listing_attendees AS listingAttendee WHERE listingAttendee.listing_id = listing.id) AS booked FROM listings AS listing",
    );
  });

  test("names the values a column can take", () => {
    expect(
      placed(
        from(tables.listings)
          .where((listing) =>
            inQuery(
              listing.id,
              bookedBy(4).values((line) => line.listing_id),
            ),
          )
          .values((listing) => listing.id),
      ),
    ).toEqual({
      args: [4],
      sql: "SELECT listing.id FROM listings AS listing WHERE listing.id IN (SELECT listingAttendee.listing_id FROM listing_attendees AS listingAttendee WHERE listingAttendee.listing_id = ?)",
    });
  });

  test("refuses to hide a table of the outer read", () => {
    const parentOf = (childId: Parameters<typeof equal<number>>[1]) =>
      from(tables.listings).where((parent) => equal(parent.id, childId));
    expect(() =>
      from(tables.listings)
        .where((listing) => parentOf(listing.id).exists())
        .values((listing) => listing.id),
    ).toThrow(
      "A read inside another names a table listing, which hides the outer listing. Use .as() to give one another word.",
    );
    expect(
      from(tables.listings)
        .where((listing) => parentOf(listing.id).as("parent").exists())
        .values((listing) => listing.id).sql,
    ).toBe(
      "SELECT listing.id FROM listings AS listing WHERE EXISTS (SELECT 1 FROM listings AS parent WHERE parent.id = listing.id)",
    );
  });

  test("lets two sibling reads share a word", () => {
    const read = from(tables.groups).select((group) => ({
      first: bookedBy(group.id).scalar(() => count()),
      second: bookedBy(group.id).scalar(() => count()),
    }));
    expect(read.sql.split("AS listingAttendee").length).toBe(3);
  });
});

describe("matchesNothing", () => {
  test("is true only when a condition can pass no row", () => {
    const some = from(tables.listings).where((listing) =>
      among(listing.id, [1]),
    );
    expect(some.matchesNothing()).toBe(false);
    expect(
      some.where((listing) => among(listing.id, [])).matchesNothing(),
    ).toBe(true);
    expect(from(tables.listings).matchesNothing()).toBe(false);
  });
});

const referringColumns = TYPED_SCHEMA.flatMap(([name, table]) =>
  table.columns
    .filter(([, type]) => columnFacts(type).refersTo !== null)
    .map(([column]) => ({ column, table: name })),
);

describeWithEnv("the declared schema", { db: true }, () => {
  test("joins along every declared reference in the database", async () => {
    for (const { column, table } of referringColumns) {
      const key = column.slice(0, -"_id".length);
      const read = from(
        tables[table] as TableHandle<"listings">,
        {
          [key]: {},
        } as never,
      ).select(() => ({ one: literal(1) }));
      expect(await queryAll(read)).toEqual([]);
    }
    expect(referringColumns.length).toBeGreaterThan(40);
  });

  test("marks a column that can hold nothing as the database does", async () => {
    for (const [name, table] of TYPED_SCHEMA) {
      const live = await queryAll<{
        name: string;
        notnull: number;
        pk: number;
      }>(sql`SELECT name, "notnull", pk FROM pragma_table_info(${name})`);
      const declared = table.columns.map(([column, type]) => ({
        canBeNull: columnFacts(type).canBeNull,
        column,
      }));
      expect(declared).toEqual(
        live.map((column) => ({
          canBeNull: column.notnull === 0 && column.pk === 0,
          column: column.name,
        })),
      );
    }
  });

  test("gives a row its stored types", async () => {
    await queryAll(
      sql`INSERT INTO holidays (name, start_date, end_date) VALUES ('h', '2026-01-01', '2026-01-02')`,
    );
    const rows = await queryAll(
      from(tables.holidays).select((holiday) => ({
        id: holiday.id,
        name: holiday.name,
      })),
    );
    const [row] = rows;
    const id: number = row!.id;
    const name: string = row!.name;
    expect({ id, name }).toEqual({ id: 1, name: "h" });
  });
});
