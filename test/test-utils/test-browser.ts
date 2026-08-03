/**
 * TestBrowser - simulates a human browsing the app by following links and submitting forms.
 *
 * Navigates purely by link text and button text, never by knowing URLs directly.
 * Maintains cookies across requests and follows redirects automatically.
 */

import { map, pipe } from "#fp";
import { escapeForRegex } from "#test-utils/regex.ts";

/** Extract all cookies from a Set-Cookie header and merge into a cookie jar */
const parseCookies = (response: Response, jar: Map<string, string>): void => {
  for (const header of response.headers.getSetCookie()) {
    const eqIdx = header.indexOf("=");
    if (eqIdx === -1) continue;
    const name = header.slice(0, eqIdx);
    const rest = header.slice(eqIdx + 1);
    // Value ends at first ; or end of string
    const semiIdx = rest.indexOf(";");
    const value = semiIdx === -1 ? rest : rest.slice(0, semiIdx);
    if (value === "" || header.includes("Max-Age=0")) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
};

/** Build a Cookie header string from the jar */
const buildCookieHeader = (jar: Map<string, string>): string =>
  [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

/** Strip HTML tags to get plain text content */
const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Decode common HTML entities */
const decodeEntities = (text: string): string =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&larr;/g, "\u2190")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&nbsp;/g, " ");

/** Collect all capture-group matches for a regex against a string */
const regexCollect = <T>(
  re: RegExp,
  html: string,
  transform: (m: RegExpExecArray) => T,
): T[] => {
  const results: T[] = [];
  let m = re.exec(html);
  while (m !== null) {
    results.push(transform(m));
    m = re.exec(html);
  }
  return results;
};

/** Match info for a found link */
type LinkMatch = { href: string; text: string };

/** Find all links in HTML */
const findAllLinks = (html: string): LinkMatch[] =>
  regexCollect(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, html, (m) => ({
    href: decodeEntities(m[1]!),
    text: decodeEntities(stripTags(m[2]!)),
  }));

/** Find a link whose visible text contains the search string (case-insensitive) */
const findLinkByText = (html: string, text: string): LinkMatch | null => {
  const lower = text.toLowerCase();
  return (
    findAllLinks(html).find((l) => l.text.toLowerCase().includes(lower)) ?? null
  );
};

type FormEntry = [name: string, value: string];

const attrValue = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1];

const hasAttr = (tag: string, name: string): boolean =>
  new RegExp(`\\b${name}(?:\\s*=|\\s|>|$)`, "i").test(tag);

const controlName = (tag: string): string | undefined => attrValue(tag, "name");

const controlValue = (tag: string, fallback = ""): string =>
  decodeEntities(attrValue(tag, "value") ?? fallback);

const isDisabled = (tag: string): boolean => hasAttr(tag, "disabled");

const inputType = (tag: string): string =>
  (attrValue(tag, "type") ?? "text").toLowerCase();

const isSuccessfulInput = (tag: string): boolean => {
  if (isDisabled(tag)) return false;
  const type = inputType(tag);
  if (["button", "file", "image", "reset", "submit"].includes(type)) {
    return false;
  }
  if (["checkbox", "radio"].includes(type)) return hasAttr(tag, "checked");
  return true;
};

const formInputEntry = (tag: string): FormEntry | undefined => {
  const name = controlName(tag);
  if (!name || !isSuccessfulInput(tag)) return;
  const defaultValue = ["checkbox", "radio"].includes(inputType(tag))
    ? "on"
    : "";
  return [decodeEntities(name), controlValue(tag, defaultValue)];
};

const formTextareaEntry = (tag: string): FormEntry | undefined => {
  const openTag = tag.match(/^<textarea\b[^>]*>/i)![0];
  const name = controlName(openTag);
  if (!name || isDisabled(openTag)) return;
  const value = tag.match(/^<textarea\b[^>]*>([\s\S]*?)<\/textarea>$/i)![1]!;
  return [decodeEntities(name), decodeEntities(value)];
};

const optionEntry = (
  selectTag: string,
  optionTag: string,
): FormEntry | undefined => {
  const name = controlName(selectTag);
  if (!name || isDisabled(optionTag)) return;
  const text = stripTags(optionTag.match(/>([\s\S]*?)<\/option>$/i)![1]!);
  return [decodeEntities(name), controlValue(optionTag, decodeEntities(text))];
};

