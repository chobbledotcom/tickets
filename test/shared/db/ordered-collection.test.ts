import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  execute,
  insert,
  queryAll,
  queryOne,
  withTransaction,
} from "#shared/db/client.ts";
import {
  defineOrderedCollection,
  flatCollectionSwap,
  scopedCollectionSwap,
} from "#shared/db/ordered-collection.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const statuses = defineOrderedCollection({
  key: "id",
  table: "attendee_statuses",
});
const answers = defineOrderedCollection({
  key: "id",
  scope: "question_id",
  table: "answers",
});
const oneBasedAnswers = defineOrderedCollection({
  key: "id",
  scope: "question_id",
  start: 1,
  table: "answers",
});
const pageItems = defineOrderedCollection({
  key: ["item_type", "item_id"] as const,
  scope: "page_id",
  table: "site_page_items",
});

const insertStatus = async (sortOrder: number): Promise<number> => {
  const statement = insert("attendee_statuses", {
    name: "status",
    reservation_amount: "0",
    sort_order: sortOrder,
  });
  return Number((await execute(statement.sql, statement.args)).lastInsertRowid);
};

const statusOrder = async (id: number): Promise<number> =>
  (await queryOne<{ sort_order: number }>(
    "SELECT sort_order FROM attendee_statuses WHERE id = ?",
    [id],
  ))!.sort_order;

const insertAnswer = async (
  questionId: number,
  sortOrder: number,
): Promise<number> => {
  const result = await execute(
    "INSERT INTO answers (question_id, text, sort_order, active) VALUES (?, '', ?, 1)",
    [questionId, sortOrder],
  );
  return Number(result.lastInsertRowid);
};

const insertPageItem = (
  pageId: number,
  itemType: string,
  itemId: number,
  sortOrder: number,
): Promise<unknown> =>
  execute(
    "INSERT INTO site_page_items (page_id, item_type, item_id, sort_order) VALUES (?, ?, ?, ?)",
    [pageId, itemType, itemId, sortOrder],
  );

describeWithEnv("db > ordered collection", { db: true }, () => {
  test("appends and swaps a flat scalar-key collection", async () => {
    const first = await insertStatus(4);
    const second = await insertStatus(0);

    await statuses.append({ key: second });
    expect(await statusOrder(second)).toBe(5);
    expect(await statuses.next({})).toBe(6);

    await flatCollectionSwap(statuses)(first, second);
    expect(await statusOrder(first)).toBe(5);
    expect(await statusOrder(second)).toBe(4);
  });

  test("computes and appends order inside one scope", async () => {
    await insertAnswer(10, 2);
    const appended = await insertAnswer(10, 0);
    await insertAnswer(20, 99);

    expect(
      await answers.nextMany({ items: [{ scope: 10 }, { scope: 20 }] }),
    ).toEqual([3, 100]);
    await answers.append({ key: appended, scope: 10 });

    const rows = await queryAll<{ sort_order: number }>(
      "SELECT sort_order FROM answers WHERE question_id = ? ORDER BY sort_order",
      [10],
    );
    expect(rows.map((row) => row.sort_order)).toEqual([2, 3]);
  });

  test("starts an empty default collection at zero", async () => {
    const appended = await insertAnswer(30, 0);

    expect(await answers.next({ scope: 40 })).toBe(0);
    await answers.append({ key: appended, scope: 30 });
    expect(
      await queryOne<{ sort_order: number }>(
        "SELECT sort_order FROM answers WHERE id = ?",
        [appended],
      ),
    ).toEqual({ sort_order: 0 });
  });

  test("uses the collection's starting order when its scope is empty", async () => {
    const appended = await insertAnswer(30, 0);

    expect(await oneBasedAnswers.next({ scope: 40 })).toBe(1);
    await oneBasedAnswers.append({ key: appended, scope: 30 });
    expect(
      await queryOne<{ sort_order: number }>(
        "SELECT sort_order FROM answers WHERE id = ?",
        [appended],
      ),
    ).toEqual({ sort_order: 1 });
  });

  test("swaps composite keys without changing the same id in another scope", async () => {
    await insertPageItem(1, "listing", 7, 10);
    await insertPageItem(1, "group", 7, 20);
    await insertPageItem(2, "listing", 7, 30);

    await scopedCollectionSwap(pageItems, (pageId: number) => pageId)(
      ["listing", 7],
      ["group", 7],
      1,
    );

    const rows = await queryAll<{
      item_type: string;
      page_id: number;
      sort_order: number;
    }>(
      "SELECT page_id, item_type, sort_order FROM site_page_items ORDER BY page_id, item_type",
    );
    expect(rows).toEqual([
      { item_type: "group", page_id: 1, sort_order: 10 },
      { item_type: "listing", page_id: 1, sort_order: 20 },
      { item_type: "listing", page_id: 2, sort_order: 30 },
    ]);
  });

  test("appends a composite key after every different sibling", async () => {
    await insertPageItem(3, "listing", 8, 4);
    await insertPageItem(3, "group", 7, 5);
    await insertPageItem(3, "listing", 7, 0);

    await pageItems.append({ key: ["listing", 7], scope: 3 });

    expect(
      await queryOne<{ sort_order: number }>(
        "SELECT sort_order FROM site_page_items WHERE page_id = ? AND item_type = ? AND item_id = ?",
        [3, "listing", 7],
      ),
    ).toEqual({ sort_order: 6 });
  });

  test("does not swap across scopes or when a row is stale", async () => {
    const first = await insertAnswer(1, 10);
    const otherScope = await insertAnswer(2, 20);

    await answers.swap({ first, scope: 1, second: otherScope });
    await answers.swap({ first, scope: 1, second: 999_999 });
    await answers.swap({ first, scope: 1, second: first });

    expect(
      await queryAll<{ id: number; sort_order: number }>(
        "SELECT id, sort_order FROM answers ORDER BY id",
      ),
    ).toEqual([
      { id: first, sort_order: 10 },
      { id: otherScope, sort_order: 20 },
    ]);
  });

  test("uses a caller-owned transaction for next order and append", async () => {
    const first = await insertStatus(8);
    const second = await withTransaction(async (transaction) => {
      const result = await transaction.execute({
        args: ["transaction", "0", 0],
        sql: "INSERT INTO attendee_statuses (name, reservation_amount, sort_order) VALUES (?, ?, ?)",
      });
      const id = Number(result.lastInsertRowid);
      expect(await statuses.next({ transaction })).toBe(9);
      await statuses.append({ key: id, transaction });
      await statuses.swap({ first, second: id, transaction });
      return id;
    });

    expect(await statusOrder(first)).toBe(9);
    expect(await statusOrder(second)).toBe(8);
  });
});
