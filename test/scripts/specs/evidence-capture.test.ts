import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isAllowedEvidenceRequest,
  resolveEvidencePath,
} from "#scripts/specs/evidence/browser.ts";
import { defineEvidenceCapture } from "#scripts/specs/evidence/capture-flow.ts";
import type { EvidenceCaptureDeclaration } from "#scripts/specs/evidence/schema.ts";
import { requireValue } from "#shared/required-value.ts";
import { validFeature } from "#test/scripts/specs/profile-fixture.ts";
import {
  compileEvidenceFeature,
  PAYMENT_RESULT_CAPTURE as declaration,
} from "./evidence-fixture.ts";

interface CaptureCalls {
  attachments: Array<{
    bytes: Uint8Array;
    options: { fileName: string; mediaType: "image/png" };
  }>;
  browserClosed: number;
  browserContexts: unknown[];
  captures: Array<{ element: string | undefined; page: unknown }>;
  contextClosed: number;
  continued: string[];
  cookies: unknown[];
  css: string[];
  goto: unknown[];
  page: unknown;
  serverClosed: number;
  timeout: number[];
  waited: number;
}

interface CaptureFixtureOptions {
  blockedUrl?: string;
  browserCloseError?: Error;
  captureError?: Error;
  contextCloseError?: Error;
  cookie?: string;
  declarations?: readonly EvidenceCaptureDeclaration[];
  feature?: string;
  hookPickle?: number;
  launchError?: Error;
  serverCloseError?: Error;
}

