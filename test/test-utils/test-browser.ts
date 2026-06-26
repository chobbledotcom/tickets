/**
 * TestBrowser - simulates a human browsing the app by following links and submitting forms.
 *
 * Navigates purely by link text and button text, never by knowing URLs directly.
 * Maintains cookies across requests and follows redirects automatically.
 */

import { map, pipe } from "#fp";

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
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    results.push(transform(m));
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
  if (!name || !isSuccessfulInput(tag)) return undefined;
  const defaultValue = ["checkbox", "radio"].includes(inputType(tag))
    ? "on"
    : "";
  return [decodeEntities(name), controlValue(tag, defaultValue)];
};

const formTextareaEntry = (tag: string): FormEntry | undefined => {
  const openTag = tag.match(/^<textarea\b[^>]*>/i)?.[0] ?? "";
  const name = controlName(openTag);
  if (!name || isDisabled(openTag)) return undefined;
  const value =
    tag.match(/^<textarea\b[^>]*>([\s\S]*?)<\/textarea>$/i)?.[1] ?? "";
  return [decodeEntities(name), decodeEntities(value)];
};

const optionEntry = (
  selectTag: string,
  optionTag: string,
): FormEntry | undefined => {
  const name = controlName(selectTag);
  if (!name || isDisabled(optionTag)) return undefined;
  const text = stripTags(optionTag.match(/>([\s\S]*?)<\/option>$/i)?.[1] ?? "");
  return [decodeEntities(name), controlValue(optionTag, decodeEntities(text))];
};

const formSelectEntries = (tag: string): FormEntry[] => {
  const openTag = tag.match(/^<select\b[^>]*>/i)?.[0] ?? "";
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

type FormInfo = { action: string; body: string };

/** Find all forms in HTML, returning their action and body */
const findForms = (html: string): FormInfo[] =>
  regexCollect(
    /<form\s[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/gi,
    html,
    (m) => ({ action: decodeEntities(m[1]!), body: m[2]! }),
  );

/** Extract all checkbox values for a given field name from form HTML */
const extractCheckboxValues = (formHtml: string, fieldName: string): string[] =>
  regexCollect(
    new RegExp(`<input\\b[^>]*name="${fieldName}"[^>]*>`, "gi"),
    formHtml,
    (m) => m[0],
  )
    .filter((tag) => !isDisabled(tag))
    .map((tag) => controlValue(tag, "on"));

/** Sentinel value that tells `appendFormValue` to auto-select every checkbox value. */
const ALL_CHECKBOXES = "__ALL_CHECKBOXES__";

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

/** Find a form whose body contains the given button text, or throw.
 * Also returns the matching button's name/value attributes when present,
 * so the caller can include them in the submission (mirrors how a real
 * browser submits a `<button name="…" value="…">` only when clicked). */
const findFormByButton = (
  forms: FormInfo[],
  buttonText: string,
): {
  action: string;
  body: string;
  buttonName?: string;
  buttonValue?: string;
} => {
  const lower = buttonText.toLowerCase();
  for (const f of forms) {
    if (!stripTags(f.body).toLowerCase().includes(lower)) continue;
    // Try to find the specific button with this text and extract its
    // name/value attributes (used by routes that dispatch on `action`).
    const buttonRe = /<button\b([^>]*?)>([\s\S]*?)<\/button>/gi;
    for (const m of regexCollect(buttonRe, f.body, (x) => x)) {
      const btnText = stripTags(m[2]!).toLowerCase().trim();
      if (btnText.includes(lower)) {
        const attrs = m[1] ?? "";
        if (isDisabled(attrs)) continue;
        const nameMatch = attrs.match(/name="([^"]+)"/);
        return {
          action: f.action,
          body: f.body,
          buttonName: nameMatch?.[1],
          buttonValue: attrValue(attrs, "value") ?? "",
        };
      }
    }
    return { action: f.action, body: f.body };
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
    const req = this.buildRequest(currentPath, options);
    let response = await this.send(req, `${options.method ?? "GET"} ${path}`);

    // Follow redirects (max 10 hops)
    let hops = 0;
    while (isRedirect(response.status) && hops < 10) {
      hops++;
      const location = response.headers.get("location");
      if (!location) break;
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
      this.currentUrl = toPath(finalLocation).split("?")[0]!;
    }
    this.currentHtml = await response.text();
    return response;
  }

  /**
   * Visit a page by path (GET request).
   * Follows redirects and updates currentHtml/currentUrl.
   */
  async visit(path: string): Promise<void> {
    await this.request(path);
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
  private findForm(buttonText?: string): {
    action: string;
    body: string;
    entries: FormEntry[];
    buttonName?: string;
    buttonValue?: string;
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
    const found = findFormByButton(forms, buttonText);
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
    const { action, body, entries, buttonName, buttonValue } =
      this.findForm(buttonText);

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

  /** Extract all checkbox values for a given field name from the current page */
  getCheckboxValues(fieldName: string): string[] {
    return extractCheckboxValues(this.currentHtml, fieldName);
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
