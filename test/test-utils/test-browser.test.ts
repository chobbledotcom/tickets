import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { extractFormEntries, TestBrowser } from "#test-utils/test-browser.ts";

const paramsFromEntries = (html: string): URLSearchParams =>
  new URLSearchParams(extractFormEntries(html));

const useHandler = (
  browser: TestBrowser,
  handler: (request: Request) => Response | Promise<Response>,
): void => {
  (
    browser as unknown as {
      handleRequest: (request: Request) => Promise<Response>;
    }
  ).handleRequest = (request) => Promise.resolve(handler(request));
};

describe("TestBrowser form defaults", () => {
  it("submits checked checkboxes and radios with repeated default values", () => {
    const params = paramsFromEntries(`
      <input type="checkbox" name="features" value="email" checked>
      <input type="checkbox" name="features" value="sms">
      <input type="checkbox" name="features" value="push" checked>
      <input type="checkbox" name="implicit" checked>
      <input type="radio" name="plan" value="basic">
      <input type="radio" name="plan" value="pro" checked>
    `);

    expect(params.getAll("features")).toEqual(["email", "push"]);
    expect(params.get("implicit")).toBe("on");
    expect(params.get("plan")).toBe("pro");
  });

  it("keeps repeated successful text-like, select, and textarea controls", () => {
    const params = paramsFromEntries(`
      <input type="hidden" name="token" value="abc">
      <input name="tag" value="first">
      <input name="tag" value="second">
      <select name="choices" multiple>
        <option value="a" selected>A</option>
        <option value="b">B</option>
        <option value="c" selected>C</option>
      </select>
      <textarea name="notes">Hello &amp; goodbye</textarea>
    `);

    expect(params.get("token")).toBe("abc");
    expect(params.getAll("tag")).toEqual(["first", "second"]);
    expect(params.getAll("choices")).toEqual(["a", "c"]);
    expect(params.get("notes")).toBe("Hello & goodbye");
  });

  it("excludes disabled controls across supported control types", () => {
    const params = paramsFromEntries(`
      <input name="enabled" value="yes">
      <input name="disabled_text" value="no" disabled>
      <input type="hidden" name="disabled_hidden" value="no" disabled>
      <input type="checkbox" name="disabled_checkbox" value="no" checked disabled>
      <input type="radio" name="disabled_radio" value="no" checked disabled>
      <select name="disabled_select" disabled><option value="no" selected>No</option></select>
      <textarea name="disabled_textarea" disabled>No</textarea>
      <button name="ignored" value="no">Submit</button>
    `);

    expect([...params.keys()]).toEqual(["enabled"]);
  });

  it("uses the first enabled option for a single select with no explicit selection", () => {
    const params = paramsFromEntries(`
      <select name="status">
        <option value="disabled" disabled>Disabled</option>
        <option value="draft">Draft</option>
        <option>Published &amp; live</option>
      </select>
    `);

    expect(params.get("status")).toBe("draft");
  });

  it("preserves empty values and ignores non-successful input types", () => {
    const params = paramsFromEntries(`
      <input name="empty" value="">
      <input type="" name="blank_type" value="kept">
      <input type="checkbox" name="empty_checkbox" value="" checked>
      <input type="submit" name="submit_input" value="ignored">
      <input type="file" name="file_input" value="ignored">
      <textarea name="empty_notes"></textarea>
      <select name="choices" multiple>
        <option value="enabled" selected>Enabled</option>
        <option value="disabled" selected disabled>Disabled</option>
      </select>
    `);

    expect(params.get("empty")).toBe("");
    expect(params.get("blank_type")).toBe("kept");
    expect(params.get("empty_checkbox")).toBe("");
    expect(params.has("submit_input")).toBe(false);
    expect(params.has("file_input")).toBe(false);
    expect(params.get("empty_notes")).toBe("");
    expect(params.getAll("choices")).toEqual(["enabled"]);
  });
});

