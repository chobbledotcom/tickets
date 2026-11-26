import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  configureSite,
  type Pace,
  type SitePlan,
} from "#scripts/preview/configure.ts";
import { createSiteClient } from "#scripts/preview/site-client.ts";
import { type FakeSiteOptions, fakeSite } from "./fake-site.ts";

const PLAN: SitePlan = {
  owner: { password: "pw", username: "owner" },
  providers: [
    { fields: { secret: "a" }, id: "sumup" },
    { fields: { secret: "b" }, id: "square" },
  ],
};

const run = async (options: FakeSiteOptions) => {
  const site = fakeSite(options);
  const waits: number[] = [];
  const pace: Pace = {
    attempts: 3,
    delayMs: 1000,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
  const result = await configureSite(
    createSiteClient("https://site.example", site.send),
    PLAN,
    pace,
  );
  return {
    posts: site.calls.filter((call) => call.startsWith("POST")),
    result,
    waits,
  };
};

/** What a run gave: the requests that changed the site, the answer, and how
 * long it waited. */
type Outcome = {
  posts: string[];
  result: { error: string; ok: false } | { ok: true; value: string[] };
  waits: number[];
};

/** A run against a site in some state: its name, the state, and what comes
 * out. Every value is exact. */
/* jscpd:ignore-start -- static data, not code */
const OUTCOMES: [name: string, options: FakeSiteOptions, expected: Outcome][] =
  [
    [
      "sets up a new site, signs in, and saves each provider in order",
      {},
      {
        posts: [
          "POST /setup/",
          "POST /admin/login",
          "POST /admin/settings/payment-provider",
          "POST /admin/settings/sumup",
          "POST /admin/settings/payment-provider",
          "POST /admin/settings/square",
        ],
        result: {
          ok: true,
          value: [
            "Setup completed.",
            "sumup configured.",
            "square configured.",
          ],
        },
        waits: [],
      },
    ],
    [
      "leaves a site that is already set up as it is",
      { setupAnswers: [302] },
      {
        posts: [],
        result: {
          ok: true,
          value: ["Setup was already complete, so the site was left as it is."],
        },
        waits: [],
      },
    ],
    [
      "waits while the site answers with a server error or a missing page",
      { setupAnswers: [503, 404, 200] },
      {
        posts: [
          "POST /setup/",
          "POST /admin/login",
          "POST /admin/settings/payment-provider",
          "POST /admin/settings/sumup",
          "POST /admin/settings/payment-provider",
          "POST /admin/settings/square",
        ],
        result: {
          ok: true,
          value: [
            "Setup completed.",
            "sumup configured.",
            "square configured.",
          ],
        },
        waits: [1000, 1000],
      },
    ],
    [
      "waits while the site cannot be reached",
      { breakFirst: 2 },
      {
        posts: [
          "POST /setup/",
          "POST /admin/login",
          "POST /admin/settings/payment-provider",
          "POST /admin/settings/sumup",
          "POST /admin/settings/payment-provider",
          "POST /admin/settings/square",
        ],
        result: {
          ok: true,
          value: [
            "Setup completed.",
            "sumup configured.",
            "square configured.",
          ],
        },
        waits: [1000, 1000],
      },
    ],
    [
      "gives up with the last status when the site never answers",
      { setupAnswers: [503] },
      {
        posts: [],
        result: {
          error: "The site gave no answer after 3 tries (status 503).",
          ok: false,
        },
        waits: [1000, 1000],
      },
    ],
    [
      "gives up with the network error when the site is never reached",
      { breakFirst: 9 },
      {
        posts: [],
        result: {
          error: "The site gave no answer after 3 tries (fetch failed).",
          ok: false,
        },
        waits: [1000, 1000],
      },
    ],
    [
      "stops when the setup page answers with an unexpected status",
      { setupAnswers: [418] },
      {
        posts: [],
        result: {
          error: "The setup page did not open. The site answered 418.",
          ok: false,
        },
        waits: [],
      },
    ],
    [
      "stops when the setup is refused",
      { setupRefused: true },
      {
        posts: ["POST /setup/"],
        result: {
          error: "Setup was refused. The site answered 302 to /setup/?flash=e.",
          ok: false,
        },
        waits: [],
      },
    ],
    [
      "stops when the owner login is refused",
      { loginRefused: true },
      {
        posts: ["POST /setup/", "POST /admin/login"],
        result: {
          error:
            "The owner login was refused. The site answered 302 to /admin/login?flash=x.",
          ok: false,
        },
        waits: [],
      },
    ],
    [
      "stops when a refused login answers with a page and no redirect",
      { loginRefusedWithPage: true },
      {
        posts: ["POST /setup/", "POST /admin/login"],
        result: {
          error: "The owner login was refused. The site answered 200.",
          ok: false,
        },
        waits: [],
      },
    ],
    [
      "reads the reason from the page when a save answers with no redirect",
      { invalidSave: "sumup" },
      {
        posts: [
          "POST /setup/",
          "POST /admin/login",
          "POST /admin/settings/payment-provider",
          "POST /admin/settings/sumup",
        ],
        result: {
          error:
            "Saving sumup was refused. The site answered 400: Key rejected.",
          ok: false,
        },
        waits: [],
      },
    ],
    [
      "names the reason when the site refuses to choose a provider",
      { refuseSelect: "sumup" },
      {
        posts: [
          "POST /setup/",
          "POST /admin/login",
          "POST /admin/settings/payment-provider",
        ],
        result: {
          error:
            "Choosing sumup was refused. The site answered 302 to /admin/settings?flash=select: Choose the provider for existing payments.",
          ok: false,
        },
        waits: [],
      },
    ],
    [
      "names the reason when the site refuses to save a provider",
      { refuseSave: "square" },
      {
        posts: [
          "POST /setup/",
          "POST /admin/login",
          "POST /admin/settings/payment-provider",
          "POST /admin/settings/sumup",
          "POST /admin/settings/payment-provider",
          "POST /admin/settings/square",
        ],
        result: {
          error:
            "Saving square was refused. The site answered 302 to /admin/settings?flash=save: Key rejected.",
          ok: false,
        },
        waits: [],
      },
    ],
    [
      "stops when a save gives no reason and no test button",
      { silentSave: "sumup" },
      {
        posts: [
          "POST /setup/",
          "POST /admin/login",
          "POST /admin/settings/payment-provider",
          "POST /admin/settings/sumup",
        ],
        result: {
          error:
            "Saving sumup was refused. The site answered 302 to /admin/settings?flash=saved.",
          ok: false,
        },
        waits: [],
      },
    ],
  ];
/* jscpd:ignore-end */

describe("configureSite", () => {
  for (const [name, options, expected] of OUTCOMES) {
    test(name, async () => {
      expect(await run(options)).toEqual(expected);
    });
  }
});
