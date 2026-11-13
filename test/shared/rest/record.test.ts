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
  type RecordShapeOf,
  type RecordSpec,
  recordPageIds,
  recordSurfaceOf,
} from "#shared/rest/record.ts";
import {
  contentCommands,
  deleteIfPresent,
  writeAndLog,
} from "#shared/rest/record-command.ts";
import { errorResult, okResult } from "#shared/result.ts";
import {
  getAllActivityLog,
  wasActivityLogged,
} from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  type IdNameInput,
  type IdNameRow,
  makeIdNameTable,
} from "#test-utils/rest-fixtures.ts";

const TABLE = "record_widgets";
const table = makeIdNameTable(TABLE);

const widgetRecord = (
  overrides: Partial<RecordSpec<RecordShapeOf<IdNameRow, IdNameInput>>> = {},
) =>
  defineRecord<RecordShapeOf<IdNameRow, IdNameInput>>({
    activityName: "Widget",
    getAll: () => table.read.many({}),
    logName: (input) => input.name,
    nameOf: (row) => row.name,
    rule: (input) =>
      input.name === ""
        ? errorResult("A widget needs a name")
        : okResult(input),
    surface: "holidays",
    table,
    ...overrides,
  });

const storedWidgets = async (): Promise<IdNameRow[]> =>
  table.read.many({}, { order: "id ASC" });