describe("TestBrowser navigation", () => {
  it("parses short, valueless, and expired cookies precisely", async () => {
    const browser = new TestBrowser();
    const seen: string[] = [];
    useHandler(browser, (request) => {
      seen.push(request.headers.get("cookie") ?? "");
      return new Response("ok", {
        headers: new Headers([
          ["set-cookie", "a=1"],
          ["set-cookie", "empty=; Path=/"],
          ["set-cookie", "expired=gone; Max-Age=0; Path=/"],
        ]),
      });
    });

    await browser.visit("/cookies");
    await browser.visit("/cookies");

    expect(seen).toEqual(["", "a=1"]);
    expect([...browser.debugCookies().entries()]).toEqual([["a", "1"]]);
  });

  it("ignores malformed Set-Cookie headers without an equals sign", async () => {
    const browser = new TestBrowser();
    useHandler(
      browser,
      () =>
        new Response("ok", {
          headers: new Headers([["set-cookie", "flagonly"]]),
        }),
    );

    await browser.visit("/bad-cookie");

    expect([...browser.debugCookies().entries()]).toEqual([]);
  });

  it("follows redirects, stores cookies, sends them back, and clears expired cookies", async () => {
    const browser = new TestBrowser();
    const seen: string[] = [];
    useHandler(browser, (request) => {
      const url = new URL(request.url);
      seen.push(
        `${request.method} ${url.pathname} ${
          request.headers.get("cookie") ?? ""
        }`,
      );
      if (url.pathname === "/start") {
        return new Response(null, {
          headers: new Headers([
            ["location", "/next?from=start"],
            ["set-cookie", "session=abc; Path=/"],
            ["set-cookie", "theme=dark; Path=/"],
          ]),
          status: 302,
        });
      }
      return new Response("<h1>Arrived</h1>", {
        headers: new Headers([["set-cookie", "session=; Max-Age=0; Path=/"]]),
      });
    });

    await browser.visit("/start");

    expect(seen).toEqual(["GET /start ", "GET /next session=abc; theme=dark"]);
    expect(browser.currentUrl).toBe("/next");
    expect(browser.currentHtml).toBe("<h1>Arrived</h1>");
    expect([...browser.debugCookies().entries()]).toEqual([["theme", "dark"]]);
  });

  it("normalizes absolute redirect locations and replaces the previous URL", async () => {
    const browser = new TestBrowser();
    browser.currentUrl = "/before";
    const seen: string[] = [];
    useHandler(browser, (request) => {
      const url = new URL(request.url);
      seen.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/absolute") {
        return new Response(null, {
          headers: { location: "https://example.test/done?x=1" },
          status: 303,
        });
      }
      return new Response("done");
    });

    await browser.visit("/absolute");

    expect(seen).toEqual(["/absolute", "/done?x=1"]);
    expect(browser.currentUrl).toBe("/done");
  });

  it("follows permanent redirects", async () => {
    const browser = new TestBrowser();
    const seen: string[] = [];
    useHandler(browser, (request) => {
      const path = new URL(request.url).pathname;
      seen.push(path);
      return path === "/old"
        ? new Response(null, { headers: { location: "/new" }, status: 301 })
        : new Response("new");
    });

    await browser.visit("/old");

    expect(seen).toEqual(["/old", "/new"]);
    expect(browser.currentUrl).toBe("/new");
  });

  it("keeps the redirecting URL when a redirect response has no Location", async () => {
    const browser = new TestBrowser();
    useHandler(browser, () => new Response("missing", { status: 302 }));

    await browser.visit("/missing-location");

    expect(browser.currentUrl).toBe("/missing-location");
    expect(browser.currentHtml).toBe("missing");
  });

  it("ignores Location headers on non-redirect responses", async () => {
    const browser = new TestBrowser();
    useHandler(
      browser,
      () =>
        new Response("not a redirect", {
          headers: { location: "/should-not-use" },
          status: 200,
        }),
    );

    await browser.visit("/plain");

    expect(browser.currentUrl).toBe("/plain");
  });

  it("stops following redirects after ten hops", async () => {
    const browser = new TestBrowser();
    let requests = 0;
    useHandler(browser, () => {
      requests += 1;
      return new Response("loop", {
        headers: { location: "/loop" },
        status: 302,
      });
    });

    await browser.visit("/loop");

    expect(requests).toBe(11);
    expect(browser.currentUrl).toBe("/loop");
  });

  it("finds links by decoded visible text and navigates to the href", async () => {
    const browser = new TestBrowser();
    const visited: string[] = [];
    useHandler(browser, (request) => {
      const path = new URL(request.url).pathname;
      visited.push(path);
      return new Response(`<main>${path}</main>`);
    });
    browser.currentHtml = `
      <a href="/admin?tab=1">Admin &amp; tools</a>
      <a href="/reports"><span>Monthly</span> report</a>
    `;

    expect(browser.links).toEqual([
      { href: "/admin?tab=1", text: "Admin & tools" },
      { href: "/reports", text: "Monthly report" },
    ]);
    expect(browser.findLink("TOOLS")).toBe("/admin?tab=1");

    await browser.clickLink("monthly");

    expect(visited).toEqual(["/reports"]);
    expect(browser.currentUrl).toBe("/reports");
    expect(browser.containsText("reports")).toBe(true);
  });

  it("returns empty link hrefs distinctly from missing links", () => {
    const browser = new TestBrowser();
    browser.currentHtml = '<a href="">Same page</a>';

    expect(browser.findLink("Same page")).toBe("");
    expect(browser.findLink("Missing")).toBe(null);
  });

  it("reports available links when link navigation fails", async () => {
    const browser = new TestBrowser();
    browser.currentHtml = '<a href="/one">First link</a>';

    await expect(browser.clickLink("missing")).rejects.toThrow(
      'No link found with text "missing". Available links:\n  "First link" -> /one',
    );
  });

  it("lazily loads the real request handler when none is injected", async () => {
    const browser = new TestBrowser();

    await browser.visit("/health");

    expect(browser.currentUrl).toBe("/health");
    expect(browser.currentHtml).toBe("Up :)");
  });
});

