import type { Client, ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { execute, setDb } from "#shared/db/client.ts";
import { withEnv } from "#test-utils/env.ts";

/** Walk one backoff wait: the attempt count holds until the wait's final
 * millisecond, when exactly the next attempt fires. */
export const expectNextAttemptAfter = async (
  time: FakeTime,
  waitMs: number,
  countAttempts: () => number,
): Promise<void> => {
  const before = countAttempts();
  await time.tickAsync(waitMs - 1);
  expect(countAttempts()).toBe(before);
  await time.tickAsync(1);
  expect(countAttempts()).toBe(before + 1);
};

/** Drive one database shape's full backoff walk: every attempt fails with
 * `failsWith`, each of the ladder's waits passes in full before the next
 * attempt, and the operation ends exactly as `outcome` says. DB_URL is pinned
 * because the ladder length comes from it — whatever database the surrounding
 * environment names must not change what is being counted. */
export const expectFullBackoffWalk = async (options: {
  dbUrl: string;
  failsWith: () => Error;
  sql: string;
  waits: readonly number[];
  outcome: (operation: Promise<ResultSet>) => Promise<void>;
}): Promise<void> => {
  using _env = withEnv({ DB_URL: options.dbUrl });
  using time = new FakeTime();
  let attempts = 0;
  setDb({
    execute: (): Promise<ResultSet> => {
      attempts++;
      return Promise.reject(options.failsWith());
    },
  } as unknown as Client);
  const done = options.outcome(execute(options.sql));
  await time.tickAsync(0);
  expect(attempts).toBe(1);
  for (const wait of options.waits) {
    await expectNextAttemptAfter(time, wait, () => attempts);
  }
  expect(attempts).toBe(options.waits.length + 1);
  await done;
};
