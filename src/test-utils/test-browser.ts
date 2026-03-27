/**
 * TestBrowser - simulates a human browsing the app by following links and submitting forms.
 *
 * Navigates purely by link text and button text, never by knowing URLs directly.
 * Maintains cookies across requests and follows redirects automatically.
 */

import { pipe, map } from "#fp";

/** Extract all cookies from a Set-Cookie header and merge into a cookie jar */
const parseCookies = (
  response: Response,
  jar: Map<string, string>,
): void => {
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
  html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

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

/** Match info for a found link */
type LinkMatch = { href: string; text: string };

/** Find all links in HTML */
const findAllLinks = (html: string): LinkMatch[] => {
  const results: LinkMatch[] = [];
  const re = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    results.push({
      href: decodeEntities(m[1]!),
      text: stripTags(m[2]!),
    });
  }
  return results;
};

/** Find a link whose visible text contains the search string (case-insensitive) */
const findLinkByText = (html: string, text: string): LinkMatch | null => {
  const lower = text.toLowerCase();
  return findAllLinks(html).find((l) => l.text.toLowerCase().includes(lower)) ?? null;
};

/** Extract all hidden input fields from a form */
const extractHiddenInputs = (formHtml: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const re = /<input[^>]*type="hidden"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formHtml)) !== null) {
    const tag = m[0];
    const nameMatch = tag.match(/name="([^"]+)"/);
    const valueMatch = tag.match(/value="([^"]*)"/);
    if (nameMatch) {
      result[nameMatch[1]!] = decodeEntities(valueMatch?.[1] ?? "");
    }
  }
  return result;
};

/** Find all forms in HTML, returning their action and body */
const findForms = (html: string): Array<{ action: string; body: string }> => {
  const results: Array<{ action: string; body: string }> = [];
  const re = /<form\s[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    results.push({ action: decodeEntities(m[1]!), body: m[2]! });
  }
  return results;
};

/** Extract all checkbox values for a given field name from form HTML */
const extractCheckboxValues = (
  formHtml: string,
  fieldName: string,
): string[] => {
  const results: string[] = [];
  const re = new RegExp(
    `<input[^>]*name="${fieldName}"[^>]*value="([^"]*)"[^>]*>`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(formHtml)) !== null) {
    results.push(decodeEntities(m[1]!));
  }
  return results;
};

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

  /** Make a request and follow redirects, updating state */
  private async request(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const handler = await this.getHandler();
    const headers = new Headers(options.headers);
    headers.set("host", "localhost");
    const cookieStr = buildCookieHeader(this.cookies);
    if (cookieStr) headers.set("cookie", cookieStr);

    const url = path.startsWith("http") ? path : `http://localhost${path}`;
    const req = new Request(url, { ...options, headers, redirect: "manual" });
    let response = await handler(req);

    if (this.debug) {
      const setCookies = response.headers.getSetCookie();
      console.log(`[browser] ${options.method ?? "GET"} ${path} -> ${response.status}${setCookies.length ? ` cookies: ${setCookies.map(c => c.split(";")[0]).join(", ")}` : ""}`);
    }

    // Collect cookies from every response
    parseCookies(response, this.cookies);

    // Follow redirects (max 10 hops)
    let hops = 0;
    while (
      (response.status === 301 ||
        response.status === 302 ||
        response.status === 303) &&
      hops < 10
    ) {
      hops++;
      const location = response.headers.get("location");
      if (!location) break;
      const nextPath = location.startsWith("http")
        ? new URL(location).pathname + new URL(location).search
        : location;
      const nextHeaders = new Headers();
      nextHeaders.set("host", "localhost");
      const nextCookie = buildCookieHeader(this.cookies);
      if (nextCookie) nextHeaders.set("cookie", nextCookie);
      const nextReq = new Request(`http://localhost${nextPath}`, {
        headers: nextHeaders,
        redirect: "manual",
      });
      response = await handler(nextReq);
      if (this.debug) {
        const setCookies = response.headers.getSetCookie();
        console.log(`[browser]   -> redirect ${nextPath} -> ${response.status}${setCookies.length ? ` cookies: ${setCookies.map(c => c.split(";")[0]).join(", ")}` : ""}`);
      }
      parseCookies(response, this.cookies);
    }

    this.currentUrl = new URL(response.url || `http://localhost${path}`).pathname;
    // Try to read the response body - capture the final URL from redirect chain
    const finalLocation = response.headers.get("location");
    if (finalLocation && (response.status === 301 || response.status === 302 || response.status === 303)) {
      this.currentUrl = finalLocation.startsWith("http")
        ? new URL(finalLocation).pathname
        : finalLocation;
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
        `No link found with text "${text}". Available links:\n${available.join("\n")}`,
      );
    }
    await this.visit(link.href);
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
    const forms = findForms(this.currentHtml);
    if (forms.length === 0) {
      throw new Error("No forms found on the current page");
    }

    // Find the form containing the button text
    let form: { action: string; body: string } | undefined;
    if (buttonText) {
      const lower = buttonText.toLowerCase();
      form = forms.find((f) => {
        const text = stripTags(f.body).toLowerCase();
        return text.includes(lower);
      });
      if (!form) {
        const available = forms.map((f) => `  action="${f.action}"`);
        throw new Error(
          `No form found with button text "${buttonText}". Available forms:\n${available.join("\n")}`,
        );
      }
    } else {
      form = forms[0];
    }

    // Collect hidden fields (includes csrf_token)
    const hiddenFields = extractHiddenInputs(form.body);

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
        const values = extractCheckboxValues(form.body, key);
        for (const v of values) {
          params.append(key, v);
        }
      } else {
        params.append(key, value);
      }
    }

    await this.request(form.action, {
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
}
