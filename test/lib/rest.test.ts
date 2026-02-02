import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { col, defineTable, type Table } from "#lib/db/table.ts";
import type { Field, FieldValues } from "#lib/forms.tsx";
import {
  createHandler,
  deleteHandler,
} from "#lib/rest/handlers.ts";
import { defineResource, type Resource } from "#lib/rest/resource.ts";
import {
  createTestDb,
  createTestDbWithSetup,
  errorResponse,
  expectAdminRedirect,
  expectResultError,
  expectResultNotFound,
  loginAsAdmin,
  resetDb,
  successResponse,
  testRequest,
} from "#test-utils";

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
const testFields: Field[] = [
  { name: "name", label: "Name", type: "text", required: true },
  { name: "value", label: "Value", type: "number", required: true },
];

/** Transform form values to input */
const toInput = (values: FieldValues): TestInput => ({
  name: values.name as string,
  value: values.value as number,
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
const createTestResource = (withNameField = false): Resource<TestRow, TestInput> => {
  const table = createTestTable();
  const opts = withNameField
    ? { table, fields: testFields, toInput, nameField: "name" as const }
    : { table, fields: testFields, toInput };
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
  const row = await resource.table.findById(id);
  exists ? expect(row).not.toBeNull() : expect(row).toBeNull();
};

/** Shorthand for deleted row check */
const expectDeleted = (r: Resource<TestRow, TestInput>, id: number) => expectRowExists(r, id, false);

/** Shorthand for existing row check */
const expectExists = (r: Resource<TestRow, TestInput>, id: number) => expectRowExists(r, id, true);

/** Common test row data for update tests */
const originalRowData = { name: "Original", value: 50 } as const;

/** Common test row data for important item tests */
const importantItemData = { name: "Important Item", value: 10 } as const;

/** Create test_items table in the current database */
const createTestItemsTable = async () => {
  const { getDb } = await import("#lib/db/client.ts");
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
    test("creates resource with table, fields, and methods", () => {
      const resource = createTestResource();

      expect(resource.table).toBeDefined();
      expect(resource.fields).toBe(testFields);
      expect(typeof resource.parseInput).toBe("function");
      expect(typeof resource.parsePartialInput).toBe("function");
      expect(typeof resource.create).toBe("function");
      expect(typeof resource.update).toBe("function");
      expect(typeof resource.delete).toBe("function");
    });

    test("creates resource with verifyName when nameField provided", () => {
      const resource = createTestResource(true);
      expect(typeof resource.verifyName).toBe("function");
    });

    test("does not create verifyName without nameField", () => {
      const resource = createTestResource();
      expect(resource.verifyName).toBeUndefined();
    });
  });

  describe("parseInput", () => {
    test("parses valid form data into Input", async () => {
      const resource = createTestResource();
      const form = new URLSearchParams({ name: "Test", value: "42" });
      const result = await resource.parseInput(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input).toEqual({ name: "Test", value: 42 });
      }
    });

    test("returns error for missing required field", async () => {
      const resource = createTestResource();
      const result = await resource.parseInput(new URLSearchParams({ name: "Test" }));
      expectResultError("Value is required")(result);
    });

    test("returns error for empty required field", async () => {
      const resource = createTestResource();
      const result = await resource.parseInput(new URLSearchParams({ name: "", value: "42" }));
      expectResultError("Name is required")(result);
    });
  });

  describe("parsePartialInput", () => {
    test("parses only provided fields", async () => {
      const resource = createTestResource();
      // Only provide name, value not present in form
      const form = new URLSearchParams({ name: "Updated" });
      const result = await resource.parsePartialInput(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // value is undefined because it wasn't in the form and toInput doesn't set a default
        expect(result.input.name).toBe("Updated");
      }
    });

    test("validates provided fields", async () => {
      const resource = createTestResource();
      // Provide name but it's empty (should fail validation)
      const form = new URLSearchParams({ name: "" });
      const result = await resource.parsePartialInput(form);

      expect(result.ok).toBe(false);
    });
  });

  describe("create", () => {
    test("creates row from valid form data", async () => {
      const resource = createTestResource();
      const form = new URLSearchParams({ name: "New Item", value: "100" });
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
      const result = await resource.create(new URLSearchParams({ name: "Item" }));
      expectResultError("Value is required")(result);
    });

    test("returns error when custom validate rejects on create", async () => {
      const table = createTestTable();
      const resource = defineResource({
        table,
        fields: testFields,
        toInput,
        validate: () => Promise.resolve("Name already taken"),
      });
      const result = await resource.create(new URLSearchParams({ name: "Dup", value: "1" }));
      expectResultError("Name already taken")(result);
    });

    test("succeeds when custom validate passes on create", async () => {
      const table = createTestTable();
      const resource = defineResource({
        table,
        fields: testFields,
        toInput,
        validate: () => Promise.resolve(null),
      });
      const result = await resource.create(new URLSearchParams({ name: "Ok", value: "1" }));
      expect(result.ok).toBe(true);
    });
  });

  describe("update", () => {
    test("updates existing row", async () => {
      const resource = await insertRow(createTestResource(), originalRowData);
      const result = await resource.update(1, new URLSearchParams({ name: "Updated", value: "200" }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.row).toMatchObject({ name: "Updated", value: 200 });
    });

    test("returns notFound for non-existent row", async () => {
      expectResultNotFound(await createTestResource().update(999, new URLSearchParams({ name: "Updated", value: "200" })));
    });

    test("returns error for invalid form data", async () => {
      const resource = await insertRow(createTestResource(), originalRowData);
      expectResultError("Name is required")(await resource.update(1, new URLSearchParams({ name: "" })));
    });
  });

  describe("delete", () => {
    test("deletes existing row", async () => {
      const resource = await insertRow(createTestResource(), { name: "To Delete", value: 10 });
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

describe("rest/handlers", () => {
  beforeEach(async () => {
    await createTestDbWithSetup();
    await createTestItemsTable();
  });

  afterEach(() => {
    resetDb();
  });

  /** Create authenticated request with session and CSRF */
  const createAuthRequest = async (
    path: string,
    data: Record<string, string>,
  ): Promise<Request> => {
    const { cookie, csrfToken } = await loginAsAdmin();
    const sessionToken = cookie.match(/__Host-session=([^;]+)/)?.[1] ?? "";
    return testRequest(path, sessionToken, { data: { ...data, csrf_token: csrfToken } });
  };

  /** Create unauthenticated request */
  const createUnauthRequest = (
    path: string,
    data: Record<string, string>,
  ): Request =>
    testRequest(path, null, { data });

  describe("createHandler", () => {
    test("creates row and calls onSuccess", async () => {
      const resource = createTestResource();
      let capturedRow: unknown = null;
      const handler = createHandler(resource, {
        onSuccess: (row) => { capturedRow = row; return new Response("Created", { status: 201 }); },
        onError: errorResponse(400),
      });

      const request = await createAuthRequest("/items", { name: "New Item", value: "42" });
      const response = await handler(request);

      expect(response.status).toBe(201);
      const successRow = capturedRow as TestRow;
      expect(successRow.name).toBe("New Item");
      expect(successRow.value).toBe(42);
    });

    test("calls onError for validation failure", async () => {
      const resource = createTestResource();
      let errorMessage = "";
      const handler = createHandler(resource, {
        onSuccess: successResponse(201, "Created"),
        onError: (error) => { errorMessage = error; return new Response(error, { status: 400 }); },
      });

      const request = await createAuthRequest("/items", { name: "Item" }); // missing value
      const response = await handler(request);

      expect(response.status).toBe(400);
      expect(errorMessage).toBe("Value is required");
    });

    test("redirects for unauthenticated request", async () => {
      const handler = createHandler(createTestResource(), { onSuccess: successResponse(201, "Created"), onError: errorResponse(400) });
      expectAdminRedirect(await handler(createUnauthRequest("/items", { name: "Item", value: "42" })));
    });
  });

  describe("deleteHandler", () => {
    /** Standard delete handler options */
    const deleteOpts = () => ({
      onSuccess: successResponse(204),
      onNotFound: successResponse(404, "Not Found"),
    });

    /** Delete handler options with name verification */
    const deleteOptsWithVerify = () => ({
      ...deleteOpts(),
      onVerifyFailed: () => new Response("Name mismatch", { status: 400 }),
    });

    test("deletes row and calls onSuccess", async () => {
      const resource = await insertRow(createTestResource(), { name: "To Delete", value: 10 });
      const handler = deleteHandler(resource, deleteOpts());
      const response = await handler(await createAuthRequest("/items/1?verify_name=false", {}), 1);
      expect(response.status).toBe(204);
      await expectDeleted(resource, 1);
    });

    test("calls onNotFound for non-existent row", async () => {
      const handler = deleteHandler(createTestResource(), deleteOpts());
      const response = await handler(await createAuthRequest("/items/999?verify_name=false", {}), 999);
      expect(response.status).toBe(404);
    });

    test("redirects for unauthenticated request", async () => {
      const handler = deleteHandler(createTestResource(), deleteOpts());
      expectAdminRedirect(await handler(createUnauthRequest("/items/1", {}), 1));
    });

    test("verifies name when verify_name param is not false", async () => {
      const resource = await insertRow(createTestResource(true), importantItemData);
      let verifyFailedId: unknown = null;
      const handler = deleteHandler(resource, {
        ...deleteOpts(),
        onVerifyFailed: (id, _row) => { verifyFailedId = id; return new Response("Name mismatch", { status: 400 }); },
      });
      expect((await handler(await createAuthRequest("/items/1", { confirm_name: "Wrong Name" }), 1)).status).toBe(400);
      expect(verifyFailedId).toBe(1);
      await expectExists(resource, 1);
    });

    const setupDeleteWithVerify = async () => {
      const resource = await insertRow(createTestResource(true), importantItemData);
      return { resource, handler: deleteHandler(resource, deleteOptsWithVerify()) };
    };

    test("deletes when name verification passes", async () => {
      const { resource, handler } = await setupDeleteWithVerify();
      expect((await handler(await createAuthRequest("/items/1", { confirm_name: importantItemData.name }), 1)).status).toBe(204);
      await expectDeleted(resource, 1);
    });

    test("skips name verification when verify_name=false", async () => {
      const { resource, handler } = await setupDeleteWithVerify();
      expect((await handler(await createAuthRequest("/items/1?verify_name=false", {}), 1)).status).toBe(204);
      await expectDeleted(resource, 1);
    });

    test("dispatchDelete calls onSuccess when result has no notFound property", async () => {
      // Create a resource with a custom onDelete that always succeeds
      const table = createTestTable();
      const resource = defineResource({
        table,
        fields: testFields,
        toInput,
        onDelete: async (_id) => {
          // Custom delete that does nothing (row might already be gone)
        },
      });

      // Insert a row so findById in deleteHandler succeeds
      await table.insert({ name: "Custom Delete", value: 10 });

      const handler = deleteHandler(resource, {
        onSuccess: successResponse(204),
        onNotFound: successResponse(404, "Not Found"),
      });

      const request = await createAuthRequest("/items/1?verify_name=false", {});
      const response = await handler(request, 1);
      // onDelete returns void, so delete returns { ok: true } - dispatchDelete calls onSuccess
      expect(response.status).toBe(204);
    });

    test("uses empty string fallback when confirm_name is not provided", async () => {
      const resource = await insertRow(createTestResource(true), importantItemData);
      const handler = deleteHandler(resource, {
        ...deleteOpts(),
        onVerifyFailed: (_id, _row, _session, _form) => {
          return new Response("Name mismatch", { status: 400 });
        },
      });

      // Submit without confirm_name field at all (will use ?? "" fallback)
      const request = await createAuthRequest("/items/1", {});
      const response = await handler(request, 1);
      expect(response.status).toBe(400);
      // The form won't have confirm_name, so verifyName gets ""
      await expectExists(resource, 1);
    });
  });
});

describe("rest/resource - additional coverage", () => {
  beforeEach(async () => {
    await createTestDbWithSetup();
    await createTestItemsTable();
  });

  afterEach(() => {
    resetDb();
  });

  describe("custom onDelete handler", () => {
    test("uses onDelete instead of table.deleteById when provided", async () => {
      let customDeleteCalled = false;
      let deletedId: unknown = null;

      const table = createTestTable();
      const resource = defineResource({
        table,
        fields: testFields,
        toInput,
        onDelete: async (id) => {
          customDeleteCalled = true;
          deletedId = id;
          // Custom delete logic (e.g., cascade delete related records)
          await table.deleteById(id);
        },
      });

      await table.insert({ name: "To Delete", value: 10 });

      const result = await resource.delete(1);
      expect(result.ok).toBe(true);
      expect(customDeleteCalled).toBe(true);
      expect(deletedId).toBe(1);

      // Verify row was actually deleted
      const row = await table.findById(1);
      expect(row).toBeNull();
    });
  });

});
