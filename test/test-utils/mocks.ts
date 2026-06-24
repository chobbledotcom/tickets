import { afterEach, beforeEach } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bracket } from "#fp";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { getSessionCookieName } from "#shared/cookies.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { runWithStorageConfig } from "#shared/storage.ts";
import type { TestRequestOptions } from "#test-utils/internal.ts";

export const mockRequestWithHost = (
  path: string,
  host: string,
  options: RequestInit = {},
): Request => {
  const headers = new Headers(options.headers);
  headers.set("host", host);
  return new Request(`http://${host}${path}`, { ...options, headers });
};

export const mockRequest = (path: string, options: RequestInit = {}): Request =>
  mockRequestWithHost(path, "localhost", options);

export const mockFormRequest = (
  path: string,
  data: Record<string, string>,
  cookie?: string,
): Request => {
  const body = new URLSearchParams(data).toString();
  const headers: HeadersInit = {
    "content-type": "application/x-www-form-urlencoded",
    host: "localhost",
  };
  if (cookie) {
    headers.cookie = cookie;
  }
  return new Request(`http://localhost${path}`, {
    body,
    headers,
    method: "POST",
  });
};

/** Build a JSON API `Request` (no auth) for passing to `handleRequest`. */
export const jsonRequest = (
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Request => {
  const { method = "GET", body } = options;
  const headers: Record<string, string> = { host: "localhost" };
  const init: RequestInit = { headers, method };
  if (body) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
};

export const mockAdminLoginRequest = async (
  data: Record<string, string>,
  csrfToken?: string,
): Promise<Request> => {
  const token = csrfToken ?? (await signCsrfToken());
  return mockFormRequest("/admin/login", { ...data, csrf_token: token });
};

export const mockMultipartRequest = (
  path: string,
  data: Record<string, string>,
  cookie?: string,
  file?: {
    name: string;
    fieldName: string;
    data: Uint8Array;
    contentType: string;
  },
): Request => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(data)) {
    formData.append(key, value);
  }
  if (file) {
    // deno-lint-ignore no-explicit-any
    const blob = new Blob([file.data as any], { type: file.contentType });
    formData.append(file.fieldName, blob, file.name);
  }
  const headers: HeadersInit = { host: "localhost" };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost${path}`, {
    body: formData,
    headers,
    method: "POST",
  });
};

export const mockWebhookRequest = (
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request =>
  new Request("http://localhost/payment/webhook", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "localhost",
      ...headers,
    },
    method: "POST",
  });

export const mockSetupFormRequest = (
  data: Record<string, string>,
  csrfToken: string,
): Request => {
  return mockFormRequest("/setup", {
    accept_agreement: "yes",
    ...data,
    csrf_token: csrfToken,
  });
};

export const mockTicketFormRequest = (
  slug: string,
  data: Record<string, string>,
  csrfToken: string,
): Request => {
  return mockFormRequest(`/ticket/${slug}`, {
    ...data,
    csrf_token: csrfToken,
  });
};

export const urlFromFetchInput = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

export const withExpectedError = bracket(
  () => {
    Deno.env.set("TEST_EXPECT_ERROR", "1");
  },
  () => {
    Deno.env.delete("TEST_EXPECT_ERROR");
  },
);

export const withFetchMock = bracket(
  () => globalThis.fetch,
  (original) => {
    globalThis.fetch = original;
  },
);

interface Restorable {
  restore?: (() => void) | undefined;
}

export const withMocks = async <
  T extends Restorable | Record<string, Restorable>,
>(
  setup: () => T,
  body: (mocks: T) => void | Promise<void>,
  cleanup?: () => void | Promise<void>,
): Promise<void> => {
  const mocks = setup();
  try {
    await body(mocks);
  } finally {
    if (typeof (mocks as Restorable).restore === "function") {
      (mocks as Restorable).restore?.();
    } else {
      for (const mock of Object.values(mocks as Record<string, Restorable>)) {
        mock.restore?.();
      }
    }
    await cleanup?.();
  }
};

export const withMockBunnyCdnApi = async (
  overrides: Partial<typeof bunnyCdnApi>,
  fn: () => Promise<void>,
): Promise<void> => {
  const originals: Partial<typeof bunnyCdnApi> = {};
  for (const key of Object.keys(overrides) as (keyof typeof bunnyCdnApi)[]) {
    // deno-lint-ignore no-explicit-any
    originals[key] = bunnyCdnApi[key] as any;
    // deno-lint-ignore no-explicit-any
    bunnyCdnApi[key] = overrides[key] as any;
  }
  try {
    await fn();
  } finally {
    Object.assign(bunnyCdnApi, originals);
  }
};

export const installUrlHandler = (
  fallback: typeof globalThis.fetch,
  handler: (url: string, init?: RequestInit) => Promise<Response> | null,
): void => {
  globalThis.fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = urlFromFetchInput(input);
    return handler(url, init) ?? fallback(input, init);
  };
};

export const testRequest = (
  path: string,
  token?: string | null,
  options: TestRequestOptions = {},
): Request => {
  const { cookie, method, data } = options;
  const headers: Record<string, string> = { host: "localhost" };

  if (token) {
    headers.cookie = `${getSessionCookieName()}=${token}`;
  } else if (cookie) {
    headers.cookie = cookie;
  }

  if (data) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    return new Request(`http://localhost${path}`, {
      body: new URLSearchParams(data).toString(),
      headers,
      method: method ?? "POST",
    });
  }

  return new Request(`http://localhost${path}`, {
    headers,
    method: method ?? "GET",
  });
};

