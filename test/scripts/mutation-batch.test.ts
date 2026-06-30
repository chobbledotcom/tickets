import { expect } from "@std/expect";
import {
  batchTestFiles,
  TEST_FILE_BATCH_SIZE,
} from "../../scripts/mutation/batch.ts";

Deno.test("batchTestFiles returns no batches for an empty list", () => {
  expect(batchTestFiles([])).toEqual([]);
});

Deno.test("batchTestFiles keeps a sub-size list as a single batch", () => {
  const files = ["a.test.ts", "b.test.ts"];
  expect(batchTestFiles(files, 5)).toEqual([files]);
});

Deno.test("batchTestFiles splits into ordered batches with a partial tail", () => {
  expect(batchTestFiles(["a", "b", "c", "d", "e"], 2)).toEqual([
    ["a", "b"],
    ["c", "d"],
    ["e"],
  ]);
});

Deno.test("batchTestFiles defaults to TEST_FILE_BATCH_SIZE per process", () => {
  const files = Array.from(
    { length: TEST_FILE_BATCH_SIZE + 1 },
    (_unused, i) => `f${i}.test.ts`,
  );
  const batches = batchTestFiles(files);
  expect(batches.length).toBe(2);
  expect(batches[0]?.length).toBe(TEST_FILE_BATCH_SIZE);
  expect(batches[1]?.length).toBe(1);
});