const createWidget = async (
  name: string,
  record = widgetRecord(),
): Promise<IdNameRow> => {
  const created = await record.create({ name });
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

  test("a write with no join steps takes the plain table path", async () => {
    const record = widgetRecord({ logAfterCommit: true });

    const created = await createWidget("Plain", record);
    expect(created).toEqual({ id: 1, name: "Plain" });

    const updated = await record.update(created.id, { name: "Plainer" });
    expect(updated).toEqual({
      kind: "written",
      row: { id: 1, name: "Plainer" },
    });
    expect(await storedWidgets()).toEqual([{ id: 1, name: "Plainer" }]);
  });

  test("a linked write names its row on every activity line", async () => {
    const record = widgetRecord({ linkActivityToRow: true });

    expect(await createWidget("Linked", record)).toEqual({
      id: 1,
      name: "Linked",
    });
    expect(
      (await getAllActivityLog()).map((entry) => [
        entry.listing_id,
        entry.message,
      ]),
    ).toEqual([[1, "Widget 'Linked' created"]]);

    expect(await record.remove(1)).toEqual({ kind: "deleted" });
    expect(
      (await getAllActivityLog()).map((entry) => [
        entry.listing_id,
        entry.message,
      ]),
    ).toEqual([
      [1, "Widget 'Linked' deleted"],
      [1, "Widget 'Linked' created"],
    ]);
  });

  test("a table record loads through the replica and the primary", async () => {
    const created = await createWidget("Defaults");
    const record = widgetRecord();

    expect(await record.load(created.id)).toEqual(created);
    expect(await record.loadAfterWrite(created.id)).toEqual(created);
    expect(await record.load(999)).toBeNull();
  });

  test("a content update needs no not-found error of its own", async () => {
    const saved: [number, IdNameInput][] = [];
    const commands = contentCommands<IdNameRow, IdNameInput, "missing">({
      create: () => Promise.resolve(okResult({ id: 2, name: "New" })),
      load: (id) =>
        Promise.resolve(id === 1 ? { id: 1, name: "Stored" } : null),
      log: () => Promise.resolve(),
      message: () => "refused",
      remove: () => Promise.resolve(),
      rule: (input) => okResult(input),
      update: (id, input) => {
        saved.push([id, input]);
        return Promise.resolve(okResult({ id, name: input.name }));
      },
      updateInput: (input) => input,
    });

    const verdict = await commands.update(1, { name: "Renamed" });

    expect(verdict).toEqual({
      kind: "written",
      row: { id: 1, name: "Renamed" },
    });
    expect(saved).toEqual([[1, { name: "Renamed" }]]);
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

describe("the record read defaults", () => {
  type Widget = RecordShapeOf<IdNameRow, IdNameInput>;
  const bareRecord = (spec: Partial<RecordSpec<Widget>> = {}) =>
    defineRecord<Widget>({
      activityName: "Widget",
      logName: (input) => input.name,
      nameOf: (row) => row.name,
      rule: (input) => okResult(input),
      surface: "holidays",
      ...spec,
    });

  test("a record with no declared read refuses the read it cannot serve", () => {
    const record = bareRecord();

    expect(() => record.getAll()).toThrow(
      "The record for holidays declares no collection read",
    );
    expect(() => record.load(1)).toThrow(
      "The record for holidays declares no load read",
    );
  });

  test("a read bundle serves both reads and the write read-back", async () => {
    const row: IdNameRow = { id: 3, name: "Bundled" };
    const record = bareRecord({
      reads: {
        all: () => Promise.resolve([row]),
        one: () => Promise.resolve(row),
      },
    });

    expect(await record.getAll()).toEqual([row]);
    expect(await record.load(3)).toEqual(row);
    expect(await record.loadAfterWrite(3)).toEqual(row);
  });

  test("a record with no table refuses every generated write", async () => {
    const record = bareRecord({
      getAll: () => Promise.resolve([]),
      load: (id) =>
        Promise.resolve(id === 1 ? { id: 1, name: "Loaded" } : null),
    });

    expect(() => record.create({ name: "Orphan" })).toThrow(
      "The record for holidays declares no table",
    );
    await expect(record.update(1, { name: "Orphan" })).rejects.toThrow(
      "The record for holidays declares no table",
    );
    expect(await record.remove(2)).toEqual({ kind: "not-found" });
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

  test("a record in a record area takes its route ids from the area", () => {
    expect(recordSurfaceOf("settingsStatuses")).toEqual({
      deleteDestination: "statusDelete",
      detail: "status",
      list: "statuses",
    });
    expect(recordPageIds(statusRecord)).toEqual({
      deleteDestination: "statusDelete",
      destination: "status",
    });
  });

  test("a record outside a record area names its own routes and has no record page", () => {
    const named = { deleteDestination: "imageDelete", list: "images" } as const;
    expect(recordSurfaceOf(named)).toBe(named);
    expect(() => recordPageIds(imageRecord)).toThrow(
      "The record for images declares no record page",
    );
  });

  test("a record with no delete route takes the collection's delete audience", () => {
    expect(deleteAudienceFor({ list: "images" })).toEqual([
      "owner",
      "manager",
      "editor",
    ]);
  });

  test("every record names a page route the surface declares", () => {
    for (const record of API_RECORDS) {
      expect(adminDestination(record.list).pattern).toContain("/admin/");
    }
  });
});

describe("the command write answers", () => {
  test("answers the written row and logs it", async () => {
    const logged: number[] = [];
    const verdict = await writeAndLog({
      log: (row: { id: number }) => {
        logged.push(row.id);
        return Promise.resolve();
      },
      message: () => "refused",
      write: () => Promise.resolve(okResult({ id: 4 })),
    });
    expect(verdict).toEqual({ kind: "written", row: { id: 4 } });
    expect(logged).toEqual([4]);
  });

  test("answers the not-found error as not found", async () => {
    const verdict = await writeAndLog({
      log: () => Promise.resolve(),
      message: () => "refused",
      notFound: "notFound",
      write: () => Promise.resolve(errorResult("notFound")),
    });
    expect(verdict).toEqual({ kind: "not-found" });
  });

  test("answers another domain error with its message", async () => {
    const verdict = await writeAndLog({
      log: () => Promise.resolve(),
      message: () => "That name is taken",
      write: () => Promise.resolve(errorResult("slugTaken")),
    });
    expect(verdict).toEqual({
      kind: "refused",
      message: "That name is taken",
    });
  });

  test("deletes a present row and skips an absent log", async () => {
    const removed: number[] = [];
    const verdict = await deleteIfPresent(7, {
      destroy: (row: { id: number }) => {
        removed.push(row.id);
        return Promise.resolve();
      },
      load: () => Promise.resolve({ id: 7 }),
    });
    expect(verdict).toEqual({ kind: "deleted" });
    expect(removed).toEqual([7]);
  });

  test("answers not found for an absent row", async () => {
    const verdict = await deleteIfPresent(7, {
      destroy: () => Promise.reject(new Error("must not run")),
      load: () => Promise.resolve(null),
    });
    expect(verdict).toEqual({ kind: "not-found" });
  });
});