const twoCaseFeature = validFeature.replace(
  /\n`?$/,
  `

    @case:payment.place-unavailable
    Scenario: Payment is confirmed after the last place is taken
      Given a paid listing has no places left
      When a customer payment is confirmed
      Then the customer receives a clear refusal
`,
);

const captureFixture = (
  options: CaptureFixtureOptions = {},
): {
  calls: CaptureCalls;
  capture: ReturnType<typeof defineEvidenceCapture>;
  hook: Parameters<ReturnType<typeof defineEvidenceCapture>>[1];
  world: Parameters<ReturnType<typeof defineEvidenceCapture>>[0];
} => {
  const fixture = compileEvidenceFeature(options.feature ?? validFeature);
  const calls: CaptureCalls = {
    attachments: [],
    browserClosed: 0,
    browserContexts: [],
    captures: [],
    contextClosed: 0,
    continued: [],
    cookies: [],
    css: [],
    goto: [],
    page: null,
    serverClosed: 0,
    timeout: [],
    waited: 0,
  };
  let routeRequest: ((url: string) => Promise<void>) | undefined;
  const page = {
    goto: (path: string, navigation: unknown) => {
      calls.goto.push({ navigation, path });
      return Promise.resolve(null);
    },
    setDefaultTimeout: (timeout: number) => {
      calls.timeout.push(timeout);
    },
  };
  calls.page = page;
  const context = {
    addCookies: (cookies: unknown[]) => {
      calls.cookies.push(...cookies);
      return Promise.resolve();
    },
    close: () => {
      calls.contextClosed += 1;
      return options.contextCloseError
        ? Promise.reject(options.contextCloseError)
        : Promise.resolve();
    },
    newPage: () => Promise.resolve(page),
    route: (_pattern: string, handler: (route: never) => Promise<void>) => {
      routeRequest = async (url: string) => {
        let continued = false;
        await handler({
          abort: (reason: string) => {
            if (reason !== "blockedbyclient") {
              throw new Error(`Unexpected block reason ${reason}`);
            }
            return Promise.resolve();
          },
          continue: () => {
            continued = true;
            calls.continued.push(url);
            return Promise.resolve();
          },
          request: () => ({ url: () => url }),
        } as never);
        if (url.startsWith("http://127.0.0.1") && !continued) {
          throw new Error(`Allowed request was blocked: ${url}`);
        }
      };
      return Promise.resolve();
    },
  };
  const browser = {
    close: () => {
      calls.browserClosed += 1;
      return options.browserCloseError
        ? Promise.reject(options.browserCloseError)
        : Promise.resolve();
    },
    newContext: (browserContext: unknown) => {
      calls.browserContexts.push(browserContext);
      return Promise.resolve(context);
    },
  };
  const capture = defineEvidenceCapture({
    capturePage: async (page, element) => {
      calls.captures.push({ element, page });
      if (!routeRequest) throw new Error("Evidence route was not installed");
      await routeRequest(
        options.blockedUrl ?? "http://127.0.0.1:4321/icons.svg",
      );
      if (options.captureError) throw options.captureError;
      return { png: new Uint8Array([1, 2, 3]) };
    },
    declarations: options.declarations ?? [declaration],
    getCookie: () =>
      Promise.resolve(options.cookie ?? "session=secret; Path=/"),
    launchBrowser: () =>
      options.launchError
        ? Promise.reject(options.launchError)
        : Promise.resolve(browser as never),
    readCatalog: () => Promise.resolve(fixture.catalog),
    readTheme: () => Promise.resolve(":root { --test-colour: blue; }"),
    startServer: () => ({
      baseUrl: "http://127.0.0.1:4321",
      close: () => {
        calls.serverClosed += 1;
        return options.serverCloseError
          ? Promise.reject(options.serverCloseError)
          : Promise.resolve();
      },
    }),
    waitForPage: () => {
      calls.waited += 1;
      return Promise.resolve();
    },
    writeCss: (css) => {
      calls.css.push(css);
      return Promise.resolve();
    },
  });
  return {
    calls,
    capture,
    hook: {
      gherkinDocument: fixture.document,
      pickle: requireValue(
        fixture.pickles[options.hookPickle ?? 0],
        "Evidence Pickle is missing",
      ),
    },
    world: {
      attach: (data, attachmentOptions) => {
        calls.attachments.push({
          bytes: new Uint8Array(data),
          options: attachmentOptions,
        });
      },
      evidenceValues: new Map([["paymentId", "42"]]),
    },
  };
};

const expectCaptureClosed = (calls: CaptureCalls): void => {
  expect({
    browser: calls.browserClosed,
    context: calls.contextClosed,
    server: calls.serverClosed,
  }).toEqual({ browser: 1, context: 1, server: 1 });
};

const errorMessages = (error: unknown): string[] =>
  error instanceof AggregateError
    ? error.errors.flatMap(errorMessages)
    : [String(error)];

describe("Cucumber evidence browser boundary", () => {
  test("fills encoded World values into a declared path", () => {
    expect(
      resolveEvidencePath(
        "/admin/servicing/{servicingEventId}/{label}",
        new Map([
          ["servicingEventId", "42"],
          ["label", "floor treatment"],
        ]),
      ),
    ).toBe("/admin/servicing/42/floor%20treatment");
  });

  test("fails when a declared path value was not set by the scenario", () => {
    expect(() =>
      resolveEvidencePath("/admin/servicing/{servicingEventId}", new Map()),
    ).toThrow("Evidence World value servicingEventId was not set");
  });

  test("allows only the scenario server and inline data", () => {
    const baseUrl = "http://127.0.0.1:3100";
    expect(isAllowedEvidenceRequest(baseUrl, `${baseUrl}/admin/`)).toBe(true);
    expect(
      isAllowedEvidenceRequest(baseUrl, "data:image/png;base64,AAAA"),
    ).toBe(true);
    expect(
      isAllowedEvidenceRequest(baseUrl, "https://example.com/font.woff2"),
    ).toBe(false);
  });
});

describe("Cucumber evidence capture", () => {
  test("captures the declared page through the shared browser lifecycle", async () => {
    const { calls, capture, hook, world } = captureFixture();

    await capture(world, hook);

    expect(calls.browserContexts).toEqual([
      {
        baseURL: "http://127.0.0.1:4321",
        colorScheme: "light",
        deviceScaleFactor: 2,
        locale: "en-GB",
        reducedMotion: "reduce",
        timezoneId: "UTC",
        viewport: { height: 844, width: 390 },
      },
    ]);
    expect(calls.cookies).toEqual([
      {
        name: "session",
        url: "http://127.0.0.1:4321",
        value: "secret",
      },
    ]);
    expect(calls.goto).toEqual([
      {
        navigation: { waitUntil: "domcontentloaded" },
        path: "/admin/payments/42",
      },
    ]);
    expect(calls.timeout).toEqual([60_000]);
    expect(calls.waited).toBe(1);
    expect(calls.captures.map(({ element }) => element)).toEqual([
      "#payment-result",
    ]);
    expect(calls.captures[0]?.page).toBe(calls.page);
    expect(calls.continued).toEqual(["http://127.0.0.1:4321/icons.svg"]);
    expect(calls.css[0]).toContain("--test-colour: blue");
    expect(calls.attachments).toEqual([
      {
        bytes: new Uint8Array([1, 2, 3]),
        options: {
          fileName: "payment-result--mobile.png",
          mediaType: "image/png",
        },
      },
    ]);
    expectCaptureClosed(calls);
  });

  test("rejects a request blocked while the screenshot is being prepared", async () => {
    const { calls, capture, hook, world } = captureFixture({
      blockedUrl: "https://example.com/tracker.js",
    });

    await expect(capture(world, hook)).rejects.toThrow(
      "Evidence page requested blocked URLs: https://example.com/tracker.js",
    );
    expect(calls.attachments).toEqual([]);
    expectCaptureClosed(calls);
  });

  test("rejects malformed owner cookies", async () => {
    for (const cookie of ["", "=secret", "session="]) {
      const { capture, hook, world } = captureFixture({ cookie });
      await expect(capture(world, hook)).rejects.toThrow(
        "Test owner cookie is malformed",
      );
    }
  });

  test("rejects a scenario without a declared capture before opening IO", async () => {
    const { calls, capture, hook, world } = captureFixture({
      feature: twoCaseFeature,
      hookPickle: 1,
    });

    await expect(capture(world, hook)).rejects.toThrow(
      "No evidence capture declared for @case:payment.place-unavailable",
    );
    expect(calls.serverClosed).toBe(0);
  });

  test("closes the server when the browser cannot launch", async () => {
    const { calls, capture, hook, world } = captureFixture({
      launchError: new Error("browser failed"),
    });

    await expect(capture(world, hook)).rejects.toThrow("browser failed");
    expect(calls.browserClosed).toBe(0);
    expect(calls.serverClosed).toBe(1);
  });

  test("closes the context browser and server when capture fails", async () => {
    const { calls, capture, hook, world } = captureFixture({
      captureError: new Error("capture failed"),
    });

    await expect(capture(world, hook)).rejects.toThrow("capture failed");
    expectCaptureClosed(calls);
  });

  test("closes the server when browser cleanup fails", async () => {
    const { calls, capture, hook, world } = captureFixture({
      browserCloseError: new Error("browser close failed"),
    });

    await expect(capture(world, hook)).rejects.toThrow("browser close failed");
    expect(calls.serverClosed).toBe(1);
  });

  test("reports capture and cleanup failures together", async () => {
    const { calls, capture, hook, world } = captureFixture({
      browserCloseError: new Error("browser close failed"),
      captureError: new Error("capture failed"),
      contextCloseError: new Error("context close failed"),
      serverCloseError: new Error("server close failed"),
    });

    const error = await capture(world, hook).catch((reason) => reason);
    expect(errorMessages(error)).toEqual([
      "Error: capture failed",
      "Error: context close failed",
      "Error: browser close failed",
      "Error: server close failed",
    ]);
    expectCaptureClosed(calls);
  });
});
