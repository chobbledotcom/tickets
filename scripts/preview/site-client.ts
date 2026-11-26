/**
 * A visitor to a running site, for the steps that set up a new preview. It
 * keeps the cookies that the site sets, reads the forms that a page offers,
 * and sends them back with named fields replaced. It does not follow a
 * redirect: the caller reads the address that the site names.
 */

import { replacing } from "#shared/replacements.ts";

export type Send = (request: Request) => Promise<Response>;

/** What one request gave back. `location` is null when the answer names no
 * address. */
export type Page = { html: string; location: string | null; status: number };

/** The fields to send, by name. A field replaces what the form holds. A null
 * leaves the field out, as a browser does for a box that is not ticked. */
export type Fields = Record<string, string | null>;

export interface SiteClient {
  get(path: string): Promise<Page>;
  /** Open `path`, find the form with this `action` on it, and send it. The
   * action defaults to `path`. */
  submit(path: string, fields: Fields, action?: string): Promise<Page>;
}

const FORM_PATTERN = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
const INPUT_PATTERN = /<input\b[^>]*>/gi;
const SKIPPED_INPUT_TYPES = ["button", "file", "image", "reset", "submit"];
const TICKED_INPUT_TYPES = ["checkbox", "radio"];

/** The text of an attribute value, with the entities that the app writes
 * turned back into their characters. The ampersand goes last. */
const decodeEntities = replacing(
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&(?:#39|#x27);/g, "'"],
  [/&amp;/g, "&"],
);

/** The value of one attribute of a tag, or undefined when the tag has none. */
const attributeOf = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`\\s${name}="([^"]*)"`, "i"))?.[1];

const hasFlag = (tag: string, name: string): boolean =>
  new RegExp(`\\s${name}(?=[\\s/>=])`, "i").test(tag);

/** The form of the page that posts to `action`. A miss lists the actions that
 * the page does offer. */
const formWithAction = (html: string, action: string): string => {
  const forms = html.match(FORM_PATTERN) ?? [];
  const actionOf = (form: string): string | undefined =>
    form.match(/<form\b[^>]*\saction="([^"]*)"/i)?.[1];
  const found = forms.find((form) => actionOf(form) === action);
  if (found === undefined) {
    const offered = forms.map((form) => actionOf(form) ?? "(none)").join(", ");
    throw new Error(
      `The page offers no form with action "${action}". Forms: ${offered || "none"}.`,
    );
  }
  return found;
};

/** What a browser sends for each input of a form that it would send. */
const inputEntries = (form: string): [string, string][] =>
  (form.match(INPUT_PATTERN) ?? []).flatMap((tag): [string, string][] => {
    const name = attributeOf(tag, "name");
    const type = (attributeOf(tag, "type") ?? "text").toLowerCase();
    if (name === undefined || hasFlag(tag, "disabled")) return [];
    if (SKIPPED_INPUT_TYPES.includes(type)) return [];
    const ticked = TICKED_INPUT_TYPES.includes(type);
    if (ticked && !hasFlag(tag, "checked")) return [];
    const value = attributeOf(tag, "value") ?? (ticked ? "on" : "");
    return [[decodeEntities(name), decodeEntities(value)]];
  });

/** The entries with each named field replaced, and the new names added. */
const withFields = (
  entries: [string, string][],
  fields: Fields,
): [string, string][] => {
  const known = new Set(entries.map(([name]) => name));
  const replaced = entries.map(([name, value]): [string, string | null] => [
    name,
    fields[name] === undefined ? value : fields[name],
  ]);
  const added = Object.entries(fields).filter(([name]) => !known.has(name));
  return [...replaced, ...added].filter(
    (entry): entry is [string, string] => entry[1] !== null,
  );
};

/** Keep each cookie that a response sets, and drop each that it expires. */
const rememberCookies = (
  jar: Map<string, string>,
  response: Response,
): void => {
  for (const line of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = line.split(";");
    const at = pair.indexOf("=");
    if (attributes.some((part) => /^\s*max-age=0\s*$/i.test(part))) {
      jar.delete(pair.slice(0, at));
    } else {
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
};

export const createSiteClient = (origin: string, send: Send): SiteClient => {
  const jar = new Map<string, string>();

  const request = async (path: string, init: RequestInit): Promise<Page> => {
    const headers = new Headers(init.headers);
    if (jar.size > 0) {
      headers.set(
        "cookie",
        [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    const response = await send(
      new Request(`${origin}${path}`, { ...init, headers }),
    );
    rememberCookies(jar, response);
    return {
      html: await response.text(),
      location: response.headers.get("location"),
      status: response.status,
    };
  };

  return {
    get: (path) => request(path, {}),
    submit: async (path, fields, action = path) => {
      const form = formWithAction((await request(path, {})).html, action);
      if (/<form\b[^>]*\senctype="multipart\/form-data"/i.test(form)) {
        throw new Error(`The form with action "${action}" needs multipart.`);
      }
      return request(action, {
        body: new URLSearchParams(
          withFields(inputEntries(form), fields),
        ).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
    },
  };
};
