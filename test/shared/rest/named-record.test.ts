/**
 * A named record fills its display name, log name, and confirmation column
 * from the row's `name`, and caps that name on every write.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import type { IdNameInput, IdNameRow } from "#test-utils/rest-fixtures.ts";

describe("the named record", () => {
  const record = defineNamedRowRecord<RecordShapeOf<IdNameRow, IdNameInput>>()({
    activityName: "Widget",
    surface: "holidays",
  });

  test("names the row, the log line, and the confirmation column by name", () => {
    expect(record.nameField).toBe("name");
    expect(record.logName({ name: "Logged" })).toBe("Logged");
    expect(record.nameOf({ id: 1, name: "Shown" })).toBe("Shown");
    expect(record.activityName).toBe("Widget");
  });

  test("answers the form's message for a name past the input limit", () => {
    expect(
      record.inputCheck?.({ name: "x".repeat(MAX_INPUT_LENGTH + 1) }),
    ).toBe(`Name must be ${MAX_INPUT_LENGTH} characters or fewer`);
    expect(record.inputCheck?.({ name: "x".repeat(MAX_INPUT_LENGTH) })).toBe(
      null,
    );
  });
});
