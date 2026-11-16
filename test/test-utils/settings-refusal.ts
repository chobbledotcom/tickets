/** Check that an admin settings form refuses a value and stores nothing. */

import { expect } from "@std/expect";
import { expectErrorFlash } from "#test-utils/assertions.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** Post `fields` to `path`, then pin the error flash and the stored value,
 *  so a rejected save can never leave a partial write behind. */
export const expectFormValueRefused = async (
  {
    fields,
    flash,
    path,
    stored,
  }: {
    fields: Record<string, string>;
    flash: string;
    path: string;
    stored: () => unknown;
  },
  expected: unknown,
): Promise<void> => {
  const { response } = await adminFormPost(path, fields);
  expectErrorFlash(response, flash);
  expect(stored()).toEqual(expected);
};
