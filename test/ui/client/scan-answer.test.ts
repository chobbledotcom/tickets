import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { ScanAnswerSchema } from "#src/ui/client/scan-answer.ts";

describe("the scan answer schema", () => {
  test("reads a refusal envelope as the status other", () => {
    expect(v.parse(ScanAnswerSchema, { error: "Not authenticated" })).toEqual({
      error: "Not authenticated",
      status: "other",
    });
    expect(v.parse(ScanAnswerSchema, {})).toEqual({ status: "other" });
  });

  test("refuses a status the page has no words for", () => {
    for (const body of [
      { name: "Ada", status: "teleported" },
      { error: "x", status: "teleported" },
    ]) {
      expect(v.safeParse(ScanAnswerSchema, body).success, body.status).toBe(
        false,
      );
    }
  });
});
