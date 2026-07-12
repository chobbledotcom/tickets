import { applyFlash } from "#routes/csrf.ts";
import { signCsrfToken } from "#shared/csrf.ts";

/** Read this request's flash message and refresh its CSRF token, ready to
 * render a page. Returns the flash values (error/info/success) to show. Shared
 * by the page handlers that open with this same two-step preamble. */
export const flashForPage = async (request: Request) => {
  const flash = applyFlash(request);
  await signCsrfToken();
  return flash;
};
