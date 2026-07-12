/**
 * Shared "create from the New form" wiring for the Site tab's hand-wired
 * editors (Pages, News). Both open the same way — validate the form, bounce
 * back on error, otherwise write the record and flash the saved confirmation —
 * so that flow lives here once instead of in each editor.
 */

import type { FormParams } from "#shared/form-data.ts";
import { savedContentResponse, siteContentPost } from "./site-content.ts";

/** A form check's outcome: the checked values, or the bounce-back response. */
export type ContentCheck<T> =
  | ({ ok: true } & T)
  | { ok: false; response: Response };

/** What a successful create tells the caller to flash and where to go next. */
type SavedContent = {
  path: string;
  logMessage: string;
  flashMessage: string;
};

/** Build the POST handler for a New form: check the form (bouncing back to
 * `newPagePath` on error), otherwise create the record and flash the saved
 * confirmation. */
export const siteCreatePost = <T>(
  newPagePath: string,
  check: (
    form: FormParams,
    errorPath: string,
  ) => ContentCheck<T> | Promise<ContentCheck<T>>,
  create: (checked: T, form: FormParams) => Promise<SavedContent>,
): ((request: Request) => Promise<Response>) =>
  siteContentPost(async (form) => {
    const checked = await check(form, newPagePath);
    if (!checked.ok) return checked.response;
    const saved = await create(checked, form);
    return savedContentResponse(
      saved.path,
      saved.logMessage,
      saved.flashMessage,
    );
  });
