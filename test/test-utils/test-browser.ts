/**
 * TestBrowser - simulates a human browsing the app by following links and submitting forms.
 *
 * Navigates purely by link text and button text, never by knowing URLs directly.
 * Maintains cookies across requests and follows redirects automatically.
 */

import { map, pipe } from "#fp";
import type { FormEntry, FormInfo } from "#test-utils/test-browser/forms.ts";
import {
  appendFormValue,
  attrValue,
  extractFormEntries,
  findFormByButton,
  findForms,
  isDisabled,
  pressingSends,
  throwNoForm,
} from "#test-utils/test-browser/forms.ts";
import type { LinkMatch } from "#test-utils/test-browser/parsing.ts";
import {
  decodeEntities,
  findAllLinks,
  findLinkByText,
  regexCollect,
  stripTags,
} from "#test-utils/test-browser/parsing.ts";

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
    const forms = findForms(this.currentHtml);
    // Every button on a form somebody could press, and where pressing each one
    // really goes. Only a submit button submits: a `type="button"` or
    // `type="reset"` one is rendered and pressable but sends nothing. A button
    // may override its own form's address and method, so its word wins; a form
    // declaring no method sends by GET, which no route reached this way takes.
    const pressableOn = (form: FormInfo) =>
      regexCollect(/<button\b([^>]*?)>/gi, form.body, (m) => m[1]!)
        .filter((attrs) => !isDisabled(attrs) && pressingSends(attrs))
        .map((attrs) => ({
          goesTo: attrValue(attrs, "formaction") ?? form.action,
          name: attrValue(attrs, "name"),
          sentBy: (attrValue(attrs, "formmethod") ?? form.method).toLowerCase(),
          value: attrValue(attrs, "value") ?? "",
        }));
    // The form somebody pressing their way to this address would really be on
    // — which is not always the one declaring it, since a button can aim its
    // form somewhere else.
    for (const form of forms) {
      const pressed = pressableOn(form).find(
        ({ goesTo, sentBy }) => goesTo === action && sentBy === "post",
      );
      if (!pressed) continue;
      return await this.sendForm(
        {
          action,
          body: form.body,
          buttonName: pressed.name,
          buttonValue: pressed.value,
          entries: extractFormEntries(form.body),
        },
        data,
      );
    }
    // Nothing posts there. Which of the three ways it failed decides what to
    // say, so a story is told what is actually wrong with the page.
    const declared = forms.find((f) => f.action === action);
    if (!declared) {
      throw new Error(`No form on this page posts to "${action}"`);
    }
    if (pressableOn(declared).length === 0) {
      throw new Error(`The form posting to "${action}" cannot be submitted`);
    }
    throw new Error(`No button on the form at "${action}" posts there`);
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
    // Then the clicked button's own name and value. It is added, never swapped
    // in: a browser sends every successful control *and* the button, so a form
    // carrying a hidden field of the same name sends both values, not one.
    if (buttonName && buttonValue !== undefined) {
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
