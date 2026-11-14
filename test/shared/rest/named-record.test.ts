/**
 * A named record fills its display name, log name, and confirmation column
 * from the row's `name`, and a name limit runs before the record rule.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import {
  defineNamedRowRecord,
  withNameLimit,
} from "#shared/rest/named-record.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { errorResult, okResult } from "#shared/result.ts";
import type { IdNameInput, IdNameRow } from "#test-utils/rest-fixtures.ts";

describe("the named record", () => {
  test("names the row, the log line, and the confirmation column by name", () => {
    const record = defineNamedRowRecord<
      RecordShapeOf<IdNameRow, IdNameInput>
    >()({ activityName: "Widget", surface: "holidays" });

    expect(record.nameField).toBe("name");
    expect(record.logName({ name: "Logged" })).toBe("Logged");
    expect(record.nameOf({ id: 1, name: "Shown" })).toBe("Shown");
    expect(record.activityName).toBe("Widget");
  });

  test("a name past the limit gets the form's message before the rule runs", () => {
    const rule = withNameLimit<IdNameInput>(() => errorResult("Rule ran"));

    expect(rule({ name: "x".repeat(MAX_INPUT_LENGTH + 1) })).toEqual(
      errorResult(`Name must be ${MAX_INPUT_LENGTH} characters or fewer`),
    );
  });

  test("a name inside the limit goes to the rule", () => {
    const rule = withNameLimit<IdNameInput>((input) =>
      okResult({ name: `${input.name}!` }),
    );

    expect(rule({ name: "x".repeat(MAX_INPUT_LENGTH) })).toEqual(
      okResult({ name: `${"x".repeat(MAX_INPUT_LENGTH)}!` }),
    );
  });
});
