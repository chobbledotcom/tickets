/**
 * Test barrel — re-exports from Deno standard library.
 * No custom code except `test` alias (`@std/testing/bdd` exports `it` but not `test`).
 */

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "@std/testing/bdd";
export { expect } from "@std/expect";
export { fn } from "@std/expect/fn";
export { type Spy, type Stub, assertSpyCalls, spy, stub } from "@std/testing/mock";
export { FakeTime } from "@std/testing/time";

import { it } from "@std/testing/bdd";
export const test = it;
