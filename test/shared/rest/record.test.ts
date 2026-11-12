/**
 * The one write path every admin record shares: the rule runs first, the row,
 * its joins, its order append, and its activity line commit together, and a
 * refusal writes nothing.
 *
 * The HTTP contract for each record (list, read, create, update, delete, and
 * the role answers) stays with that record's own suites and the parity pins.
 */

import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import type { AdminApiResource } from "#shared/admin-api-resources.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminDestination, adminDestinationAt } from "#shared/admin-surface.ts";
import { attributeRecord } from "#shared/records/attributes.ts";
import { externalSourceRecord } from "#shared/records/external-sources.ts";
import { groupRecord } from "#shared/records/groups.ts";
import { holidayRecord } from "#shared/records/holidays.ts";
import { imageRecord } from "#shared/records/images.ts";
import { listingRecord } from "#shared/records/listings.ts";
import { questionRecord } from "#shared/records/questions.ts";
import { sitePageRecord } from "#shared/records/site-pages.ts";
import { statusRecord } from "#shared/records/statuses.ts";
import {
  defineRecord,
  deleteAudienceFor,
  jsonAudienceFor,
  type RecordSpec,
} from "#shared/rest/record.ts";
import { errorResult, okResult } from "#shared/result.ts";
import { wasActivityLogged } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  type IdNameInput,
  type IdNameRow,
  makeIdNameTable,
} from "#test-utils/rest-fixtures.ts";

const TABLE = "record_widgets";
const table = makeIdNameTable(TABLE);

const widgetRecord = (
  overrides: Partial<RecordSpec<IdNameRow, IdNameInput>> = {},
) =>
  defineRecord<IdNameRow, IdNameInput>({
    activityName: "Widget",
    getAll: () => table.read.many({}),
    list: "holidays",
    logName: (input) => input.name,
    nameOf: (row) => row.name,
    rule: (input) =>
      input.name === ""
        ? errorResult("A widget needs a name")
        : okResult(input),
    table,
    ...overrides,
  });

const storedWidgets = async (): Promise<IdNameRow[]> =>
  table.read.many({}, { order: "id ASC" });

const createWidget = async (name: string): Promise<IdNameRow> => {
  const created = await widgetRecord().create({ name });
  if (created.kind !== "written") throw new Error("create failed");
  return created.row;
};

describeWithEnv("the admin record write path", { db: true }, () => {
  beforeEach(async () => {
    await getDb().execute(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
    );
  });

  test("create writes the row and its activity line", async () => {
    const created = await createWidget("Alpha");

    expect(created).toEqual({ id: 1, name: "Alpha" });
    expect(await wasActivityLogged("Widget 'Alpha' created")).toBe(true);
  });

  test("a refused rule writes no row and no activity line", async () => {
    const verdict = await widgetRecord().create({ name: "" });

    expect(verdict).toEqual({
      kind: "refused",
      message: "A widget needs a name",
    });
    expect(await storedWidgets()).toEqual([]);
    expect(await wasActivityLogged("Widget '' created")).toBe(false);
  });

  test("update hands the stored row to the rule and stores its answer", async () => {
    const created = await createWidget("Old");
    const record = widgetRecord({
      rule: (input, stored) =>
        okResult({
          name: stored?.name === "Old" ? `${input.name}!` : input.name,
        }),
    });

    const updated = await record.update(created.id, { name: "New" });

    expect(updated).toMatchObject({ kind: "written" });
    expect(await storedWidgets()).toEqual([{ id: 1, name: "New!" }]);
    expect(await wasActivityLogged("Widget 'New!' updated")).toBe(true);
  });

  test("an update of a missing row answers not-found", async () => {
    const verdict = await widgetRecord().update(999, { name: "Gone" });

    expect(verdict).toEqual({ kind: "not-found" });
    expect(await storedWidgets()).toEqual([]);
  });

  test("a delete refusal keeps the row and logs nothing", async () => {
    const created = await createWidget("Keep");
    const record = widgetRecord({
      deleteRefusal: () => Promise.resolve("Cannot delete this one"),
    });

    const verdict = await record.remove(created.id);

    expect(verdict).toEqual({
      kind: "refused",
      message: "Cannot delete this one",
    });
    expect(await storedWidgets()).toEqual([{ id: 1, name: "Keep" }]);
    expect(await wasActivityLogged("Widget 'Keep' deleted")).toBe(false);
  });

  test("delete removes the row and writes its activity line", async () => {
    const created = await createWidget("Bye");
    const record = widgetRecord();

    expect(await record.remove(created.id)).toEqual({ kind: "deleted" });
    expect(await storedWidgets()).toEqual([]);
    expect(await wasActivityLogged("Widget 'Bye' deleted")).toBe(true);
    expect(await record.remove(created.id)).toEqual({ kind: "not-found" });
  });

  test("a plan refusal writes nothing", async () => {
    const record = widgetRecord();

    const verdict = await record.create(
      { name: "Side effect" },
      { prepare: () => Promise.resolve({ error: "No side data" }) },
    );

    expect(verdict).toEqual({ kind: "refused", message: "No side data" });
    expect(await storedWidgets()).toEqual([]);
  });

  test("a failed join write rolls the row and the log back", async () => {
    const record = widgetRecord();

    const verdict = await record.create(
      { name: "Rolled back" },
      {
        persist: () => {
          throw new TransactionValidationError("Join failed");
        },
      },
    );

    expect(verdict).toEqual({ kind: "refused", message: "Join failed" });
    expect(await storedWidgets()).toEqual([]);
    expect(await wasActivityLogged("Widget 'Rolled back' created")).toBe(false);
  });

  test("a failed order append rolls the row back", async () => {
    const record = widgetRecord({
      order: {
        append: () => {
          throw new TransactionValidationError("Order failed");
        },
      },
    });

    const verdict = await record.create({ name: "Unordered" });

    expect(verdict).toEqual({ kind: "refused", message: "Order failed" });
    expect(await storedWidgets()).toEqual([]);
  });
});

describe("the record surface law", () => {
  type DeclaredRecord = {
    api?: AdminApiResource;
    deleteDestination?: AdminDestinationId;
    list: AdminDestinationId;
  };

  const API_RECORDS: readonly DeclaredRecord[] = [
    attributeRecord,
    externalSourceRecord,
    groupRecord,
    holidayRecord,
    imageRecord,
    listingRecord,
    questionRecord,
    sitePageRecord,
    statusRecord,
  ];

  test("every JSON record derives its audiences from its page routes", () => {
    for (const record of API_RECORDS) {
      if (!record.api) throw new Error(`${record.list} declares no JSON entry`);
      expect(jsonAudienceFor(record.list)).toEqual(
        adminDestination(record.list).audience,
      );
      expect(deleteAudienceFor(record)).toEqual(
        // The default delete route is the collection path with `/:id/delete`.
        adminDestinationAt(
          record.deleteDestination ??
            `${adminDestination(record.list).pattern}/:id/delete`,
        ).audience,
      );
    }
  });

  test("every record names a page route the surface declares", () => {
    for (const record of API_RECORDS) {
      expect(adminDestination(record.list).pattern).toContain("/admin/");
    }
  });
});
