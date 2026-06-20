/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Public contact form: solve the Botpoison proof-of-work challenge on submit
 * and inject the resulting solution as a hidden field before the form posts.
 *
 * Bundled to /contact.js so it runs under the site's strict CSP
 * (script-src 'self'); the widget's only network call is to
 * api.botpoison.com, allowed via connect-src.
 */

import BotpoisonDefault from "@botpoison/browser";

const FIELD = "_botpoison";

/** Minimal shape of the Botpoison browser client we use. */
type BotpoisonClient = { challenge: () => Promise<{ solution: string }> };
type BotpoisonConstructor = new (opts: {
  publicKey: string;
}) => BotpoisonClient;

// The package ships a CJS/UMD build whose typings declare an ESM default
// export; Deno's type checker resolves that to a namespace. esbuild binds the
// default import to the class at bundle time, so cast to the constructor.
const Botpoison = BotpoisonDefault as unknown as BotpoisonConstructor;

export const initContactForm = (): void => {
  const form = document.querySelector<HTMLFormElement>(
    "form[data-botpoison-public-key]",
  );
  if (!form) return;

  const publicKey = form.dataset.botpoisonPublicKey;
  if (!publicKey) return;

  const botpoison = new Botpoison({ publicKey });
  let solved = false;
  let solving = false;

  const solveAndSubmit = async (): Promise<void> => {
    try {
      const { solution } = await botpoison.challenge();
      let input = form.querySelector<HTMLInputElement>(
        `input[name="${FIELD}"]`,
      );
      if (!input) {
        input = document.createElement("input");
        input.type = "hidden";
        input.name = FIELD;
        form.appendChild(input);
      }
      input.value = solution;
    } catch {
      // Leave the solution unset; the server rejects unverified submissions.
    } finally {
      solved = true;
      form.requestSubmit();
    }
  };

  form.addEventListener("submit", (event) => {
    if (solved) return; // already solved — let the real submit proceed
    event.preventDefault();
    if (solving) return; // a solve is already in flight
    solving = true;
    void solveAndSubmit();
  });
};

initContactForm();