const formSelectEntries = (tag: string): FormEntry[] => {
  const openTag = tag.match(/^<select\b[^>]*>/i)![0];
  if (!controlName(openTag) || isDisabled(openTag)) return [];
  const options = regexCollect(
    /<option\b[^>]*>[\s\S]*?<\/option>/gi,
    tag,
    (m) => m[0],
  );
  const selected = options.filter((option) => hasAttr(option, "selected"));
  const submittedOptions = hasAttr(openTag, "multiple")
    ? selected
    : [selected[0] ?? options.find((option) => !isDisabled(option))].filter(
        (option): option is string => option !== undefined,
      );
  const entries: FormEntry[] = [];
  for (const option of submittedOptions) {
    const entry = optionEntry(openTag, option);
    if (entry) entries.push(entry);
  }
  return entries;
};

/** Extract successful form controls in browser submission order. */
export const extractFormEntries = (formHtml: string): FormEntry[] => {
  const entries: FormEntry[] = [];
  const controlRe =
    /<input\b[^>]*>|<select\b[^>]*>[\s\S]*?<\/select>|<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi;
  for (const tag of regexCollect(controlRe, formHtml, (m) => m[0])) {
    if (/^<input\b/i.test(tag)) {
      const entry = formInputEntry(tag);
      if (entry) entries.push(entry);
    } else if (/^<select\b/i.test(tag)) {
      entries.push(...formSelectEntries(tag));
    } else {
      const entry = formTextareaEntry(tag);
      if (entry) entries.push(entry);
    }
  }
  return entries;
};

/** One form on the page: where it sends, what it carries, and how it sends —
 * the method it declares, or the `get` a browser falls back to without one. */
type FormInfo = { action: string; body: string; method: string };

/** Find all forms in HTML, returning where each sends, how, and what it holds */
const findForms = (html: string): FormInfo[] =>
  regexCollect(
    /<form\s([^>]*action="([^"]*)"[^>]*)>([\s\S]*?)<\/form>/gi,
    html,
    (m) => ({
      action: decodeEntities(m[2]!),
      body: m[3]!,
      method: (attrValue(m[1]!, "method") ?? "get").toLowerCase(),
    }),
  );

/** Extract all checkbox values for a given field name from form HTML */
const extractCheckboxValues = (formHtml: string, fieldName: string): string[] =>
  regexCollect(
    new RegExp(
      `<input\\b[^>]*\\sname="${escapeForRegex(fieldName)}"[^>]*>`,
      "gi",
    ),
    formHtml,
    (m) => m[0],
  )
    .filter((tag) => !isDisabled(tag))
    .map((tag) => controlValue(tag, "on"));

/** Sentinel value that tells `appendFormValue` to auto-select every checkbox value. */
export const ALL_CHECKBOXES = "__ALL_CHECKBOXES__";

/**
 * Append a single user-provided form value, first removing any prior entry for
 * the same key. Array values spread across multiple entries; the
 * `__ALL_CHECKBOXES__` sentinel pulls every matching checkbox value from the
 * form HTML (mirroring a user ticking all of them).
 */
const appendFormValue = (
  params: URLSearchParams,
  key: string,
  value: string | string[],
  body: string,
): void => {
  params.delete(key);
  if (Array.isArray(value)) {
    for (const v of value) params.append(key, v);
  } else if (value === ALL_CHECKBOXES) {
    for (const v of extractCheckboxValues(body, key)) {
      params.append(key, v);
    }
  } else {
    params.append(key, value);
  }
};

/** The button on this form a person would press, and what pressing it sends
 * (routes that dispatch on `action` read the button's own name and value).
 * "switched off" when the only buttons with that text cannot be pressed, and
 * nothing when the form has no button with that text at all — plenty of forms
 * are found by their body text instead. */
const buttonToPress = (
  body: string,
  lower: string,
):
  | {
      buttonAction?: string | undefined;
      buttonName?: string | undefined;
      buttonValue?: string;
    }
  | "switched off" => {
  const buttonRe = /<button\b([^>]*?)>([\s\S]*?)<\/button>/gi;
  let switchedOff = false;
  for (const m of regexCollect(buttonRe, body, (x) => x)) {
    if (!stripTags(m[2]!).toLowerCase().trim().includes(lower)) continue;
    const attrs = m[1]!;
    if (isDisabled(attrs)) {
      switchedOff = true;
      continue;
    }
    return {
      // A button may aim the form somewhere else, as a real browser honours.
      // The space boundary keeps a longer attribute like data-formaction out.
      buttonAction: attrs.match(/(?:^|\s)formaction="([^"]+)"/i)?.[1],
      buttonName: attrs.match(/name="([^"]+)"/)?.[1],
      buttonValue: attrValue(attrs, "value") ?? "",
    };
  }
  return switchedOff ? "switched off" : {};
};

