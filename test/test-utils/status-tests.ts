import { expect } from "@std/expect";
import { it } from "@std/testing/bdd";

/** One test per entry of `requests`: each request answers `status`. The table
 *  keeps the boundary tests of one page in a single place, so every case states
 *  only the request that must be refused. */
export const testStatus = (
  status: number,
  requests: Readonly<Record<string, () => Promise<Response>>>,
): void => {
  for (const [name, request] of Object.entries(requests)) {
    it(name, async () => {
      expect((await request()).status).toBe(status);
    });
  }
};
