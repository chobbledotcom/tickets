/**
 * No sequence of adds can leave a redirect that leads to another redirect.
 * Every ordered pair of three pages is tried in two orders, with the same
 * page written in other ways. After each run, a visitor who follows any
 * redirect reaches a page that is not itself redirected.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  LIST,
  listedRedirects,
  sentFrom,
  shopWith,
} from "#test/blackbox/redirects.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/* jscpd:ignore-start -- lists of strings, not code */
const WRITINGS: Record<string, string[]> = {
  "/a": ["/a", "/A/", "/a?x=1"],
  "/b": ["/b", "/B/", "/b#top"],
  "/c": ["/c", "/C/", "/c?y=2"],
};
/* jscpd:ignore-end */

const PAGES = Object.keys(WRITINGS);

/** Every ordered pair of two different pages, each page written two ways. */
const PAIRS: [string, string][] = PAGES.flatMap((from) =>
  PAGES.filter((to) => to !== from).flatMap((to) => [
    [WRITINGS[from]![0]!, WRITINGS[to]![1]!] as [string, string],
    [WRITINGS[from]![1]!, WRITINGS[to]![2]!] as [string, string],
  ]),
);

/** The path of a saved to page, or null when it names another site. */
const localPath = (to: string): string | null =>
  to.startsWith("/") ? to.replace(/[?#].*$/, "") : null;

/** Every redirect that a visitor can follow ends on a page with no redirect. */
const expectNoChain = async (app: Awaited<ReturnType<typeof shopWith>>) => {
  const rows = await listedRedirects(app);
  const ends = await Promise.all(
    rows.map(async ([from]) => {
      const [status, location] = await sentFrom(from);
      expect(status).toBe(301);
      const path = localPath(location!);
      return path === null ? 404 : (await sentFrom(path))[0];
    }),
  );
  expect(ends.filter((status) => status === 301)).toEqual([]);
};

describeWithEnv("redirects never chain", { db: true }, () => {
  describe("every pair, in either order", () => {
    for (const [name, pairs] of [
      ["in order", PAIRS],
      ["in reverse", [...PAIRS].reverse()],
    ] as const) {
      test(`adds ${name} leave no chain`, async () => {
        const app = await shopWith();
        for (const [from, to] of pairs) {
          await app.submit(`${LIST}/new`, { fromPath: from, toUrl: to }, LIST);
        }
        expect((await listedRedirects(app)).length).toBeGreaterThan(0);
        await expectNoChain(app);
      });
    }
  });
});