/** Find a form whose body contains the given button text, or throw. Also
 * returns the matching button's name/value attributes when present, so the
 * caller can include them in the submission (mirrors how a real browser submits
 * a `<button name="…" value="…">` only when clicked). */
const findFormByButton = (
  forms: FormInfo[],
  buttonText: string,
  fieldNames: string[] = [],
): {
  action: string;
  body: string;
  buttonName?: string | undefined;
  buttonValue?: string | undefined;
} => {
  const lower = buttonText.toLowerCase();
  // A page can serve two forms behind one button wording; the one rendering
  // every field being sent is the one a person filling them in would submit,
  // so it wins whenever any form renders them all. The whitespace before
  // name= keeps a longer attribute like data-name from counting as a field.
  const rendersEveryField = (body: string): boolean =>
    fieldNames.every((field) =>
      new RegExp(`\\sname="${escapeForRegex(field)}"`).test(body),
    );
  const preferred = forms.filter((f) => rendersEveryField(f.body));
  const candidates = preferred.length > 0 ? preferred : forms;
  let switchedOff = false;
  for (const f of candidates) {
    if (!stripTags(f.body).toLowerCase().includes(lower)) continue;
    const pressed = buttonToPress(f.body, lower);
    // A switched-off button here does not settle it: a later form may carry a
    // usable button with the same words, and a real person could press that
    // one. Only give up once every form has been looked at.
    if (pressed === "switched off") {
      switchedOff = true;
      continue;
    }
    const { buttonAction, ...button } = pressed;
    return { action: buttonAction ?? f.action, body: f.body, ...button };
  }
  // Nothing usable anywhere, and at least one button was switched off.
  // Submitting anyway would let a test do something nobody could do.
  if (switchedOff) {
    throw new Error(`The "${buttonText}" button is switched off`);
  }
  const available = forms.map((f) => `  action="${f.action}"`);
  throw new Error(
    `No form found with button text "${buttonText}". Available forms:\n${available.join(
      "\n",
    )}`,
  );
};

/** Always throws — used as a fallback in ?? chains to satisfy the type checker */
const throwNoForm = (): never => {
  throw new Error("No forms found on the current page");
};

/** Format Set-Cookie headers for debug logging */
const formatCookies = (response: Response): string => {
  const setCookies = response.headers.getSetCookie();
  return setCookies.length
    ? ` cookies: ${setCookies.map((c) => c.split(";")[0]).join(", ")}`
    : "";
};

const isRedirect = (status: number): boolean =>
  status === 301 || status === 302 || status === 303;

/** Extract pathname+search from a URL string (absolute or relative) */
const toPath = (url: string): string =>
  url.startsWith("http") ? new URL(url).pathname + new URL(url).search : url;

/**
 * A simulated browser that navigates by following links and submitting forms.
 * It calls handleRequest directly (no network), maintains cookies, and follows redirects.
 */
export class TestBrowser {
  /** Current page URL path */
  currentUrl = "";
  /** Current page HTML content */
  currentHtml = "";
  /** The last redirect target exactly as the server sent it, origin and all.
   * `currentUrl` keeps only the path, so this is what tells an off-site
   * destination (a payment provider) from a same-path local one. Empty when the
   * last request did not redirect. */
  redirectedTo = "";
  /** Cookie jar persisted across requests */
  private cookies = new Map<string, string>();
  /** Lazy-loaded handleRequest function */
  private handleRequest: ((req: Request) => Promise<Response>) | null = null;

  /** Get handleRequest, lazily importing it */
  private async getHandler(): Promise<(req: Request) => Promise<Response>> {
    if (!this.handleRequest) {
      const mod = await import("#routes");
      this.handleRequest = mod.handleRequest;
    }
    return this.handleRequest;
  }

  /** Enable debug logging */
  debug = false;

  /** Build a request with cookies */
  private buildRequest(path: string, options: RequestInit = {}): Request {
    const headers = new Headers(options.headers);
    headers.set("host", "localhost");
    const cookieStr = buildCookieHeader(this.cookies);
    if (cookieStr) headers.set("cookie", cookieStr);
    return new Request(`http://localhost${path}`, {
      ...options,
      headers,
      redirect: "manual",
    });
  }

