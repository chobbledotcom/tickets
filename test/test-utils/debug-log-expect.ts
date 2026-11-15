/** Assertions over the debug lines a test captured, beyond reading them with
 *  {@link debugMessages}. */

import { expect } from "@std/expect";
import type { Spy } from "@std/testing/mock";
import { debugMessages } from "#test-utils/debug-log.ts";

/** Assert the debug line written last. A test that pins the last line proves
 *  which branch ran, not only that the line appeared somewhere. */
export const expectLastDebugMessage = (
  debugSpy: () => Spy,
  message: string,
): void => {
  expect(debugMessages(debugSpy()).at(-1)).toBe(message);
};
