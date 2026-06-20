/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** POST a form-encoded body with a CSRF token, return parsed JSON. */
export const csrfPost = async (
  url: string,
  csrfToken: string,
  extraBody = "",
  // deno-lint-ignore no-explicit-any
): Promise<any> => {
  const body = `csrf_token=${encodeURIComponent(csrfToken)}${extraBody}`;
  const res = await fetch(url, {
    body,
    credentials: "same-origin",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return res.json();
};
