import type { Send } from "#scripts/preview/site-client.ts";

export type FakeSiteOptions = {
  /** Fail this many setup page requests with a network error first. */
  breakFirst?: number;
  loginRefused?: boolean;
  /** A refused login answers with a page and no redirect. */
  loginRefusedWithPage?: boolean;
  /** Saving this provider answers with an error page and no redirect. */
  invalidSave?: string;
  /** Choosing this provider is refused. */
  refuseSelect?: string;
  /** Saving this provider is refused, with a reason. */
  refuseSave?: string;
  /** Saving this provider answers with a redirect and saves nothing. */
  silentSave?: string;
  /** The status of each setup page request, in order. The last one repeats.
   * 200 is the open setup form, and 302 is a site that is set up. */
  setupAnswers?: number[];
  setupRefused?: boolean;
};

const FORM_TOKEN = '<input type="hidden" name="csrfToken" value="t1">';

const page = (html: string, status = 200): Response =>
  new Response(html, { headers: { "content-type": "text/html" }, status });

const redirect = (location: string): Response =>
  new Response("", { headers: { location }, status: 302 });

const NOTICES: Record<string, string> = {
  save: '<div class="error" role="alert">Key rejected.</div>',
  select:
    '<div class="error" role="alert">Choose the provider for existing payments.</div>',
};

/** A site that answers the pages of the setup, the login, and the settings,
 * and keeps what the setup saves. */
export const fakeSite = (options: FakeSiteOptions = {}) => {
  const calls: string[] = [];
  const configured = new Set<string>();
  let active = "none";
  let broken = options.breakFirst ?? 0;
  let setupRequests = 0;
  let setupDone = false;

  const setupAnswer = (): Response => {
    const answers = options.setupAnswers ?? [200];
    const status = answers[Math.min(setupRequests, answers.length - 1)];
    setupRequests += 1;
    if (setupDone || status === 302) return redirect("/");
    if (status !== 200) return page("not ready", status);
    return page(
      `<form method="post" action="/setup/">${FORM_TOKEN}<input type="text" name="adminUsername"></form>`,
    );
  };

  const settingsPage = (query: URLSearchParams): Response => {
    const notice = NOTICES[query.get("flash") ?? ""] ?? "";
    const credentials =
      active === "none"
        ? ""
        : `<form method="post" action="/admin/settings/${active}">${FORM_TOKEN}<input type="password" name="secret"></form>${
            configured.has(active)
              ? `<button id="${active}-test-btn">Test</button>`
              : ""
          }`;
    return page(
      `${notice}<form method="post" action="/admin/settings/payment-provider">${FORM_TOKEN}<input type="radio" name="paymentProvider" value="none"${active === "none" ? " checked" : ""}></form>${credentials}`,
    );
  };

  const choose = async (request: Request): Promise<Response> => {
    const id = new URLSearchParams(await request.text()).get("paymentProvider");
    if (id === options.refuseSelect)
      return redirect("/admin/settings?flash=select");
    active = id as string;
    return redirect("/admin/settings?flash=chosen");
  };

  const save = (id: string): Response => {
    if (id === options.invalidSave) return page(NOTICES.save as string, 400);
    if (id === options.refuseSave)
      return redirect("/admin/settings?flash=save");
    if (id !== options.silentSave) configured.add(id);
    return redirect("/admin/settings?flash=saved");
  };

  const openSetup = (): Response => {
    if (broken > 0) {
      broken -= 1;
      throw new TypeError("fetch failed");
    }
    return setupAnswer();
  };

  const completeSetup = (): Response => {
    if (options.setupRefused) return redirect("/setup/?flash=e");
    setupDone = true;
    return redirect("/setup/complete");
  };

  const logIn = (): Response =>
    options.loginRefusedWithPage
      ? page("wrong login")
      : redirect(
          options.loginRefused ? "/admin/login?flash=x" : "/admin?flash=y",
        );

  const loginPage = (): Response =>
    page(`<form method="post" action="/admin/login">${FORM_TOKEN}</form>`);

  type Route = [
    key: string,
    handler: (
      request: Request,
      query: URLSearchParams,
    ) => Response | Promise<Response>,
  ];

  const routes: Route[] = [
    ["GET /setup/", openSetup],
    ["POST /setup/", completeSetup],
    ["GET /admin/", loginPage],
    ["POST /admin/login", logIn],
    ["GET /admin/settings", (_request, query) => settingsPage(query)],
    ["POST /admin/settings/payment-provider", choose],
  ];

  const send: Send = async (request) => {
    const { pathname, searchParams } = new URL(request.url);
    const key = `${request.method} ${pathname}`;
    calls.push(key);
    const route = routes.find(([routeKey]) => routeKey === key);
    return route === undefined
      ? save(pathname.split("/").pop() as string)
      : await route[1](request, searchParams);
  };

  return { calls, configured, send };
};
