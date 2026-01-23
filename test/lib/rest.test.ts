import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { setDb } from "#lib/db/client";
import { initDb } from "#lib/db/migrations";
import { createSession } from "#lib/db/sessions";
import { col, defineTable, type Table } from "#lib/db/table.ts";
import type { Field, FieldValues } from "#lib/forms.tsx";
import {
  createHandler,
  deleteHandler,
  updateHandler,
} from "#lib/rest/handlers";
import { defineResource } from "#lib/rest/resource";
import {
  createTestDbWithSetup,
  resetDb,
  setupTestEncryptionKey,
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

describe("rest/resource", () => {
  beforeEach(async () => {
    setupTestEncryptionKey();
    const client = createClient({ url: ":memory:" });
    setDb(client);
    await initDb();
    // Create test table
    const db = client;
    await db.execute(`
      CREATE TABLE IF NOT EXISTS test_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value INTEGER NOT NULL
      )
    `);
  });

  afterEach(() => {
    resetDb();
  });

  describe("defineResource", () => {
    test("creates resource with table, fields, and methods", () => {
      const table = createTestTable();
      const resource = defineResource({
        table,
        fields: testFields,
        toInput,
      });

      expect(resource.table).toBe(table);
      expect(resource.fields).toBe(testFields);
      expect(typeof resource.parseInput).toBe("function");
      expect(typeof resource.parsePartialInput).toBe("function");
      expect(typeof resource.create).toBe("function");
      expect(typeof resource.update).toBe("function");
      expect(typeof resource.delete).toBe("function");
    });

    test("creates resource with verifyName when nameField provided", () => {
      const table = createTestTable();
      const resource = defineResource({
        table,
        fields: testFields,
        toInput,
        nameField: "name",
      });

      expect(typeof resource.verifyName).toBe("function");
    });

    test("does not create verifyName without nameField", () => {
      const table = createTestTable();
      const resource = defineResource({
        table,
        fields: testFields,
        toInput,
      });

      expect(resource.verifyName).toBeUndefined();
    });
  });

  describe("parseInput", () => {
    test("parses valid form data into Input", () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      const form = new URLSearchParams({ name: "Test", value: "42" });
      const result = resource.parseInput(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input).toEqual({ name: "Test", value: 42 });
      }
    });

    test("returns error for missing required field", () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      const form = new URLSearchParams({ name: "Test" }); // missing value
      const result = resource.parseInput(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Value is required");
      }
    });

    test("returns error for empty required field", () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      const form = new URLSearchParams({ name: "", value: "42" });
      const result = resource.parseInput(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Name is required");
      }
    });
  });

  describe("parsePartialInput", () => {
    test("parses only provided fields", () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      // Only provide name, value not present in form
      const form = new URLSearchParams({ name: "Updated" });
      const result = resource.parsePartialInput(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // value is undefined because it wasn't in the form and toInput doesn't set a default
        expect(result.input.name).toBe("Updated");
      }
    });

    test("validates provided fields", () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      // Provide name but it's empty (should fail validation)
      const form = new URLSearchParams({ name: "" });
      const result = resource.parsePartialInput(form);

      expect(result.ok).toBe(false);
    });
  });

  describe("create", () => {
    test("creates row from valid form data", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

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
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      const form = new URLSearchParams({ name: "Item" }); // missing value
      const result = await resource.create(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Value is required");
      }
    });
  });

  describe("update", () => {
    test("updates existing row", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      // Create a row first
      await table.insert({ name: "Original", value: 50 });

      const form = new URLSearchParams({ name: "Updated", value: "200" });
      const result = await resource.update(1, form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.row.name).toBe("Updated");
        expect(result.row.value).toBe(200);
      }
    });

    test("returns notFound for non-existent row", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      const form = new URLSearchParams({ name: "Updated", value: "200" });
      const result = await resource.update(999, form);

      expect(result.ok).toBe(false);
      expect("notFound" in result && result.notFound).toBe(true);
    });

    test("returns error for invalid form data", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      // Create a row first
      await table.insert({ name: "Original", value: 50 });

      const form = new URLSearchParams({ name: "" }); // empty required field
      const result = await resource.update(1, form);

      expect(result.ok).toBe(false);
      if (!result.ok && "error" in result) {
        expect(result.error).toBe("Name is required");
      }
    });
  });

  describe("delete", () => {
    test("deletes existing row", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      // Create a row first
      await table.insert({ name: "To Delete", value: 10 });

      const result = await resource.delete(1);

      expect(result.ok).toBe(true);

      // Verify deletion
      const row = await table.findById(1);
      expect(row).toBeNull();
    });

    test("returns notFound for non-existent row", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      const result = await resource.delete(999);

      expect(result.ok).toBe(false);
      expect("notFound" in result && result.notFound).toBe(true);
    });
  });

  describe("verifyName", () => {
    test("returns true for matching name (case insensitive)", () => {
      const table = createTestTable();
      const resource = defineResource({
        table,
        fields: testFields,
        toInput,
        nameField: "name",
      });

      const row: TestRow = { id: 1, name: "Test Item", value: 10 };

      expect(resource.verifyName?.(row, "Test Item")).toBe(true);
      expect(resource.verifyName?.(row, "test item")).toBe(true);
      expect(resource.verifyName?.(row, "TEST ITEM")).toBe(true);
    });

    test("returns true with trimmed whitespace", () => {
      const table = createTestTable();
      const resource = defineResource({
        table,
        fields: testFields,
        toInput,
        nameField: "name",
      });

      const row: TestRow = { id: 1, name: "Test Item", value: 10 };

      expect(resource.verifyName?.(row, "  Test Item  ")).toBe(true);
    });

    test("returns false for non-matching name", () => {
      const table = createTestTable();
      const resource = defineResource({
        table,
        fields: testFields,
        toInput,
        nameField: "name",
      });

      const row: TestRow = { id: 1, name: "Test Item", value: 10 };

      expect(resource.verifyName?.(row, "Wrong Name")).toBe(false);
      expect(resource.verifyName?.(row, "")).toBe(false);
    });
  });
});