  /** Send a request, log if debugging, and collect cookies */
  private async send(req: Request, debugLabel: string): Promise<Response> {
    const handler = await this.getHandler();
    const response = await handler(req);
    if (this.debug) {
      console.log(
        `[browser] ${debugLabel} -> ${response.status}${formatCookies(
          response,
        )}`,
      );
    }
    parseCookies(response, this.cookies);
    return response;
  }

  /** Make a request and follow redirects, updating state */
  private async request(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    let currentPath = toPath(path);
    this.redirectedTo = "";
    const req = this.buildRequest(currentPath, options);
    let response = await this.send(req, `${options.method ?? "GET"} ${path}`);

    // Follow redirects (max 10 hops)
    let hops = 0;
    while (isRedirect(response.status) && hops < 10) {
      hops++;
      const location = response.headers.get("location");
      if (!location) break;
      this.redirectedTo = location;
      const nextPath = toPath(location);
      currentPath = nextPath;
      response = await this.send(
        this.buildRequest(nextPath),
        `  -> redirect ${nextPath}`,
      );
    }

    this.currentUrl = currentPath.split("?")[0]!;
    const finalLocation = response.headers.get("location");
    if (finalLocation && isRedirect(response.status)) {
      this.redirectedTo = finalLocation;
      this.currentUrl = toPath(finalLocation).split("?")[0]!;
    }
    this.currentHtml = await response.text();
    return response;
  }

  /**
   * Visit a page by path (GET request).
   * Follows redirects and updates currentHtml/currentUrl.
   * Answers with the status of the page landed on, so a caller wanting both
   * the answer and the words gets them from the one visit.
   */
  async visit(path: string): Promise<number> {
    const response = await this.request(path);
    return response.status;
  }

  /**
   * Ask for a page and return only what the site answered. Nothing is followed
   * and no page state changes, so a caller can tell "you may not" apart from
   * "there is no such page" without ending up somewhere else.
   */
  async statusOf(path: string): Promise<number> {
    const response = await this.send(
      this.buildRequest(toPath(path)),
      `GET ${path}`,
    );
    return response.status;
  }

  /**
   * Click a link by its visible text.
   * Searches the current page HTML for an <a> tag whose text contains the given string.
   * Throws if no matching link is found.
   */
  async clickLink(text: string): Promise<void> {
    const link = findLinkByText(this.currentHtml, text);
    if (!link) {
      const available = pipe(
        map((l: LinkMatch) => `  "${l.text}" -> ${l.href}`),
      )(findAllLinks(this.currentHtml));
      throw new Error(
        `No link found with text "${text}". Available links:\n${available.join(
          "\n",
        )}`,
      );
    }
    await this.visit(link.href);
  }

  /** Find a form by button text and extract its action + hidden fields */
  private findForm(
    buttonText?: string,
    fieldNames: string[] = [],
  ): {
    action: string;
    body: string;
    entries: FormEntry[];
    buttonName?: string | undefined;
    buttonValue?: string | undefined;
  } {
    const forms = findForms(this.currentHtml);
    if (!buttonText) {
      const form = forms[0] ?? throwNoForm();
      return {
        action: form.action,
        body: form.body,
        entries: extractFormEntries(form.body),
      };
    }
    const found = findFormByButton(forms, buttonText, fieldNames);
    return {
      action: found.action,
      body: found.body,
      buttonName: found.buttonName,
      buttonValue: found.buttonValue,
      entries: extractFormEntries(found.body),
    };
  }

  /**
   * Submit a form by providing field data and identifying the form by its submit button text.
   * Auto-includes CSRF token, hidden fields, AND visible input values (select/number/text)
   * found in the form — like a real browser would. User-provided data overrides all
   * auto-collected values. When `buttonText` matches a `<button name="…" value="…">`,
   * that name/value pair is also included (so routes that dispatch on `action` work).
   * For array fields (like checkboxes), pass "all" to auto-select all values,
   * or pass a specific value.
   */
  async submitForm(
    data: Record<string, string | string[]>,
    buttonText?: string,
  ): Promise<void> {
    await this.sendForm(this.findForm(buttonText, Object.keys(data)), data);
  }

  /**
   * The body of the form a person pressing this button would send. Lets a
   * caller check what they are about to fill in against that form alone: a
   * control sitting in some other form on the same page is one this send could
   * never carry, however present it looks on the page as a whole.
   */
  formBodyFor(buttonText: string, fieldNames: string[] = []): string {
    return this.findForm(buttonText, fieldNames).body;
  }

