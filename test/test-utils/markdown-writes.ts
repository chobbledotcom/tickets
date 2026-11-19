/** One Markdown write stores the text with the indentation of its first line.
 *  Four spaces at the start of a line make a code block, so every surface
 *  keeps them. */

import { expect } from "@std/expect";
import { adminFormPost } from "#test-utils/session.ts";

/** The line that an indented Markdown code block holds. */
export const MARKDOWN_CODE = "    const value = 7;";

/** The text a Markdown box receives: the code block and the newline after it.
 *  A write drops the newline and keeps the indentation. */
export const MARKDOWN_BOX = `${MARKDOWN_CODE}\n`;

/** Post one form and check the Markdown text it stores. The text keeps the
 *  indentation of its first line and drops the white space after it. */
export const expectFormStoresMarkdown = async (
  path: string,
  body: Record<string, string>,
  stored: () => string | Promise<string>,
): Promise<void> => {
  const { response } = await adminFormPost(path, body);
  expect(response.status).toBe(302);
  expect(await stored()).toBe(MARKDOWN_CODE);
};
