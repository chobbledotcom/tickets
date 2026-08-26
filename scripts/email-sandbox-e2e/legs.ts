/**
 * Which live email legs exist, and what each one needs from the environment.
 *
 * The record is keyed by the production provider union, so a provider added
 * to `src/shared/email.ts` refuses to compile until this harness says how to
 * reach its real API safely. A leg without its on-switch secret is skipped
 * and reported. A leg with the secret but a bad companion value is a failed
 * run, because the operator clearly meant it to run.
 */

import {
  type EmailConfig,
  type EmailProvider,
  isEmailProvider,
  VALID_EMAIL_PROVIDERS,
} from "#shared/email.ts";
import { parseEmail, type ValidEmail } from "#shared/validation/email.ts";

/** Where one address comes from: a secret, with an optional safe default. */
interface AddressSource {
  env: string;
  fallback?: string;
}

interface EmailLegSpec {
  from: AddressSource;
  /** The secret that switches this leg on. */
  keyVar: string;
  to: AddressSource;
}

/** Both Mailgun regions need the same three secrets, named by region. */
const mailgunLeg = (region: "EU" | "US"): EmailLegSpec => ({
  from: { env: `MAILGUN_${region}_FROM` },
  keyVar: `MAILGUN_${region}_API_KEY`,
  to: { env: `MAILGUN_${region}_TO` },
});

const EMAIL_LEGS: Record<EmailProvider, EmailLegSpec> = {
  // A Mailgun sandbox domain only accepts authorized recipients, so the
  // recipient secret has no safe default.
  "mailgun-eu": mailgunLeg("EU"),
  "mailgun-us": mailgunLeg("US"),
  postmark: {
    from: { env: "POSTMARK_FROM" },
    keyVar: "POSTMARK_SERVER_TOKEN",
    // Postmark's documented discard address: accepted, logged, never sent on.
    to: { env: "POSTMARK_TO", fallback: "test@blackhole.postmarkapp.com" },
  },
  resend: {
    // Resend's documented sender for accounts with no verified domain.
    from: { env: "RESEND_FROM", fallback: "onboarding@resend.dev" },
    keyVar: "RESEND_API_KEY",
    // Resend's documented delivered-event simulation address.
    to: { env: "RESEND_TO", fallback: "delivered@resend.dev" },
  },
  sendgrid: {
    from: { env: "SENDGRID_FROM" },
    keyVar: "SENDGRID_API_KEY",
    // SendGrid's documented sink domain: accepted, then discarded.
    to: { env: "SENDGRID_TO", fallback: "e2e@sink.sendgrid.net" },
  },
};

/** A trimmed secret; unset and blank both mean "not set", because a missing
 * GitHub Actions secret expands to a blank string in the workflow env. */
const secretValue = (name: string): string | undefined => {
  const value = Deno.env.get(name)?.trim();
  return value ? value : undefined;
};

type ResolvedAddress = { address: ValidEmail } | { problem: string };

const resolveAddress = (source: AddressSource): ResolvedAddress => {
  const raw = secretValue(source.env) ?? source.fallback;
  if (raw === undefined) return { problem: `${source.env} is not set` };
  const address = parseEmail(raw);
  return address === null
    ? { problem: `${source.env} is not a valid email address` }
    : { address };
};

/** A leg that can run, one waiting on its secret, or one set up wrong. */
type EmailLegPlan =
  | { config: EmailConfig; state: "ready"; to: ValidEmail }
  | { reason: string; state: "skipped" }
  | { reason: string; state: "broken" };

/** Read one provider's leg from the environment, without running it. */
export const resolveEmailLeg = (provider: EmailProvider): EmailLegPlan => {
  const spec = EMAIL_LEGS[provider];
  const apiKey = secretValue(spec.keyVar);
  if (apiKey === undefined) {
    return { reason: `${spec.keyVar} is not set`, state: "skipped" };
  }
  const from = resolveAddress(spec.from);
  if ("problem" in from) return { reason: from.problem, state: "broken" };
  const to = resolveAddress(spec.to);
  if ("problem" in to) return { reason: to.problem, state: "broken" };
  return {
    config: { apiKey, fromAddress: from.address, provider },
    state: "ready",
    to: to.address,
  };
};

/** The providers one CLI target selects: every leg, or a single named one. */
export const parseEmailTarget = (raw: string | undefined): EmailProvider[] => {
  const target = (raw ?? "all").toLowerCase();
  if (target === "all") return [...VALID_EMAIL_PROVIDERS];
  if (isEmailProvider(target)) return [target];
  throw new Error(
    `unknown target "${target}" (expected all|${VALID_EMAIL_PROVIDERS.join("|")})`,
  );
};
