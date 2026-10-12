/**
 * The repo's `@std/testing/bdd`: the std functions, plus leaf-name pruning
 * when the runner handed the isolate a `--filter` through
 * `TICKETS_TEST_FILTER` (see test-name-filter.ts). The import map points
 * `@std/testing/bdd` here, so every `describe`/`it` in the suite goes through
 * this module and an unfiltered run passes std straight through.
 */
import * as std from "jsr:@std/testing/bdd";
import {
  createTestNameFilter,
  TEST_NAME_FILTER_ENV,
} from "#test-utils/test-name-filter.ts";

const filter = createTestNameFilter(
  Deno.env.get(TEST_NAME_FILTER_ENV),
  std,
  Deno.test,
);

export const describe = filter.describe;
export const it = filter.it;
export const test = filter.test;
export const beforeAll = filter.beforeAll;
export const beforeEach = filter.beforeEach;
export const afterAll = filter.afterAll;
export const afterEach = filter.afterEach;
export type {
  DescribeArgs,
  DescribeDefinition,
  ItArgs,
  ItDefinition,
  TestSuite,
} from "jsr:@std/testing/bdd";
