import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  among,
  desc,
  equal,
  greaterThan,
  inQuery,
  inStatement,
  literal,
  matchesNothing,
  notInQuery,
  sum,
} from "#db/select/expression.ts";
import { from, tableNode, via } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { placed } from "#test-utils/sql-text.ts";

describe("from", () => {
  test("reads named values of one table under its singular word", () => {
    expect(
      placed(
        from(tables.listings)
          .where((listing) => equal(listing.id, 7))
          .select((listing) => ({
            cap: listing.maxAttendees,
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
      .where((listing) => [greaterThan(listing.maxAttendees, 0), true])
      .values((listing) => listing.id);
    expect(read.sql).toBe(
      "SELECT listing.id FROM listings AS listing WHERE listing.active = 1 AND listing.max_attendees > ?1",
    );
  });

  test("groups, orders and limits", () => {
    expect(
      placed(
        from(tables.listing_attendees)
          .groupBy((line) => [line.listingId])
          .orderBy((line) => [desc(sum(line.quantity)), line.listingId])
          .limit(3)
          .select((line) => ({
            booked: sum(line.quantity),
            listing_id: line.listingId,
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
  const alongReferences = [
    [
      "follow a reference by the column name without _id",
      from(tables.listing_attendees, { listing: {} }).values(
        (line) => line.listing.name,
      ),
      "SELECT listing.name FROM listing_attendees AS listingAttendee JOIN listings AS listing ON listing.id = listingAttendee.listing_id",
    ],
    [
      "join left along a column that can hold nothing, and below it",
      from(tables.attendee_answers, { answer: { question: {} } }).values(
        (given) => given.answer.question.id,
      ),
      "SELECT question.id FROM attendee_answers AS attendeeAnswer LEFT JOIN answers AS answer ON answer.id = attendeeAnswer.answer_id LEFT JOIN questions AS question ON question.id = answer.question_id",
    ],
    [
      "give a key that SQL reads as its own word another word",
      from(tables.group_listings, { group: {} }).values(
        (membership) => membership.group.maxAttendees,
      ),
      "SELECT groupRow.max_attendees FROM group_listings AS groupListing JOIN groups AS groupRow ON groupRow.id = groupListing.group_id",
    ],
    [
      "give the key case another word too",
      from(tables.payment_case_decisions, { case: {} }).values(
        (decision) => decision.case.id,
      ),
      "SELECT caseRow.id FROM payment_case_decisions AS paymentCaseDecision JOIN payment_cases AS caseRow ON caseRow.id = paymentCaseDecision.case_id",
    ],
  ] as const;

  for (const [title, read, text] of alongReferences) {
    test(title, () => {
      expect(read.sql).toBe(text);
    });
  }

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
        equal(line.membership.listingId, line.listingId),
      )
      .leftJoin(
        "status",
        tables.attendee_statuses,
        (line) => [equal(line.status.id, 1)][0]!,
      )
      .values((line) => line.membership.groupId);
    expect(placed(read)).toEqual({
      args: [1],
      sql: "SELECT membership.group_id FROM listing_attendees AS line JOIN group_listings AS membership ON membership.listing_id = line.listing_id LEFT JOIN attendee_statuses AS status ON status.id = ?",
    });
  });

  test("refuse a key that is not a reference", () => {
    // @ts-expect-error this reference of the child does not point at listings
    from(tables.listings, { rows: via(tables.group_listings, "group") });
    expect(() =>
      // @ts-expect-error a listing has no status to join
      from(tables.listings, { status: {} }).values((listing) => listing.id),
    ).toThrow("listings has no status_id column to join along");
  });

  const refusedJoins = [
    [
      "two tables under one word",
      "listing",
      tables.listings,
      "A read names two tables listing. Give one another word.",
    ],
    [
      "a join that hides a column",
      "name",
      tables.groups,
      "The join name hides a column or a join of that name.",
    ],
  ] as const;

  for (const [what, key, joined, message] of refusedJoins) {
    test(`refuse ${what}`, () => {
      expect(() =>
        from(tables.listings)
          .join(key, joined, () => true)
          .values((listing) => listing.id),
      ).toThrow(message);
    });
  }
});

describe("a read inside another", () => {
  const bookedBy = (listingId: Parameters<typeof equal<number>>[1]) =>
    from(tables.listing_attendees).where((line) =>
      equal(line.listingId, listingId),
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
              bookedBy(4).values((line) => line.listingId),
            ),
          )
          .values((listing) => listing.id),
      ),
    ).toEqual({
      args: [4],
      sql: "SELECT listing.id FROM listings AS listing WHERE listing.id IN (SELECT listingAttendee.listing_id FROM listing_attendees AS listingAttendee WHERE listingAttendee.listing_id = ?)",
    });
  });

  test("names the values a column cannot take", () => {
    expect(
      from(tables.listings)
        .where((listing) =>
          notInQuery(
            listing.id,
            from(tables.listing_parents).values((edge) => edge.childListingId),
          ),
        )
        .values((listing) => listing.id).sql,
    ).toBe(
      "SELECT listing.id FROM listings AS listing WHERE NOT listing.id IN (SELECT listingParent.child_listing_id FROM listing_parents AS listingParent)",
    );
  });

  test("refuses to hide a table of the outer read", () => {
    const everyListing = from(tables.listings);
    expect(() =>
      from(tables.listings)
        .where(() => everyListing.exists())
        .values((listing) => listing.id),
    ).toThrow(
      "A read inside another names a table listing, which hides the outer listing. Use .as() to give one another word.",
    );
    expect(
      from(tables.listings)
        .where(() => everyListing.as("parent").exists())
        .values((listing) => listing.id).sql,
    ).toBe(
      "SELECT listing.id FROM listings AS listing WHERE EXISTS (SELECT 1 FROM listings AS parent)",
    );
  });

  test("lets two sibling reads share a word", () => {
    const read = from(tables.groups).select((group) => ({
      first: bookedBy(group.id).scalar((line) => sum(line.quantity)),
      second: bookedBy(group.id).scalar((line) => sum(line.quantity)),
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

describe("the statement of a read", () => {
  const ids = (wanted: readonly number[]) =>
    from(tables.listings)
      .where((listing) => among(listing.id, wanted))
      .values((listing) => listing.id);

  test("carries the mark of a read that no row can pass", () => {
    expect(matchesNothing(ids([]))).toBe(true);
    expect(matchesNothing(ids([1]))).toBe(false);
  });

  test("leaves the statement as valid SQL for a batch", () => {
    expect(ids([]).sql).toBe(
      "SELECT listing.id FROM listings AS listing WHERE listing.id IN (NULL)",
    );
  });

  test("carries no mark where it is written by hand", () => {
    expect(matchesNothing(sql`SELECT 1 WHERE 0`)).toBe(false);
  });
});

describe("a column list written by hand", () => {
  test("goes into the read as it is, with every clause in SQL order", () => {
    expect(
      from(tables.listings)
        .where((listing) => equal(listing.active, 1))
        .groupBy((listing) => [listing.id])
        .orderBy((listing) => [desc(listing.created)])
        .limit(5)
        .columns((listing) => sql`${listing.id}, COUNT(*) AS lines`),
    ).toEqual(
      sql`SELECT listing.id, COUNT(*) AS lines FROM listings AS listing WHERE listing.active = ${1} GROUP BY listing.id ORDER BY listing.created DESC LIMIT ${5}`,
    );
  });

  test("binds the values of a join before the conditions, then the limit", () => {
    expect(
      from(tables.questions)
        .leftJoin("listingQuestion", tables.listing_questions, (question) =>
          equal(question.listingQuestion.listingId, 7),
        )
        .where((question) => equal(question.sortOrder, 8))
        .limit(2)
        .columns((question) => question.id).args,
    ).toEqual([7, 8, 2]);
  });

  test("adds no WHERE for an empty list of conditions", () => {
    expect(
      from(tables.listings)
        .where(() => [])
        .columns((listing) => listing.id).sql,
    ).toBe("SELECT listing.id FROM listings AS listing");
  });
});

describe("aggregate", () => {
  test("reads the one value of a read that folds every row", () => {
    expect(
      from(tables.listing_attendees).aggregate((line) => sum(line.quantity))
        .sql,
    ).toBe(
      "(SELECT SUM(listingAttendee.quantity) FROM listing_attendees AS listingAttendee)",
    );
  });

  test("refuses a grouped read, which has many rows", () => {
    expect(() =>
      from(tables.listing_attendees)
        .groupBy((line) => [line.listingId])
        .aggregate((line) => sum(line.quantity)),
    ).toThrow("A grouped read has many rows, so it has no one value.");
  });
});

describe("statements written by hand", () => {
  test("take the columns of a table under the word they name it by", () => {
    const line = tableNode(tables.listing_attendees, "la");
    expect(sql`SELECT ${line.quantity} FROM listing_attendees AS la`.sql).toBe(
      "SELECT la.quantity FROM listing_attendees AS la",
    );
  });

  test("give their one column to an IN test", () => {
    expect(
      placed(
        from(tables.listings)
          .where((listing) =>
            inStatement(
              listing.id,
              sql`SELECT thing FROM things WHERE x = ${3}`,
            ),
          )
          .values((listing) => listing.id),
      ),
    ).toEqual({
      args: [3],
      sql: "SELECT listing.id FROM listings AS listing WHERE listing.id IN (SELECT thing FROM things WHERE x = ?)",
    });
  });
});
