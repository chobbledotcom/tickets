import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { col, defineTable, type Table } from "#shared/db/table.ts";
import { FormParams } from "#shared/form-data.ts";
import { defineForm, type FormValues } from "#shared/forms/definition.ts";
import { defineResource, type Resource } from "#shared/rest/resource.ts";
import {
  expectResultError,
  expectResultNotFound,
} from "#test-utils/assertions.ts";
import { createTestDb, describeWithEnv, resetDb } from "#test-utils/db.ts";

/** Test row type */
type TestRow = {
  id: number;
  name: string;
  value: number;
};

/** Test input type */
type TestInput = {
  name: string;
  value: number;
};

/** Test fields for form validation */
const testForm = defineForm({
  fields: [
    { label: "Name", name: "name", required: true, type: "text" },
    { label: "Value", name: "value", required: true, type: "number" },
  ] as const,
});

type TestFormValues = FormValues<typeof testForm>;

/** Transform form values to input */
const toInput = (values: TestFormValues): TestInput => ({
  name: values.name,
  value: values.value,
});

/** Create test table definition */
const createTestTable = (): Table<TestRow, TestInput> =>
  defineTable<TestRow, TestInput>({
    name: "test_items",
    primaryKey: "id",
    schema: {
      id: col.generated<number>(),
      name: col.simple<string>(),
      value: col.simple<number>(),
    },
  });

/** Create test resource, optionally with name verification */
const createTestResource = (
  withNameField = false,
): Resource<TestRow, TestInput> => {
  const table = createTestTable();
  const opts = withNameField
    ? { form: testForm, nameField: "name" as const, table, toInput }
    : { form: testForm, table, toInput };
  return defineResource(opts);
};

/** Insert test row and return the resource for chaining */
const insertRow = async (
  resource: Resource<TestRow, TestInput>,
  data: TestInput,
): Promise<Resource<TestRow, TestInput>> => {
  await resource.table.insert(data);
  return resource;
};

/** Assert row deletion status */
const expectRowExists = async (
  resource: Resource<TestRow, TestInput>,
  id: number,
  exists: boolean,
): Promise<void> => {
  const row = await resource.table.read.one({ id: id });
  exists ? expect(row).not.toBeNull() : expect(row).toBeNull();
};

/** Shorthand for deleted row check */
const expectDeleted = (r: Resource<TestRow, TestInput>, id: number) =>
  expectRowExists(r, id, false);

/** Common test row data for update tests */
const originalRowData = { name: "Original", value: 50 } as const;

/** Create test_items table in the current database */
const createTestItemsTable = async () => {
  const { getDb } = await import("#shared/db/client.ts");
  await getDb().execute(`
    CREATE TABLE IF NOT EXISTS test_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      value INTEGER NOT NULL
    )
  `);
};