  /**
   * Submit the one form on this page that posts to `action`, the way pressing
   * its own button would: its hidden fields and CSRF token go with it. For a
   * page that renders many identical forms — one arrow per row — where the
   * button's words cannot tell them apart. A page with no such form, or one
   * whose every button is switched off, throws: neither is something a person
   * could have done.
   */
  async submitFormAt(
    action: string,
    data: Record<string, string | string[]> = {},
  ): Promise<void> {
    const form = findForms(this.currentHtml).find((f) => f.action === action);
    if (!form) {
      throw new Error(`No form on this page posts to "${action}"`);
    }
    // A form that declares no method sends by GET, which no route reached this
    // way accepts — so pressing it would go nowhere, whatever this method did.
    if (form.method !== "post") {
      throw new Error(`The form at "${action}" does not send by POST`);
    }
    // Only a submit button submits: a `type="button"` or `type="reset"` one is
    // rendered and pressable but sends nothing, and a browser has no default
    // for a missing type other than submit.
    const pressable = regexCollect(
      /<button\b([^>]*?)>/gi,
      form.body,
      (m) => m[1]!,
    ).filter(
      (attrs) =>
        !isDisabled(attrs) &&
        (attrValue(attrs, "type") ?? "submit").toLowerCase() === "submit",
    );
    if (pressable.length === 0) {
      throw new Error(`The form posting to "${action}" cannot be submitted`);
    }
    await this.sendForm(
      { action, body: form.body, entries: extractFormEntries(form.body) },
      data,
    );
  }

  /** Build one form's submission the way a browser does — its own successful
   * controls first, then the pressed button, then whatever the caller typed —
   * and post it. */
  private async sendForm(
    form: {
      action: string;
      body: string;
      entries: FormEntry[];
      buttonName?: string | undefined;
      buttonValue?: string | undefined;
    },
    data: Record<string, string | string[]>,
  ): Promise<void> {
    const { action, body, entries, buttonName, buttonValue } = form;

    // Build the form body as URLSearchParams
    const params = new URLSearchParams();

    // Add successful controls first (a real browser submits these in DOM order)
    for (const [key, value] of entries) {
      params.append(key, value);
    }
    // Then the clicked button's name/value (matches real browser behavior)
    if (buttonName && buttonValue !== undefined) {
      params.delete(buttonName);
      params.append(buttonName, buttonValue);
    }

    // Add user-provided data (overrides everything)
    for (const [key, value] of Object.entries(data)) {
      appendFormValue(params, key, value, body);
    }

    await this.request(action, {
      body: params.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
  }

  /** Get the current page text content (HTML tags stripped) */
  get pageText(): string {
    return decodeEntities(stripTags(this.currentHtml));
  }

  /** Check if the current page contains the given text (tag-stripped, case-insensitive) */
  containsText(text: string): boolean {
    return this.pageText.toLowerCase().includes(text.toLowerCase());
  }

  /** Find a link's href by its visible text, without navigating */
  findLink(text: string): string | null {
    return findLinkByText(this.currentHtml, text)?.href ?? null;
  }

  /** Debug: expose cookie jar entries */
  debugCookies(): Map<string, string> {
    return new Map(this.cookies);
  }

  /** Find all links on the current page */
  get links(): LinkMatch[] {
    return findAllLinks(this.currentHtml);
  }

  /**
   * Download a URL and return the raw bytes (for binary content like .zip files).
   * Does NOT update currentHtml/currentUrl.
   */
  async downloadBytes(path: string): Promise<Uint8Array> {
    const handler = await this.getHandler();
    const req = this.buildRequest(toPath(path));
    const response = await handler(req);
    parseCookies(response, this.cookies);
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Submit a multipart form with a file attachment.
   * Used for file upload forms (e.g. backup restore).
   * Finds the form by button text, auto-includes CSRF token and hidden fields.
   */
  async submitFormWithFile(
    fileField: string,
    fileName: string,
    fileData: Uint8Array,
    data: Record<string, string> = {},
    buttonText?: string,
  ): Promise<void> {
    const { action, entries } = this.findForm(buttonText);
    const formData = new FormData();

    for (const [key, value] of entries) {
      formData.append(key, value);
    }
    for (const [key, value] of Object.entries(data)) {
      formData.delete(key);
      formData.append(key, value);
    }
    formData.append(
      fileField,
      new File([fileData.buffer as ArrayBuffer], fileName),
    );

    await this.request(action, {
      body: formData,
      method: "POST",
    });
  }
}