describe("TestBrowser forms", () => {
  it("sends localhost as the host header", async () => {
    const browser = new TestBrowser();
    let host: string | null = null;
    useHandler(browser, (request) => {
      host = request.headers.get("host");
      return new Response("ok");
    });

    await browser.visit("/host");

    expect(host).toBe("localhost");
  });

  const captureConsoleLog = async (
    fn: (browser: TestBrowser) => Promise<void>,
  ): Promise<{ browser: TestBrowser; messages: string[] }> => {
    const browser = new TestBrowser();
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      messages.push(args.join(" "));
    };
    try {
      await fn(browser);
    } finally {
      console.log = originalLog;
    }
    return { browser, messages };
  };

  it("logs request details when debug mode is enabled", async () => {
    const { messages } = await captureConsoleLog(async (b) => {
      b.debug = true;
      useHandler(
        b,
        () =>
          new Response("ok", {
            headers: new Headers([["set-cookie", "debug=yes; Path=/"]]),
          }),
      );
      await b.visit("/debug");
    });

    expect(messages).toEqual([
      "[browser] GET /debug -> 200 cookies: debug=yes",
    ]);
  });

  it("logs without a cookie suffix when no cookies are set", async () => {
    const { messages } = await captureConsoleLog(async (b) => {
      b.debug = true;
      useHandler(b, () => new Response("ok"));
      await b.visit("/debug-empty");
    });

    expect(messages).toEqual(["[browser] GET /debug-empty -> 200"]);
  });

  it("does not log request details by default", async () => {
    const { messages } = await captureConsoleLog(async (b) => {
      useHandler(b, () => new Response("ok"));
      await b.visit("/quiet");
    });

    expect(messages).toEqual([]);
  });

  it("submits successful controls, clicked button data, and user overrides", async () => {
    const browser = new TestBrowser();
    let posted:
      | {
          body: string;
          contentType: string | null;
          method: string;
          path: string;
        }
      | undefined;
    useHandler(browser, async (request) => {
      posted = {
        body: await request.text(),
        contentType: request.headers.get("content-type"),
        method: request.method,
        path: new URL(request.url).pathname,
      };
      return new Response("<p>saved</p>");
    });
    browser.currentHtml = `
      <form action="/save">
        <input type="hidden" name="csrf_token" value="csrf">
        <input type="hidden" name="action" value="stale">
        <input name="name" value="Original">
        <input type="checkbox" name="features" value="email" checked>
        <input type="checkbox" name="features" value="sms">
        <input type="checkbox" name="features" value="push">
        <select name="status"><option value="draft">Draft</option></select>
        <textarea name="notes">From form</textarea>
        <button name="action" value="draft">Save draft</button>
        <button name="action" value="publish">Publish</button>
      </form>
    `;

    await browser.submitForm(
      {
        features: "__ALL_CHECKBOXES__",
        name: "Updated",
        notes: ["line one", "line two"],
      },
      "Publish",
    );

    const params = new URLSearchParams(posted!.body);
    expect(posted).toMatchObject({
      contentType: "application/x-www-form-urlencoded",
      method: "POST",
      path: "/save",
    });
    expect(params.get("csrf_token")).toBe("csrf");
    expect(params.get("name")).toBe("Updated");
    expect(params.getAll("features")).toEqual(["email", "sms", "push"]);
    expect(params.get("status")).toBe("draft");
    expect(params.getAll("notes")).toEqual(["line one", "line two"]);
    expect(params.get("action")).toBe("publish");
    expect(browser.currentHtml).toBe("<p>saved</p>");
  });

  it("submits the first form when no button text is supplied", async () => {
    const browser = new TestBrowser();
    let postedPath = "";
    useHandler(browser, async (request) => {
      postedPath = new URL(request.url).pathname;
      return new Response(await request.text());
    });
    browser.currentHtml = `
      <form action="/first"><input name="first" value="1"></form>
      <form action="/second"><input name="second" value="2"></form>
    `;

    await browser.submitForm({});

    expect(postedPath).toBe("/first");
    expect(browser.currentHtml).toBe("first=1");
  });

  it("throws clearly when submitting without button text and the page has no forms", async () => {
    const browser = new TestBrowser();
    browser.currentHtml = "<main>No forms here</main>";

    await expect(browser.submitForm({})).rejects.toThrow(
      "No forms found on the current page",
    );
  });

  const setupFormSubmit = (): {
    browser: TestBrowser;
    getParams: () => URLSearchParams;
  } => {
    const browser = new TestBrowser();
    let posted = "";
    useHandler(browser, async (request) => {
      posted = await request.text();
      return new Response("saved");
    });
    return { browser, getParams: () => new URLSearchParams(posted) };
  };

  it("skips disabled matching buttons and submits the form without button data", async () => {
    const { browser, getParams } = setupFormSubmit();
    browser.currentHtml = `
      <form action="/disabled-button">
        <input name="title" value="Draft">
        <button name="action" value="publish" disabled>Publish</button>
      </form>
    `;

    await browser.submitForm({}, "Publish");

    const params = getParams();
    expect(params.get("title")).toBe("Draft");
    expect(params.has("action")).toBe(false);
  });

  it("selects a form by body text even when no button text matches", async () => {
    const browser = new TestBrowser();
    let postedPath = "";
    let posted = "";
    useHandler(browser, async (request) => {
      postedPath = new URL(request.url).pathname;
      posted = await request.text();
      return new Response("saved");
    });
    browser.currentHtml = `
      <form action="/body-text">
        <p>Publish this draft</p>
        <input name="title" value="Draft">
        <button name="action" value="save">Save</button>
      </form>
    `;

    await browser.submitForm({}, "Publish");

    const params = new URLSearchParams(posted);
    expect(postedPath).toBe("/body-text");
    expect(params.get("title")).toBe("Draft");
    expect(params.has("action")).toBe(false);
  });

  it("does not submit nameless button values", async () => {
    const { browser, getParams } = setupFormSubmit();
    browser.currentHtml = `
      <form action="/save">
        <input name="title" value="Draft">
        <button value="publish">Publish</button>
      </form>
    `;

    await browser.submitForm({}, "Publish");

    const params = getParams();
    expect(params.get("title")).toBe("Draft");
    expect(params.has("undefined")).toBe(false);
  });

  it("throws with available form actions when no button matches", async () => {
    const browser = new TestBrowser();
    browser.currentHtml = `
      <form action="/first"><button>Save</button></form>
      <form action="/second"><button>Delete</button></form>
    `;

    await expect(browser.submitForm({}, "Publish")).rejects.toThrow(
      'No form found with button text "Publish". Available forms:\n  action="/first"\n  action="/second"',
    );
  });

  it("downloads bytes without changing the current page", async () => {
    const browser = new TestBrowser();
    browser.currentHtml = "<p>before</p>";
    browser.currentUrl = "/before";
    useHandler(browser, (request) => {
      expect(new URL(request.url).pathname).toBe("/file.zip");
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: new Headers([["set-cookie", "download=yes; Path=/"]]),
      });
    });

    const bytes = await browser.downloadBytes("/file.zip");

    expect([...bytes]).toEqual([1, 2, 3]);
    expect(browser.currentHtml).toBe("<p>before</p>");
    expect(browser.currentUrl).toBe("/before");
    expect([...browser.debugCookies().entries()]).toEqual([
      ["download", "yes"],
    ]);
  });

  it("submits multipart form entries and file uploads", async () => {
    const browser = new TestBrowser();
    let formData: FormData | undefined;
    useHandler(browser, async (request) => {
      formData = await request.formData();
      return new Response("<p>uploaded</p>");
    });
    browser.currentHtml = `
      <form action="/upload">
        <input type="hidden" name="csrf_token" value="csrf">
        <input name="title" value="Original">
        <button>Upload</button>
      </form>
    `;

    await browser.submitFormWithFile(
      "backup",
      "backup.zip",
      new Uint8Array([4, 5, 6]),
      { title: "Updated" },
      "Upload",
    );

    expect(formData!.get("csrf_token")).toBe("csrf");
    expect(formData!.get("title")).toBe("Updated");
    const file = formData!.get("backup");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("backup.zip");
    expect([...new Uint8Array(await (file as File).arrayBuffer())]).toEqual([
      4, 5, 6,
    ]);
    expect(browser.currentHtml).toBe("<p>uploaded</p>");
  });
});
