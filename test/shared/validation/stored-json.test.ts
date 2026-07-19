import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { defineStoredJson } from "#shared/validation/stored-json.ts";

const entriesJson = defineStoredJson(
  v.array(v.strictObject({ id: v.number(), name: v.string() })),
);

describe("defineStoredJson", () => {
  test("round-trips values that match the schema", () => {
    const entries = [{ id: 1, name: "First" }];
    expect(
      entriesJson.read(entriesJson.write(entries), "test.entries"),
    ).toEqual(entries);
  });

  test("rejects malformed JSON with storage context", () => {
    expect(() => entriesJson.read("{", "test.entries row 4")).toThrow(
      "Invalid stored JSON in test.entries row 4",
    );
  });

  test("rejects the wrong top-level shape", () => {
    expect(() => entriesJson.read('{"id":1}', "test.entries")).toThrow(
      "Invalid stored JSON in test.entries",
    );
  });

  test("rejects wrong element types", () => {
    expect(() =>
      entriesJson.read('[{"id":"1","name":"First"}]', "test.entries"),
    ).toThrow("Invalid stored JSON in test.entries");
  });

  test("rejects extra object fields", () => {
    expect(() =>
      entriesJson.read(
        '[{"id":1,"name":"First","extra":true}]',
        "test.entries",
      ),
    ).toThrow("Invalid stored JSON in test.entries");
  });

  test("validates values before writing", () => {
    expect(() =>
      entriesJson.write([{ id: 1, name: 2 }] as unknown as Parameters<
        typeof entriesJson.write
      >[0]),
    ).toThrow(/^Invalid value for stored JSON$/);
  });

  test("names the storage context when a write is invalid", () => {
    expect(() =>
      entriesJson.write(
        [{ id: 1, name: 2 }] as unknown as Parameters<
          typeof entriesJson.write
        >[0],
        "test.entries",
      ),
    ).toThrow("Invalid value for stored JSON in test.entries");
  });
});
