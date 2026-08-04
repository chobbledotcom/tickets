import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { TestBrowser } from "#test-utils/test-browser.ts";
import { useHandler } from "./helpers.ts";

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

  /** A site whose "/away" bounces the visitor off to another host entirely. */
  const OFF_SITE = "https://elsewhere.test/checkout";
  const browserSentOffSite = (): TestBrowser => {
    const browser = new TestBrowser();
    useHandler(browser, (request) =>
      new URL(request.url).pathname === "/away"
        ? new Response(null, { headers: { location: OFF_SITE }, status: 303 })
        : new Response("arrived"),
    );
    return browser;
  };

  it("keeps the redirect target's origin, which currentUrl drops", async () => {
    const browser = browserSentOffSite();

    await browser.visit("/away");

    // The same path served locally must be tellable apart from the off-site one.
    expect(browser.currentUrl).toBe("/checkout");
    expect(browser.redirectedTo).toBe(OFF_SITE);
  });

  it("reports a refusal without going anywhere", async () => {
    const browser = new TestBrowser();
    useHandler(browser, (request) =>
      new URL(request.url).pathname === "/secret"
        ? new Response("no", { status: 403 })
        : new Response("arrived"),
    );
    await browser.visit("/home");

    const answered = await browser.statusOf("/secret");

    // The refusal is reported, and the browser is still where it was — a story
    // asking whether a page is theirs must not be moved onto it.
    expect(answered).toBe(403);
    expect(browser.currentUrl).toBe("/home");
    expect(browser.currentHtml).toBe("arrived");
  });

  it("does not follow a redirect when only reading what a page answered", async () => {
    const browser = new TestBrowser();
    useHandler(browser, (request) =>
      new URL(request.url).pathname === "/moved"
        ? new Response(null, {
            headers: { location: "/elsewhere" },
            status: 302,
          })
        : new Response("elsewhere"),
    );

    expect(await browser.statusOf("/moved")).toBe(302);
  });

  it("forgets an earlier redirect target once a request does not redirect", async () => {
    const browser = browserSentOffSite();

    await browser.visit("/away");
    await browser.visit("/straight-there");

    expect(browser.redirectedTo).toBe("");
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

describe("TestBrowser requests", () => {
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
});
