/** The chain suites split the upgrade start points across files. Each
 * chain-*.test.ts file names its shard and the shared shard count in one
 * literal call, and nothing else records the split. This check reads the
 * calls back and proves the split still covers every upgrade start point
 * exactly once: a mistyped shard number or a missing file drops start
 * points from the suite, and every test stays green. */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { unique } from "#fp";
import { migrationBoundaries } from "#test/integration/db/migration-restore/helpers.ts";

const CHAIN_FILE = /^chain-[a-z]\.test\.ts$/;
const SHARD_CALL = /defineChainSuite\((\d+),\s*(\d+)\)/g;

/** The upgrade start points one chain shard owns: every `shardCount`-th
 * boundary, offset by the shard. */
const ownedBoundaries = (shard: number, shardCount: number): string[] =>
  migrationBoundaries.flatMap((boundary, index) =>
    index % shardCount === shard ? [boundary.id] : [],
  );

type ChainShard = { file: string; shard: number; shardCount: number };

const readChainShards = async (): Promise<ChainShard[]> => {
  const files: string[] = [];
  for await (const entry of Deno.readDir(import.meta.dirname!)) {
    if (CHAIN_FILE.test(entry.name)) files.push(entry.name);
  }
  files.sort();
  return await Promise.all(
    files.map(async (file) => {
      const source = await Deno.readTextFile(`${import.meta.dirname!}/${file}`);
      const calls = [...source.matchAll(SHARD_CALL)];
      if (calls.length !== 1) {
        throw new Error(
          `${file} must hold exactly one defineChainSuite(shard, shardCount) call, found ${calls.length}`,
        );
      }
      const call = calls[0]!;
      return {
        file,
        shard: Number(call[1]!),
        shardCount: Number(call[2]!),
      };
    }),
  );
};

const shards = await readChainShards();

describe("chain shard coverage", () => {
  test("each chain file registers one shard of one shared count", () => {
    expect(shards.length).toBeGreaterThan(0);
    const counts = unique(shards.map((entry) => entry.shardCount));
    expect(counts.length, "the chain files name different shard counts").toBe(
      1,
    );
    expect(shards.map((entry) => entry.shard).sort((a, b) => a - b)).toEqual(
      Array.from({ length: shards.length }, (_, index) => index),
    );
  });

  test("the shards cover every upgrade start point exactly once", () => {
    const covered = shards.flatMap(({ shard, shardCount }) =>
      ownedBoundaries(shard, shardCount),
    );
    expect(covered.length).toBe(migrationBoundaries.length);
    expect(unique(covered).length).toBe(migrationBoundaries.length);
  });

  test("every shard owns at least one upgrade start point", () => {
    for (const { shard, shardCount } of shards) {
      expect(
        ownedBoundaries(shard, shardCount).length,
        `chain shard ${shard} owns no upgrade start point`,
      ).toBeGreaterThan(0);
    }
  });
});
