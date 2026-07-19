import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { FormParams } from "#shared/form-data.ts";
import { readRepeatedPicklist } from "#shared/forms/repeated-picklist.ts";

const DaySchema = v.picklist(["Monday", "Tuesday", "Wednesday"]);

const read = (query: string, enabled = true) =>
  readRepeatedPicklist(DaySchema, new FormParams(query), "days", enabled);

describe("readRepeatedPicklist", () => {
  test("is enabled when the flag is omitted", () => {
    expect(
      readRepeatedPicklist(DaySchema, new FormParams("days=Monday"), "days"),
    ).toEqual({ state: "selected", values: ["Monday"] });
  });

  test("returns disabled without accepting supplied values", () => {
    expect(read("days=Monday", false)).toEqual({ state: "disabled" });
  });

  test("distinguishes an absent enabled selection", () => {
    expect(read("")).toEqual({ state: "absent" });
  });

  test("returns the first invalid supplied token", () => {
    expect(read("days=Monday&days=Funday&days=Someday")).toEqual({
      state: "invalid",
      value: "Funday",
    });
  });

  test("returns unique values in schema order", () => {
    expect(read("days=Wednesday&days=Monday&days=Wednesday")).toEqual({
      state: "selected",
      values: ["Monday", "Wednesday"],
    });
  });

  test("treats a supplied empty token as invalid", () => {
    expect(read("days=")).toEqual({ state: "invalid", value: "" });
  });
});
