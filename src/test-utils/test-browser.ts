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
    text: stripTags(m[2]!),
  }));

/** Find a link whose visible text contains the search string (case-insensitive) */
const findLinkByText = (html: string, text: string): LinkMatch | null => {
  const lower = text.toLowerCase();
  return (
    findAllLinks(html).find((l) => l.text.toLowerCase().includes(lower)) ?? null
  );
};

/** Extract all hidden input fields from a form */
const extractHiddenInputs = (formHtml: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const tag of regexCollect(
    /<input[^>]*type="hidden"[^>]*>/gi,
    formHtml,
    (m) => m[0],
  )) {
    const nameMatch = tag.match(/name="([^"]+)"/);
    const valueMatch = tag.match(/value="([^"]*)"/);
    if (nameMatch) {
      result[nameMatch[1]!] = decodeEntities(valueMatch?.[1] ?? "");
    }
  }
  return result;
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
    new RegExp(
      `<input[^>]*name="${fieldName}"[^>]*value="([^"]*)"[^>]*>`,
      "gi",
    ),
    formHtml,
    (m) => decodeEntities(m[1]!),
  );

/** Find a form whose body contains the given button text, or throw */
const findFormByButton = (forms: FormInfo[], buttonText: string): FormInfo => {
  const lower = buttonText.toLowerCase();
  const form = forms.find((f) =>
    stripTags(f.body).toLowerCase().includes(lower),
  );
  if (form) return form;
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
      // biome-ignore lint/suspicious/noConsole: debug logging for test browser
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
    const req = this.buildRequest(toPath(path), options);
    let response = await this.send(req, `${options.method ?? "GET"} ${path}`);

    // Follow redirects (max 10 hops)
    let hops = 0;
    while (isRedirect(response.status) && hops < 10) {
      hops++;
      const location = response.headers.get("location");
      if (!location) break;
      const nextPath = toPath(location);
      response = await this.send(
        this.buildRequest(nextPath),
        `  -> redirect ${nextPath}`,
      );
    }

    this.currentUrl = new URL(
      response.url || `http://localhost${path}`,
    ).pathname;
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
    hiddenFields: Record<string, string>;
  } {
    const forms = findForms(this.currentHtml);
    const form = buttonText
      ? findFormByButton(forms, buttonText)
      : (forms[0] ?? throwNoForm());
    return {
      action: form.action,
      body: form.body,
      hiddenFields: extractHiddenInputs(form.body),
    };
  }

  /**
   * Submit a form by providing field data and identifying the form by its submit button text.
   * Auto-includes CSRF token and any hidden fields found in the form.
   * For array fields (like checkboxes), pass "all" to auto-select all values,
   * or pass a specific value.
   */
  async submitForm(
    data: Record<string, string | string[]>,
    buttonText?: string,
  ): Promise<void> {
    const { action, body, hiddenFields } = this.findForm(buttonText);

    // Build the form body as URLSearchParams
    const params = new URLSearchParams();

    // Add hidden fields first
    for (const [key, value] of Object.entries(hiddenFields)) {
      params.append(key, value);
    }

    // Add user-provided data (overrides hidden fields)
    for (const [key, value] of Object.entries(data)) {
      // Remove any hidden field with the same name first
      if (hiddenFields[key] !== undefined) {
        params.delete(key);
      }
      if (Array.isArray(value)) {
        for (const v of value) {
          params.append(key, v);
        }
      } else if (value === "__ALL_CHECKBOXES__") {
        // Auto-select all checkbox values for this field
        const values = extractCheckboxValues(body, key);
        for (const v of values) {
          params.append(key, v);
        }
      } else {
        params.append(key, value);
      }
    }

    await this.request(action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
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
    const { action, hiddenFields } = this.findForm(buttonText);
    const formData = new FormData();

    for (const [key, value] of Object.entries(hiddenFields)) {
      formData.append(key, value);
    }
    for (const [key, value] of Object.entries(data)) {
      formData.append(key, value);
    }
    formData.append(
      fileField,
      new File([fileData.buffer as ArrayBuffer], fileName),
    );

    await this.request(action, {
      method: "POST",
      body: formData,
    });
  }
}
