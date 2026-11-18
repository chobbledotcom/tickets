/**
 * The message groups that each shell and API may read (`src/locales/groups.ts`).
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ADMIN_SHELL_MESSAGE_GROUPS,
  PUBLIC_SHELL_MESSAGE_GROUPS,
  publicMessageGroups,
} from "#locales/groups.ts";

describe("the message groups", () => {
  test("the admin shell carries the public shell's copy first", () => {
    expect(
      ADMIN_SHELL_MESSAGE_GROUPS.slice(0, PUBLIC_SHELL_MESSAGE_GROUPS.length),
    ).toEqual([...PUBLIC_SHELL_MESSAGE_GROUPS]);
  });

  test("the admin shell carries the image picker's copy", () => {
    // Every admin page with image storage renders the editor's image picker.
    expect(ADMIN_SHELL_MESSAGE_GROUPS).toContain("images");
  });

  test("a public route adds its own copy after the public shell's", () => {
    expect(publicMessageGroups("tickets", "order")).toEqual([
      ...PUBLIC_SHELL_MESSAGE_GROUPS,
      "tickets",
      "order",
    ]);
  });
});