export const awaitTestRequest = async (
  path: string,
  tokenOrOptions?: string | TestRequestOptions | null,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  if (typeof tokenOrOptions === "object" && tokenOrOptions !== null) {
    return handleRequest(testRequest(path, null, tokenOrOptions));
  }
  return handleRequest(testRequest(path, tokenOrOptions));
};

export const successResponse =
  (status: number, body?: string) => (): Response =>
    new Response(body ?? null, { status });

export const errorResponse =
  (status: number) =>
  (error: string): Response =>
    new Response(error, { status });

export const cdnOkResponse = (): Response =>
  new Response(null, { status: 201 });

export const withStorageMock = (
  fn: (fetchCalls: string[]) => Promise<void>,
): Promise<void> =>
  runWithStorageConfig({ zoneKey: "testkey", zoneName: "testzone" }, () =>
    withFetchMock(async (originalFetch) => {
      const fetchCalls: string[] = [];
      installUrlHandler(originalFetch, (url) => {
        fetchCalls.push(url);
        if (url.includes("storage.bunnycdn.com") || url.includes("b-cdn.net")) {
          return Promise.resolve(cdnOkResponse());
        }
        return null;
      });
      await fn(fetchCalls);
    }),
  );

export const withCdnProxy = (
  respond: () => Response,
  fn: () => Promise<void>,
): Promise<void> =>
  runWithStorageConfig({ zoneKey: "testkey", zoneName: "testzone" }, () =>
    withFetchMock(async (originalFetch) => {
      installUrlHandler(originalFetch, (url) =>
        url.includes("storage.bunnycdn.com")
          ? Promise.resolve(respond())
          : null,
      );
      await fn();
    }),
  );

export const withCdnRejecting = (
  error: Error,
  fn: () => Promise<void>,
): Promise<void> =>
  runWithStorageConfig({ zoneKey: "testkey", zoneName: "testzone" }, () =>
    withFetchMock(async (originalFetch) => {
      installUrlHandler(originalFetch, (url) =>
        url.includes("storage.bunnycdn.com") ? Promise.reject(error) : null,
      );
      await fn();
    }),
  );

export const withStorageDisabled = <T>(fn: () => T): T =>
  runWithStorageConfig({ localPath: "", zoneKey: "", zoneName: "" }, fn);

export const withStorageEnabled = <T>(fn: () => T): T =>
  runWithStorageConfig({ zoneKey: "testkey", zoneName: "testzone" }, fn);

export const withLocalStorageEnabled = async <T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> => {
  const dir = await Deno.makeTempDir();
  try {
    return await runWithStorageConfig(
      { localPath: dir, zoneKey: "", zoneName: "" },
      () => fn(dir),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

export const mockProviderType = (
  type: import("#shared/payments.ts").PaymentProviderType,
): import("#shared/payments.ts").PaymentProviderType | null => type;

export const stubFetchJson = (body: unknown) =>
  stub(globalThis, "fetch", () =>
    Promise.resolve(new Response(JSON.stringify(body))),
  );

/** Stub `fetch` to always resolve with a `Response` of the given status/body. */
export const stubFetchStatus = (status: number, body: BodyInit | null = null) =>
  stub(globalThis, "fetch", () =>
    Promise.resolve(new Response(body, { status })),
  );

export const stubFetchRecorder = (responseInit?: ResponseInit) => {
  const calls: import("#test-utils/internal.ts").FetchCall[] = [];
  const fetchStub = stub(
    globalThis,
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ init, url: String(input) });
      return Promise.resolve(
        new Response(null, { status: 204, ...responseInit }),
      );
    },
  );
  return { calls, restore: () => fetchStub.restore() };
};

export const useFetchStub = () => {
  // deno-lint-ignore no-explicit-any
  type FetchStubRef = { current: any };
  const ref: FetchStubRef = { current: null };
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    ref.current = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response()),
    );
  });

  afterEach(() => {
    ref.current.restore();
    globalThis.fetch = originalFetch;
  });

  const restubFetch = (impl: () => Promise<Response>): void => {
    ref.current.restore();
    ref.current = stub(globalThis, "fetch", impl);
  };

  const callCount = (): number => ref.current.calls.length;

  const getFetchArgs = (index = 0): [string, RequestInit] =>
    ref.current.calls[index].args as [string, RequestInit];

  const getFetchJsonBody = (index = 0) =>
    JSON.parse(getFetchArgs(index)[1].body as string);

  const getFetchFormBody = (index = 0): FormData =>
    getFetchArgs(index)[1].body as FormData;

  const getFetchHeaders = (index = 0): Record<string, string> =>
    getFetchArgs(index)[1].headers as Record<string, string>;

  const findCallBodyByRecipient = (recipient: string) => {
    const call = ref.current.calls.find((c: { args: unknown[] }) => {
      const body = JSON.parse(
        (c.args as [string, RequestInit])[1].body as string,
      );
      return body.to?.[0] === recipient;
    });
    return JSON.parse((call.args as [string, RequestInit])[1].body as string);
  };

  const allRecipients = (): string[][] =>
    ref.current.calls.map(
      (c: { args: unknown[] }) =>
        JSON.parse((c.args as [string, RequestInit])[1].body as string).to,
    );

  return {
    allRecipients,
    callCount,
    findCallBodyByRecipient,
    getFetchArgs,
    getFetchFormBody,
    getFetchHeaders,
    getFetchJsonBody,
    restubFetch,
  };
};

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const randomString = (length: number): string => {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};
