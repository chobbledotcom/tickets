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

  test("uses one worker when either budget has only one place", () => {
    expect(
      counts([
        [2, 64 * GIB],
        [32, 6 * GIB],
        [1, 12 * GIB - 1],
      ]),
    ).toEqual([1, 1, 1]);
  });

  test("refuses to run without one full memory place", () => {
    for (const available of [0, 4 * GIB, 6 * GIB - 1]) {
      expect(() => workerCount(32, available)).toThrow(
        "Model checks require at least 6 GiB of free memory.",
      );
    }
  });
});
