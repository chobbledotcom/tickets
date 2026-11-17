import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { workerCount } from "#scripts/verify-models/workers.ts";

const GIB = 1024 ** 3;

type Machine = readonly [cores: number, availableBytes: number];

const counts = (machines: readonly Machine[]): number[] =>
  machines.map(([cores, bytes]) => workerCount(cores, bytes));

describe("model check worker count", () => {
  test("takes the smaller of half the cores and the 6 GiB memory places", () => {
    expect(
      counts([
        [16, 23 * GIB],
        [32, 120 * GIB],
        [32, 30 * GIB],
        [9, 64 * GIB],
        [8, 24 * GIB - 1],
      ]),
    ).toEqual([3, 16, 5, 4, 3]);
  });

  test("never falls below two workers", () => {
    expect(
      counts([
        [2, 64 * GIB],
        [32, 4 * GIB],
        [1, 0],
      ]),
    ).toEqual([2, 2, 2]);
  });
});
