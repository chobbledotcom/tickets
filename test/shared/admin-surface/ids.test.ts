/**
 * The record-destination type. It is only types, so the checks are the type
 * checker's: `deno check test` fails if either of these stops holding.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { AdminRecordDestinationId } from "#shared/admin-surface/ids.ts";

/** A route whose path carries one plain `:id` is a record destination. */
const record: AdminRecordDestinationId = "holidayEdit";

// @ts-expect-error a path with no parameter names no record
const noParameter: AdminRecordDestinationId = "home";

// @ts-expect-error a path with a second parameter names more than the record
const twoParameters: AdminRecordDestinationId = "answerEdit";

describe("the record destinations", () => {
  test("keeps the ids the type checker admitted", () => {
    expect([record, noParameter, twoParameters]).toEqual([
      "holidayEdit",
      "home",
      "answerEdit",
    ]);
  });
});
