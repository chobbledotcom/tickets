import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readAllPages } from "#shared/paged-read.ts";

describe("paged-read", () => {
  test("collects every page's rows in order and stops when none follow", async () => {
    const pagesRead: number[] = [];
    const pages = [
      { hasNext: true, rows: ["a", "b"] },
      { hasNext: true, rows: ["c"] },
      { hasNext: false, rows: ["d", "e"] },
    ];

    const rows = await readAllPages(10, (page) => {
      pagesRead.push(page);
      return Promise.resolve(pages[page]!);
    });

    expect(rows).toEqual(["a", "b", "c", "d", "e"]);
    expect(pagesRead).toEqual([0, 1, 2]);
  });

  test("a single last page is returned as-is", async () => {
    const rows = await readAllPages(10, () =>
      Promise.resolve({ hasNext: false, rows: [1, 2] }),
    );
    expect(rows).toEqual([1, 2]);
  });

  test("a reader that never runs out of pages fails loudly", async () => {
    let reads = 0;
    await expect(
      readAllPages(5, () => {
        reads++;
        return Promise.resolve({ hasNext: true, rows: ["x"] });
      }),
    ).rejects.toThrow("Paged read still reported more rows after 5 pages");
    // Exactly the capped number of pages was read, and not one more.
    expect(reads).toBe(5);
  });
});
