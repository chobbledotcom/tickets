/**
 * The driver for black-box tests: a visitor who knows the app only by its
 * addresses, its pages, and its forms.
 *
 * A black-box test imports this file and nothing from `src/` (see "Keep tests
 * on the public surface" in AGENTS.md). It reads pages as HTML, sends the
 * form that the page offers, and keeps the cookies that the app sets. The
 * target decides where requests go: into the handler of this process, or over
 * HTTP to a running app.
 */

import { handleRequest } from "#routes";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";
import { extractFormEntries } from "#test-utils/test-browser/forms.ts";

/** Where one request goes. */
export type Target = (request: Request) => Promise<Response>;

/** What a visitor sees after one request. A redirect is not followed. */
export interface Page {
  html: string;
  /** The address that a redirect names, or null. */
  location: string | null;
  status: number;
}

/** The fields to send, by name. They replace what the form holds. A null
 * leaves the field out, as a browser does for a box that is not ticked. */
export type Fields = Record<string, string | null>;

export interface App {
  /** The `cookie` header value that the visitor now sends. */
  cookieHeader(): string;
  get(path: string): Promise<Page>;
  /** Log in as the owner through the login form. */
  logIn(username?: string, password?: string): Promise<Page>;
  /** Open `path`, fill the form that the page offers, and send it. `form`
   * names the form by its action, and defaults to `path`. */
  submit(path: string, fields?: Fields, form?: string): Promise<Page>;
  /** The target that this visitor sends to. */
  readonly target: Target;
}

/** Send requests to the handler in this process. */
export const inProcess: Target = (request) => handleRequest(request);

/** Send requests over HTTP to the app at `origin`. */
export const overHttp =
  (origin: string): Target =>
  async (request) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete("host");
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return await fetch(new URL(`${url.pathname}${url.search}`, origin), {
      body: hasBody ? await request.arrayBuffer() : null,
      headers,
      method: request.method,
      redirect: "manual",
    });
  };

/** Keep each cookie that a response sets, and drop each that it expires. */
const rememberCookies = (
  jar: Map<string, string>,
  response: Response,
): void => {
  for (const line of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = line.split(";");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    if (attributes.some((part) => /^\s*max-age=0\s*$/i.test(part))) {
      jar.delete(name);
    } else {
      jar.set(name, pair.slice(at + 1));
    }
  }
};

const FORM_PATTERN = /<form\b[^>]*>[\s\S]*?<\/form>/gi;

/** The form of `html` whose action is `action`, or a loud failure that lists
 * the actions that the page does offer. */
const formWithAction = (html: string, action: string): string => {
  const forms = html.match(FORM_PATTERN) ?? [];
  const actionOf = (form: string): string | undefined =>
    form.match(/<form\b[^>]*\baction="([^"]*)"/i)?.[1];
  const found = forms.find((form) => actionOf(form) === action);
  if (found === undefined) {
    const offered = forms.map((form) => actionOf(form) ?? "(none)").join(", ");
    throw new Error(
      `The page offers no form with action "${action}". Forms: ${offered || "none"}.`,
    );
  }
  return found;
};

/** The body that a browser sends for these entries: multipart when the form
 * asks for it, and URL-encoded otherwise. */
const bodyFor = (
  form: string,
  entries: [string, string][],
): { body: BodyInit; headers: Record<string, string> } => {
  if (/<form\b[^>]*enctype="multipart\/form-data"/i.test(form)) {
    const data = new FormData();
    for (const [name, value] of entries) data.append(name, value);
    return { body: data, headers: {} };
  }
  return {
    body: new URLSearchParams(entries).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
};

/** The entries of a form with each named field replaced, in browser order. */
const withFields = (
  entries: [string, string][],
  fields: Fields,
): [string, string][] => {
  const replaced = entries.map(([name, value]): [string, string | null] => {
    const field = fields[name];
    return [name, field === undefined ? value : field];
  });
  const known = new Set(entries.map(([name]) => name));
  const added = Object.entries(fields).filter(([name]) => !known.has(name));
  return [...replaced, ...added].filter(
    (entry): entry is [string, string] => entry[1] !== null,
  );
};

/** A visitor with no cookies, or with the cookie header `cookie`. */
export const createApp = (target: Target, cookie = ""): App => {
  const jar = new Map<string, string>(
    cookie === ""
      ? []
      : cookie.split("; ").map((pair): [string, string] => {
          const at = pair.indexOf("=");
          return [pair.slice(0, at), pair.slice(at + 1)];
        }),
  );
  const cookieHeader = (): string =>
    [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

  const send = async (path: string, init: RequestInit = {}): Promise<Page> => {
    const headers = new Headers(init.headers);
    headers.set("host", "localhost");
    if (jar.size > 0) headers.set("cookie", cookieHeader());
    const response = await target(
      new Request(`http://localhost${path}`, { ...init, headers }),
    );
    rememberCookies(jar, response);
    return {
      html: await response.text(),
      location: response.headers.get("location"),
      status: response.status,
    };
  };

  const get = (path: string): Promise<Page> => send(path);

  const submit = async (
    path: string,
    fields: Fields = {},
    action: string = path,
  ): Promise<Page> => {
    const form = formWithAction((await get(path)).html, action);
    const { body, headers } = bodyFor(
      form,
      withFields(extractFormEntries(form), fields),
    );
    return await send(action, { body, headers, method: "POST" });
  };

  return {
    cookieHeader,
    get,
    logIn: (username = TEST_ADMIN_USERNAME, password = TEST_ADMIN_PASSWORD) =>
      submit("/admin/", { password, username }, "/admin/login"),
    submit,
    target,
  };
};
