/**
 * The happy-dom page the payment "Test Connection" tests drive.
 *
 * The script is browser code — it reads `document` and `fetch` from the
 * global scope — so every test installs a fresh window plus a scripted
 * `fetch`, boots the script, and presses the real button. The server renders
 * the answer's words, so the fixture carries only the state labels the page
 * ships as data attributes.
 */

import { afterEach } from "@std/testing/bdd";
import { initPaymentTestButtons } from "#src/ui/client/admin/payment-test-buttons.ts";
import {
  createDomInstaller,
  createGlobalStash,
} from "#test-utils/happy-dom.ts";

/** The words the settings page puts on the button. */
export const SAVE_LABEL = "Test connection";

/** The parts of a DOM element these tests read. */
export type PageElement = {
  classList: { contains: (name: string) => boolean };
  click: () => void;
  disabled: boolean;
  textContent: string;
};

/** One scripted answer: what the endpoint says, or how it fails, and an
 * optional gate for reading the page while the request is still out. */
export type Reply = {
  data?: { lines: string[]; ok: boolean };
  throws?: Error;
  hold?: PromiseWithResolvers<void>;
};

/** What the endpoint says to each press, in order. The last one answers
 * every press after it, so one answer serves a test that presses once. */
export type Script = readonly [Reply, ...Reply[]];

export type Page = {
  asked: { body: string; url: string }[];
  button: PageElement;
  result: PageElement;
};

/** One provider's credentials form as the settings page renders it, with
 * the state labels the page ships beside the controls. */
const formHtml = (provider: string, withToken: boolean): string => `
  <form id="settings-${provider}">
    ${withToken ? `<input name="csrf_token" type="hidden" value="token-${provider}" />` : ""}
    <button class="secondary" data-testing="Testing..." id="${provider}-test-btn" type="button">${SAVE_LABEL}</button>
    <div class="hidden" data-failed="Connection test failed:" id="${provider}-test-result"></div>
  </form>`;

/** Let every pending answer settle before reading the result box. */
export const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Install the page and take it down again. Call it inside a `describe` so
 * the teardown belongs to that suite rather than the whole file. `bare`
 * boots the script over a page carrying no test button at all. */
export const usePaymentButtonPage = (): {
  bare: (html: string) => void;
  open: (
    provider: string,
    script: Script,
    withToken?: boolean,
    html?: (provider: string, withToken: boolean) => string,
  ) => Page;
  press: (
    provider: string,
    reply: Reply,
  ) => Promise<Page & { lines: string[] }>;
} => {
  const stash = createGlobalStash();
  const dom = createDomInstaller(["HTMLButtonElement"]);

  afterEach(async () => {
    stash.restore();
    await dom.cleanup();
  });

  /** Boot the script over one provider's form, with `fetch` scripted. */
  const open = (
    provider: string,
    [first, ...rest]: Script,
    withToken = true,
    html: (provider: string, withToken: boolean) => string = formHtml,
  ) => {
    const window = dom.installDom(html(provider, withToken));
    const asked: { body: string; url: string }[] = [];
    const queue = [first, ...rest];
    let reply: Reply = first;
    stash.set("fetch", async (url: unknown, init: { body: string }) => {
      asked.push({ body: init.body, url: String(url) });
      // Each press takes the next scripted answer, and the last one stays.
      reply = queue.shift() ?? reply;
      await reply.hold?.promise;
      if (reply.throws) throw reply.throws;
      return { json: () => Promise.resolve(reply.data) };
    });
    initPaymentTestButtons();
    const find = (id: string): PageElement =>
      window.document.getElementById(id) as unknown as PageElement;
    return {
      asked,
      button: find(`${provider}-test-btn`),
      result: find(`${provider}-test-result`),
    };
  };

  return {
    bare: (html: string) => {
      dom.installDom(html);
      initPaymentTestButtons();
    },
    open,
    press: async (provider: string, reply: Reply) => {
      const page = open(provider, [reply]);
      page.button.click();
      await settle();
      return { ...page, lines: page.result.textContent.split("\n") };
    },
  };
};
