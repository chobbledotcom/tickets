/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { postForJson } from "../dom.ts";

/** POST a form-encoded body with a CSRF token, return parsed JSON. */
export const csrfPost = (
  url: string,
  csrfToken: string,
  extraBody = "",
): Promise<any> =>
  postForJson(url, {
    body: `csrfToken=${encodeURIComponent(csrfToken)}${extraBody}`,
    credentials: "same-origin",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
