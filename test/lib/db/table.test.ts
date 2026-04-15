import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { eventsTable } from "#lib/db/events.ts";
import { createTestEvent, describeWithEnv } from "#test-utils";

describeWithEnv("db > table utilities", { db: true }, () => {
  test("toCamelCase converts snake_case to camelCase", async () => {
    const { toCamelCase } = await import("#lib/db/table.ts");
    expect(toCamelCase("max_attendees")).toBe("maxAttendees");
    expect(toCamelCase("thank_you_url")).toBe("thankYouUrl");
    expect(toCamelCase("name")).toBe("name");
    expect(toCamelCase("payment_id")).toBe("paymentId");
  });

  test("toSnakeCase converts camelCase to snake_case", async () => {
    const { toSnakeCase } = await import("#lib/db/table.ts");
    expect(toSnakeCase("maxAttendees")).toBe("max_attendees");
    expect(toSnakeCase("thankYouUrl")).toBe("thank_you_url");
    expect(toSnakeCase("name")).toBe("name");
    expect(toSnakeCase("paymentId")).toBe("payment_id");
  });

  test("buildInputKeyMap creates mapping from DB columns to input keys", async () => {
    const { buildInputKeyMap } = await import("#lib/db/table.ts");
    const columns = ["max_attendees", "thank_you_url", "name"];
    const map = buildInputKeyMap(columns);
    expect(map).toEqual({
      max_attendees: "maxAttendees",
      name: "name",
      thank_you_url: "thankYouUrl",
    });
  });

  test("col.generated creates generated column definition", async () => {
    const { col } = await import("#lib/db/table.ts");
    const def = col.generated<number>();
    expect(def.generated).toBe(true);
  });

  test("col.withDefault creates column with default", async () => {
    const { col } = await import("#lib/db/table.ts");
    const def = col.withDefault(() => "default-value");
    expect(def.default?.()).toBe("default-value");
  });

  test("col.simple creates empty column definition", async () => {
    const { col } = await import("#lib/db/table.ts");
    const def = col.simple<string>();
    expect(def).toEqual({});
  });

  test("col.transform creates column with custom transforms", async () => {
    const { col } = await import("#lib/db/table.ts");
    const write = (v: string) => v.toUpperCase();
    const read = (v: string) => v.toLowerCase();
    const def = col.transform(write, read);
    expect(def.write?.("hello")).toBe("HELLO");
    expect(def.read?.("HELLO")).toBe("hello");
  });

  test("col.encrypted creates column with encrypt/decrypt transforms", async () => {
    const { col } = await import("#lib/db/table.ts");
    const encrypt = (v: string) => Promise.resolve(`enc:${v}`);
    const decrypt = (v: string) => Promise.resolve(v.replace("enc:", ""));
    const def = col.encrypted(encrypt, decrypt);
    expect(await def.write?.("hello")).toBe("enc:hello");
    expect(await def.read?.("enc:hello")).toBe("hello");
  });

  test("col.encryptedText passes through empty strings without encrypting", async () => {
    const { col } = await import("#lib/db/table.ts");
    const encrypt = (v: string) => Promise.resolve(`enc:${v}`);
    const decrypt = (v: string) => Promise.resolve(v.replace("enc:", ""));
    const def = col.encryptedText(encrypt, decrypt);
    expect(def.default?.()).toBe("");
    expect(await def.write?.("")).toBe("");
    expect(await def.read?.("")).toBe("");
    expect(await def.write?.("hello")).toBe("enc:hello");
    expect(await def.read?.("enc:hello")).toBe("hello");
  });

  test("col.encryptedNullable wrapping simple column has no transforms", async () => {
    const { col } = await import("#lib/db/table.ts");
    const def = col.encryptedNullable(col.simple());
    expect(def.write).toBeUndefined();
    expect(def.read).toBeUndefined();
  });

  test("col.encryptedNullable handles null values", async () => {
    const { col } = await import("#lib/db/table.ts");
    const encrypt = (v: string) => Promise.resolve(`enc:${v}`);
    const decrypt = (v: string) => Promise.resolve(v.replace("enc:", ""));
    const def = col.encryptedNullable(col.encrypted(encrypt, decrypt));
    expect(await def.write?.(null)).toBe(null);
    expect(await def.read?.(null)).toBe(null);
    expect(await def.write?.("hello")).toBe("enc:hello");
    expect(await def.read?.("enc:hello")).toBe("hello");
  });

  test("defineTable.findAll returns all rows", async () => {
    const { col, defineTable } = await import("#lib/db/table.ts");

    type TestRow = { id: number; name: string };
    type TestInput = { name: string };
    const testTable = defineTable<TestRow, TestInput>({
      name: "events",
      primaryKey: "id",
      schema: {
        id: col.generated<number>(),
        name: col.simple<string>(),
      },
    });

    await createTestEvent({
      maxAttendees: 10,
      name: "Event One",
      thankYouUrl: "https://example.com",
    });
    await createTestEvent({
      maxAttendees: 20,
      name: "Event Two",
      thankYouUrl: "https://example.com",
    });

    const rows = await testTable.findAll();
    expect(rows.length).toBe(2);
  });

  test("defineTable.update with no changes returns existing row", async () => {
    const { col, defineTable } = await import("#lib/db/table.ts");

    const event = await createTestEvent({
      maxAttendees: 10,
      thankYouUrl: "https://example.com",
    });

    type TestRow = { id: number; name: string };
    type TestInput = { name?: string };
    const testTable = defineTable<TestRow, TestInput>({
      name: "events",
      primaryKey: "id",
      schema: {
        id: col.generated<number>(),
        name: col.simple<string>(),
      },
    });

    const result = await testTable.update(event.id, {});
    expect(result).not.toBeNull();
    expect(result?.id).toBe(event.id);
  });

  test("defineTable with write transform transforms values on insert", async () => {
    const { col, defineTable } = await import("#lib/db/table.ts");
    type TestRow = {
      id: number;
      slug: string;
      slug_index: string;
      created: string;
      max_attendees: number;
      thank_you_url: string;
      unit_price: number;
      max_quantity: number;
      webhook_url: string | null;
      active: number;
    };
    type TestInput = {
      slug: string;
      slugIndex: string;
      maxAttendees: number;
      thankYouUrl: string;
      unitPrice?: number;
      maxQuantity?: number;
      webhookUrl?: string | null;
      active?: number;
    };
    const testTable = defineTable<TestRow, TestInput>({
      name: "events",
      primaryKey: "id",
      schema: {
        active: col.withDefault(() => 1),
        created: col.withDefault(() => new Date().toISOString()),
        id: col.generated<number>(),
        max_attendees: col.simple<number>(),
        max_quantity: col.withDefault(() => 1),
        slug: col.transform(
          (v: string) => v.toUpperCase(),
          (v: string) => v.toLowerCase(),
        ),
        slug_index: col.simple<string>(),
        thank_you_url: col.simple<string>(),
        unit_price: col.withDefault(() => 0),
        webhook_url: col.simple<string | null>(),
      },
    });

    const row = await testTable.insert({
      maxAttendees: 10,
      slug: "test-event",
      slugIndex: "test-index",
      thankYouUrl: "http://test.com",
    });
    expect(row.slug).toBe("test-event");

    const fromDb = await testTable.findById(row.id);
    expect(fromDb?.slug).toBe("test-event");
  });

  test("insert with non-generated primary key uses empty initial row", async () => {
    const { col, defineTable } = await import("#lib/db/table.ts");
    const { getDb } = await import("#lib/db/client.ts");

    await getDb().execute(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    type KvRow = { key: string; value: string };
    type KvInput = { key: string; value: string };
    const kvTable = defineTable<KvRow, KvInput>({
      name: "kv_store",
      primaryKey: "key",
      schema: {
        key: col.simple<string>(),
        value: col.simple<string>(),
      },
    });

    const row = await kvTable.insert({
      key: "test-key",
      value: "test-value",
    });
    expect(row.key).toBe("test-key");
    expect(row.value).toBe("test-value");

    const fetched = await kvTable.findById("test-key");
    expect(fetched).not.toBeNull();
    expect(fetched?.value).toBe("test-value");
  });

  test("inputKeyMap maps single-word columns to themselves", async () => {
    const { buildInputKeyMap } = await import("#lib/db/table.ts");
    const map = buildInputKeyMap(["name", "max_attendees"]);
    expect(map.name).toBe("name");
    expect(map.max_attendees).toBe("maxAttendees");
  });

  test("getProvidedColumns uses inputKeyMap fallback for single-word keys", async () => {
    const event = await createTestEvent({
      maxAttendees: 10,
      name: "Fallback Test",
      thankYouUrl: "https://example.com",
    });

    const updated = await eventsTable.update(event.id, {
      maxAttendees: 10,
      name: "Updated Name",
      slug: "updated-slug",
      slugIndex: "updated-index",
      thankYouUrl: "https://example.com",
    });
    expect(updated?.name).toBe("Updated Name");
  });
});
