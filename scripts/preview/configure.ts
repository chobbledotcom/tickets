/**
 * Set up a new preview through its own pages, as the owner would: complete
 * `/setup` with the shared login, sign in, and save the sandbox keys of each
 * payment provider. The providers are saved once, in the run that completes
 * setup. The app refuses to switch back to a provider that already holds
 * keys, so a second pass could not continue a half-made setup. A site that
 * is already set up is left as it is.
 */

import type { Fields, Page, SiteClient } from "#scripts/preview/site-client.ts";
import { eachInOrder } from "#scripts/preview/steps.ts";
import { errorMessage } from "#shared/error-message.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

export type Owner = { password: string; username: string };

/** One payment provider: its id on the settings page and the fields that its
 * credentials form takes. */
export type ProviderPlan = { fields: Fields; id: string };

export type SitePlan = { owner: Owner; providers: readonly ProviderPlan[] };

/** How long to wait for a new site to answer. */
export type Pace = {
  attempts: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
};

const SETUP_PATH = "/setup/";
const SETTINGS_PATH = "/admin/settings";
const COUNTRY = "GB";

/** The text of the first notice that a page shows, or null when it shows
 * none. A refused form leaves its reason in such a notice. */
const noticeTextOrNull = (html: string): string | null => {
  const notice = html.match(
    /<div class="(?:error|success|info)"[^>]*role="alert"[^>]*>([\s\S]*?)<\/div>/i,
  );
  return notice?.[1] === undefined
    ? null
    : notice[1].replace(/<[^>]*>/g, "").trim();
};

/** The page that shows what a form did. A redirect names it, and it carries
 * the notice. An answer with no redirect is that page itself. */
const landingOf = (client: SiteClient, sent: Page): Promise<Page> =>
  sent.location === null ? Promise.resolve(sent) : client.get(sent.location);

const refusal = (what: string, sent: Page, notice: string | null): string =>
  `${what} The site answered ${sent.status}${
    sent.location === null ? "" : ` to ${sent.location}`
  }${notice === null ? "." : `: ${notice}`}`;

/** Ask for the setup page until the site answers it. A new site needs a
 * moment to start, and a new hostname can fail to resolve for a short time. */
const waitForSite = async (
  client: SiteClient,
  pace: Pace,
): Promise<Result<Page>> => {
  let lastProblem = "no answer";
  for (let attempt = 1; attempt <= pace.attempts; attempt++) {
    try {
      const page = await client.get(SETUP_PATH);
      if (page.status !== 404 && page.status < 500) return okResult(page);
      lastProblem = `status ${page.status}`;
    } catch (error) {
      // The site is not reachable yet. The loop tries again.
      lastProblem = errorMessage(error);
    }
    if (attempt < pace.attempts) await pace.sleep(pace.delayMs);
  }
  return errorResult(
    `The site gave no answer after ${pace.attempts} tries (${lastProblem}).`,
  );
};

/** Complete `/setup` when the site still offers it. The answer says whether
 * this run did it. */
const completeSetup = async (
  client: SiteClient,
  owner: Owner,
  setupPage: Page,
): Promise<Result<boolean>> => {
  if (setupPage.status === 302) return okResult(false);
  if (setupPage.status !== 200) {
    return errorResult(
      refusal("The setup page did not open.", setupPage, null),
    );
  }
  const sent = await client.submit(SETUP_PATH, {
    acceptAgreement: "yes",
    adminPassword: owner.password,
    adminPasswordConfirm: owner.password,
    adminUsername: owner.username,
    country: COUNTRY,
  });
  return sent.status === 302 && sent.location === "/setup/complete"
    ? okResult(true)
    : errorResult(refusal("Setup was refused.", sent, null));
};

/** Sign in as the owner. A refused login goes back to the login page. */
const logIn = async (
  client: SiteClient,
  owner: Owner,
): Promise<Result<null>> => {
  const sent = await client.submit(
    "/admin/",
    { password: owner.password, username: owner.username },
    "/admin/login",
  );
  const address = sent.location ?? "";
  const accepted = sent.status === 302 && !address.startsWith("/admin/login");
  return accepted
    ? okResult(null)
    : errorResult(refusal("The owner login was refused.", sent, null));
};

/** A provider shows its test button once its key is saved. */
const isConfigured = (html: string, id: string): boolean =>
  html.includes(`id="${id}-test-btn"`);

/** Choose the provider, so that its credentials form shows, then save it. */
const configureProvider = async (
  client: SiteClient,
  provider: ProviderPlan,
): Promise<Result<string>> => {
  const { id } = provider;
  const chosen = await client.submit(
    SETTINGS_PATH,
    { paymentProvider: id },
    `${SETTINGS_PATH}/payment-provider`,
  );
  const chosenPage = await landingOf(client, chosen);
  if (!chosenPage.html.includes(`action="${SETTINGS_PATH}/${id}"`)) {
    return errorResult(
      refusal(
        `Choosing ${id} was refused.`,
        chosen,
        noticeTextOrNull(chosenPage.html),
      ),
    );
  }
  const saved = await client.submit(
    SETTINGS_PATH,
    provider.fields,
    `${SETTINGS_PATH}/${id}`,
  );
  const savedPage = await landingOf(client, saved);
  return isConfigured(savedPage.html, id)
    ? okResult(`${id} configured.`)
    : errorResult(
        refusal(
          `Saving ${id} was refused.`,
          saved,
          noticeTextOrNull(savedPage.html),
        ),
      );
};

/** Save the providers in order. The last one stays the active provider. */
const configureProviders = (
  client: SiteClient,
  providers: readonly ProviderPlan[],
): Promise<Result<string[]>> =>
  eachInOrder(providers, (provider) => configureProvider(client, provider));

/** The lines that describe what this run did. */
export const configureSite = async (
  client: SiteClient,
  plan: SitePlan,
  pace: Pace,
): Promise<Result<string[]>> => {
  const ready = await waitForSite(client, pace);
  if (!ready.ok) return ready;
  const setup = await completeSetup(client, plan.owner, ready.value);
  if (!setup.ok) return setup;
  if (!setup.value) {
    return okResult([
      "Setup was already complete, so the site was left as it is.",
    ]);
  }
  const login = await logIn(client, plan.owner);
  if (!login.ok) return login;
  const providers = await configureProviders(client, plan.providers);
  return providers.ok
    ? okResult(["Setup completed.", ...providers.value])
    : providers;
};
