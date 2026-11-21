/**
 * The shared shape of a whole number form field: its input type, its parser,
 * and its check with the field label.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import { wholeNumberFieldShape } from "#templates/fields/validators.ts";

describe("wholeNumberFieldShape", () => {
  beforeAll(() => ensureMessageGroups(["validation"]));

  test("declares a number input with parser and check", () => {
    const shape = wholeNumberFieldShape("Capacity");
    expect(shape.type).toBe("number");
    expect(shape.parse("7")).toBe(7);
    expect(shape.validate("1.5")).toBe("Capacity must be a whole number");
  });
});