describe("rest/resource", () => {
  beforeEach(async () => {
    await createTestDb();
    await createTestItemsTable();
  });

  afterEach(() => {
    resetDb();
  });

  describe("defineResource", () => {
    test("creates a working resource from table and fields", async () => {
      const resource = createTestResource();
      const result = await resource.create(
        new FormParams({ name: "Test", value: "1" }),
      );
      expect(result.ok).toBe(true);
    });

    test("supports name verification when nameField is provided", () => {
      const resource = createTestResource(true);
      const row: TestRow = { id: 1, name: "Test", value: 1 };
      expect(resource.verifyName?.(row, "Test")).toBe(true);
      expect(resource.verifyName?.(row, "Wrong")).toBe(false);
    });

    test("does not create verifyName without nameField", () => {
      const resource = createTestResource();
      expect(resource.verifyName).toBeUndefined();
    });
  });

  describe("parseInput", () => {
    test("parses valid form data into Input", async () => {
      const resource = createTestResource();
      const form = new FormParams({ name: "Test", value: "42" });
      const result = await resource.parseInput(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ name: "Test", value: 42 });
      }
    });

    test("returns error for missing required field", async () => {
      const resource = createTestResource();
      const result = await resource.parseInput(
        new FormParams({ name: "Test" }),
      );
      expectResultError("Value is required")(result);
    });

    test("returns error for empty required field", async () => {
      const resource = createTestResource();
      const result = await resource.parseInput(
        new FormParams({ name: "", value: "42" }),
      );
      expectResultError("Name is required")(result);
    });
  });

  describe("create", () => {
    test("creates row from valid form data", async () => {
      const resource = createTestResource();
      const form = new FormParams({ name: "New Item", value: "100" });
      const result = await resource.create(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.row.id).toBe(1);
        expect(result.row.name).toBe("New Item");
        expect(result.row.value).toBe(100);
      }
    });

    test("returns error for invalid form data", async () => {
      const resource = createTestResource();
      const result = await resource.create(new FormParams({ name: "Item" }));
      expectResultError("Value is required")(result);
    });

    test("returns error when custom validate rejects on create", async () => {
      const table = createTestTable();
      const resource = defineResource({
        form: testForm,
        table,
        toInput,
        validate: () => Promise.resolve("Name already taken"),
      });
      const result = await resource.create(
        new FormParams({ name: "Dup", value: "1" }),
      );
      expectResultError("Name already taken")(result);
    });

    test("succeeds when custom validate passes on create", async () => {
      const table = createTestTable();
      const resource = defineResource({
        form: testForm,
        table,
        toInput,
        validate: () => Promise.resolve(null),
      });
      const result = await resource.create(
        new FormParams({ name: "Ok", value: "1" }),
      );
      expect(result.ok).toBe(true);
    });

    // The row commits but the read-back finds nothing, so create used to report
    // `ok: true` with a null row — every caller's first field read (a listing
    // create's `result.row.name`) then died as "Cannot read properties of null",
    // a 500 far from the cause on a listing that HAD been created.
    test("throws naming the table when the committed row can't be read back", async () => {
      const table = createTestTable();
      const resource = defineResource({
        // A join write puts the create on the transactional read-back path,
        // which is where every real create (listings, groups, …) runs.
        afterWrite: () => Promise.resolve(),
        form: testForm,
        table: { ...table, findByIdPrimary: () => Promise.resolve(null) },
        toInput,
      });

      await expect(
        resource.create(new FormParams({ name: "Ghost", value: "1" })),
      ).rejects.toThrow("test_items");
    });
  });

  describe("update", () => {
    test("updates existing row", async () => {
      const resource = await insertRow(createTestResource(), originalRowData);
      const result = await resource.update(
        1,
        new FormParams({ name: "Updated", value: "200" }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.row).toMatchObject({ name: "Updated", value: 200 });
      }
    });

    test("returns notFound for non-existent row", async () => {
      expectResultNotFound(
        await createTestResource().update(
          999,
          new FormParams({ name: "Updated", value: "200" }),
        ),
      );
    });

    test("returns error for invalid form data", async () => {
      const resource = await insertRow(createTestResource(), originalRowData);
      expectResultError("Name is required")(
        await resource.update(1, new FormParams({ name: "" })),
      );
    });

    test("returns notFound when row deleted between existence check and update", async () => {
      const resource = await insertRow(createTestResource(), originalRowData);
      const origUpdate = resource.table.update;
      resource.table.update = () => Promise.resolve(null);
      try {
        const result = await resource.update(
          1,
          new FormParams({ name: "Updated", value: "200" }),
        );
        expectResultNotFound(result);
      } finally {
        resource.table.update = origUpdate;
      }
    });
  });

  describe("delete", () => {
    test("deletes existing row", async () => {
      const resource = await insertRow(createTestResource(), {
        name: "To Delete",
        value: 10,
      });
      const result = await resource.delete(1);
      expect(result.ok).toBe(true);
      await expectDeleted(resource, 1);
    });

    test("returns notFound for non-existent row", async () => {
      expectResultNotFound(await createTestResource().delete(999));
    });
  });

  describe("verifyName", () => {
    const testRow: TestRow = { id: 1, name: "Test Item", value: 10 };

    test("returns true for matching name (case insensitive)", () => {
      const resource = createTestResource(true);
      expect(resource.verifyName?.(testRow, "Test Item")).toBe(true);
      expect(resource.verifyName?.(testRow, "test item")).toBe(true);
      expect(resource.verifyName?.(testRow, "TEST ITEM")).toBe(true);
    });

    test("returns true with trimmed whitespace", () => {
      const resource = createTestResource(true);
      expect(resource.verifyName?.(testRow, "  Test Item  ")).toBe(true);
    });

    test("returns false for non-matching name", () => {
      const resource = createTestResource(true);
      expect(resource.verifyName?.(testRow, "Wrong Name")).toBe(false);
      expect(resource.verifyName?.(testRow, "")).toBe(false);
    });
  });
});

describeWithEnv("rest/resource - additional coverage", { db: true }, () => {
  beforeEach(async () => {
    await createTestItemsTable();
  });

  describe("custom onDelete handler", () => {
    test("uses onDelete instead of table.deleteById when provided", async () => {
      let customDeleteCalled = false;
      let deletedId: unknown = null;

      const table = createTestTable();
      const resource = defineResource({
        form: testForm,
        onDelete: async (id) => {
          customDeleteCalled = true;
          deletedId = id;
          // Custom delete logic (e.g., cascade delete related records)
          await table.deleteById(id);
        },
        table,
        toInput,
      });

      await table.insert({ name: "To Delete", value: 10 });

      const result = await resource.delete(1);
      expect(result.ok).toBe(true);
      expect(customDeleteCalled).toBe(true);
      expect(deletedId).toBe(1);

      // Verify row was actually deleted
      const row = await table.read.one({ id: 1 });
      expect(row).toBeNull();
    });
  });
});
