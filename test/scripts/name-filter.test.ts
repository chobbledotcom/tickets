import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { extractNameFilter } from "#scripts/name-filter.ts";

describe("extracting --filter from runner arguments", () => {
  test("pulls a separate-value filter out of the arguments", () => {
    const { args, nameFilter } = extractNameFilter([
      "test/shared/dates.test.ts",
      "--filter",
      "formats date",
    ]);

    expect(args).toEqual(["test/shared/dates.test.ts"]);
    expect(nameFilter).toBe("formats date");
  });

  test("pulls an equals-form filter out of the arguments", () => {
    const { args, nameFilter } = extractNameFilter([
      "--filter=/leaf \\d+/",
      "test/",
    ]);

    expect(args).toEqual(["test/"]);
    expect(nameFilter).toBe("/leaf \\d+/");
  });

  test("keeps the last filter when the flag repeats", () => {
    const { nameFilter } = extractNameFilter([
      "--filter",
      "first",
      "--filter=second",
    ]);

    expect(nameFilter).toBe("second");
  });

  test("passes arguments without a filter through", () => {
    const { args, nameFilter } = extractNameFilter(["test/", "--coverage"]);

    expect(args).toEqual(["test/", "--coverage"]);
    expect(nameFilter).toBeUndefined();
  });

  test("fails a filter flag that has no value", () => {
    expect(() => extractNameFilter(["--filter"])).toThrow(
      "--filter needs a name or a /regular-expression/",
    );
  });
});