describe("rest/handlers", () => {
  beforeEach(async () => {
    await createTestDbWithSetup();
    // Create test table
    const { getDb } = await import("#lib/db/client.ts");
    await getDb().execute(`
      CREATE TABLE IF NOT EXISTS test_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value INTEGER NOT NULL
      )
    `);
  });

  afterEach(() => {
    resetDb();
  });

  /** Create authenticated request with session and CSRF */
  const createAuthRequest = async (
    path: string,
    method: string,
    data: Record<string, string>,
  ): Promise<Request> => {
    const csrfToken = "test-csrf-token";
    await createSession("test-session", csrfToken, Date.now() + 60000);

    const body = new URLSearchParams({ ...data, csrf_token: csrfToken });
    return new Request(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "__Host-session=test-session",
        origin: "http://localhost",
      },
      body: body.toString(),
    });
  };

  /** Create unauthenticated request */
  const createUnauthRequest = (
    path: string,
    method: string,
    data: Record<string, string>,
  ): Request => {
    const body = new URLSearchParams(data);
    return new Request(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
      },
      body: body.toString(),
    });
  };

  describe("createHandler", () => {
    test("creates row and calls onSuccess", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      let capturedRow: unknown = null;
      const handler = createHandler(resource, {
        onSuccess: (row) => {
          capturedRow = row;
          return new Response("Created", { status: 201 });
        },
        onError: (error) => new Response(error, { status: 400 }),
      });

      const request = await createAuthRequest("/items", "POST", {
        name: "New Item",
        value: "42",
      });
      const response = await handler(request);

      expect(response.status).toBe(201);
      const successRow = capturedRow as TestRow;
      expect(successRow.name).toBe("New Item");
      expect(successRow.value).toBe(42);
    });

    test("calls onError for validation failure", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      let errorMessage = "";
      const handler = createHandler(resource, {
        onSuccess: () => new Response("Created", { status: 201 }),
        onError: (error) => {
          errorMessage = error;
          return new Response(error, { status: 400 });
        },
      });

      const request = await createAuthRequest("/items", "POST", {
        name: "Item",
        // missing value
      });
      const response = await handler(request);

      expect(response.status).toBe(400);
      expect(errorMessage).toBe("Value is required");
    });

    test("redirects for unauthenticated request", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      const handler = createHandler(resource, {
        onSuccess: () => new Response("Created", { status: 201 }),
        onError: () => new Response("Error", { status: 400 }),
      });

      const request = createUnauthRequest("/items", "POST", {
        name: "Item",
        value: "42",
      });
      const response = await handler(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");
    });
  });

  describe("updateHandler", () => {
    test("updates row and calls onSuccess", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      // Create initial row
      await table.insert({ name: "Original", value: 10 });

      let capturedRow: unknown = null;
      const handler = updateHandler(resource, {
        onSuccess: (row) => {
          capturedRow = row;
          return new Response("Updated", { status: 200 });
        },
        onError: (_id, error) => new Response(error, { status: 400 }),
        onNotFound: () => new Response("Not Found", { status: 404 }),
      });

      const request = await createAuthRequest("/items/1", "PUT", {
        name: "Updated",
        value: "99",
      });
      const response = await handler(request, 1);

      expect(response.status).toBe(200);
      const updatedRow = capturedRow as TestRow;
      expect(updatedRow.name).toBe("Updated");
      expect(updatedRow.value).toBe(99);
    });

    test("calls onNotFound for non-existent row", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      const handler = updateHandler(resource, {
        onSuccess: () => new Response("Updated", { status: 200 }),
        onError: () => new Response("Error", { status: 400 }),
        onNotFound: () => new Response("Not Found", { status: 404 }),
      });

      const request = await createAuthRequest("/items/999", "PUT", {
        name: "Updated",
        value: "99",
      });
      const response = await handler(request, 999);

      expect(response.status).toBe(404);
    });

    test("calls onError with id for validation failure", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      // Create initial row
      await table.insert({ name: "Original", value: 10 });

      let capturedId: unknown = null;
      let errorMessage = "";
      const handler = updateHandler(resource, {
        onSuccess: () => new Response("Updated", { status: 200 }),
        onError: (id, error) => {
          capturedId = id;
          errorMessage = error;
          return new Response(error, { status: 400 });
        },
        onNotFound: () => new Response("Not Found", { status: 404 }),
      });

      const request = await createAuthRequest("/items/1", "PUT", {
        name: "Updated",
        // missing value
      });
      const response = await handler(request, 1);

      expect(response.status).toBe(400);
      expect(capturedId).toBe(1);
      expect(errorMessage).toBe("Value is required");
    });

    test("redirects for unauthenticated request", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      const handler = updateHandler(resource, {
        onSuccess: () => new Response("Updated", { status: 200 }),
        onError: () => new Response("Error", { status: 400 }),
        onNotFound: () => new Response("Not Found", { status: 404 }),
      });

      const request = createUnauthRequest("/items/1", "PUT", {
        name: "Updated",
        value: "99",
      });
      const response = await handler(request, 1);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");
    });
  });

  describe("deleteHandler", () => {
    test("deletes row and calls onSuccess", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      // Create initial row
      await table.insert({ name: "To Delete", value: 10 });

      const handler = deleteHandler(resource, {
        onSuccess: () => new Response(null, { status: 204 }),
        onNotFound: () => new Response("Not Found", { status: 404 }),
      });

      const request = await createAuthRequest(
        "/items/1?verify_name=false",
        "DELETE",
        {},
      );
      const response = await handler(request, 1);

      expect(response.status).toBe(204);

      // Verify deletion
      const row = await table.findById(1);
      expect(row).toBeNull();
    });

    test("calls onNotFound for non-existent row", async () => {
      const table = createTestTable();
      const resource = defineResource({ table, fields: testFields, toInput });

      const handler = deleteHandler(resource, {
        onSuccess: () => new Response(null, { status: 204 }),
        onNotFound: () => new Response("Not Found", { status: 404 }),
      });

      const request = await createAuthRequest(
        "/items/999?verify_name=false",
        "DELETE",
        {},
      );
      const response = await handler(request, 999);

      expect(response.status).toBe(404);
    });

    test("verifies name when verify_name param is not false", async () => {
      const table = createTestTable();
      const resource = defineResource({
        table,
        fields: testFields,
        toInput,
        nameField: "name",
      });

      // Create initial row
      await table.insert({ name: "Important Item", value: 10 });

      let verifyFailedId: unknown = null;
      const handler = deleteHandler(resource, {
        onSuccess: () => new Response(null, { status: 204 }),
        onVerifyFailed: (id, _row) => {
          verifyFailedId = id;
          return new Response("Name mismatch", { status: 400 });
        },
        onNotFound: () => new Response("Not Found", { status: 404 }),
      });

      // Request without verify_name=false should verify name
      const request = await createAuthRequest("/items/1", "DELETE", {
        confirm_name: "Wrong Name",
      });
      const response = await handler(request, 1);

      expect(response.status).toBe(400);
      expect(verifyFailedId).toBe(1);

      // Row should still exist
      const row = await table.findById(1);
      expect(row).not.toBeNull();
    });

    test("deletes when name verification passes", async () => {
      const table = createTestTable();
      const resource = defineResource({
        table,
        fields: testFields,
        toInput,
        nameField: "name",
      });

      // Create initial row
      await table.insert({ name: "Important Item", value: 10 });

      const handler = deleteHandler(resource, {
        onSuccess: () => new Response(null, { status: 204 }),
        onVerifyFailed: () => new Response("Name mismatch", { status: 400 }),
        onNotFound: () => new Response("Not Found", { status: 404 }),
      });

      const request = await createAuthRequest("/items/1", "DELETE", {
        confirm_name: "Important Item",
      });
      const response = await handler(request, 1);

      expect(response.status).toBe(204);

      // Row should be deleted
      const row = await table.findById(1);
      expect(row).toBeNull();
    });

    test("skips name verification when verify_name=false", async () => {
      const table = createTestTable();
      const resource = defineResource({
        table,
        fields: testFields,
        toInput,
        nameField: "name",
      });

      // Create initial row
      await table.insert({ name: "Important Item", value: 10 });

      const handler = deleteHandler(resource, {
        onSuccess: () => new Response(null, { status: 204 }),
        onVerifyFailed: () => new Response("Name mismatch", { status: 400 }),
        onNotFound: () => new Response("Not Found", { status: 404 }),
      });

      // With verify_name=false, should skip verification
      const request = await createAuthRequest(
        "/items/1?verify_name=false",
        "DELETE",
        {},
      );
      const response = await handler(request, 1);

      expect(response.status).toBe(204);

      // Row should be deleted
      const row = await table.findById(1);
      expect(row).toBeNull();
    });
  });
});
