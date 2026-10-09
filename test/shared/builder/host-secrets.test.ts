import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { unique } from "#fp";
import { relativeToProject } from "#scripts/path.ts";
import { stringSpanTexts } from "#scripts/typescript-lex.ts";
import { collectHostSecrets, HOST_INFRA_SECRET_KEYS } from "#shared/builder.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";

test("lists every high-privilege host credential", () => {
  expect(HOST_INFRA_SECRET_KEYS).toEqual([
    "STORAGE_ZONE_NAME",
    "STORAGE_ZONE_KEY",
    "HOST_EMAIL_API_KEY",
    "BUNNY_API_KEY",
    "BUNNY_DNS_ZONE_ID",
    "APPLE_WALLET_SIGNING_CERT",
    "APPLE_WALLET_SIGNING_KEY",
    "APPLE_WALLET_WWDR_CERT",
    "GOOGLE_WALLET_SERVICE_ACCOUNT_KEY",
  ]);
});

describeWithEnv(
  "builder host secrets by provider",
  {
    env: {
      BUNNY_API_KEY: "host-key",
      BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
      BUNNY_DNS_ZONE_ID: "zone-1",
      NTFY_URL: "https://ntfy.example.com/t",
    },
  },
  () => {
    test("copies the exact allowed configured values", () => {
      const relevantNames = new Set([
        "BUNNY_API_KEY",
        "BUNNY_DNS_SUBDOMAIN_SUFFIX",
        "BUNNY_DNS_ZONE_ID",
        "NTFY_URL",
      ]);
      const selected = (provider: "bunny" | "deno") =>
        Object.fromEntries(
          collectHostSecrets(provider).filter(([name]) =>
            relevantNames.has(name),
          ),
        );

      expect({ bunny: selected("bunny"), deno: selected("deno") }).toEqual({
        bunny: {
          BUNNY_API_KEY: "host-key",
          BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
          BUNNY_DNS_ZONE_ID: "zone-1",
          NTFY_URL: "https://ntfy.example.com/t",
        },
        deno: { NTFY_URL: "https://ntfy.example.com/t" },
      });
    });
  },
);

/** Config-read env keys that are not site secrets, each with the reason it
 * stays off the copy list. A new config key must join this list with a reason
 * or the copy list in `HOST_SECRETS`. */
const NOT_SITE_SECRETS: Record<string, string> = {
  BUNNY_SCRIPT_ID: "each site carries its own script id from the site record",
  CAN_BUILD_SITES: "builder feature flag",
  DEBUG_KEY: "host diagnostics gate",
  DEFAULT_DB_HOST: "builder default database provider",
  DENO_DEPLOY_ORG_ID: "builder-level Deno Deploy credential",
  DENO_DEPLOY_ORG_SLUG: "builder-level Deno Deploy credential",
  DENO_DEPLOY_TOKEN: "builder-level Deno Deploy credential",
  MAIN_INSTANCE_KEY: "credentials-endpoint auth on the main instance",
  TURSO_API_TOKEN: "builder-level Turso provisioning credential",
  TURSO_GROUP: "builder-level Turso provisioning credential",
  TURSO_ORGANIZATION: "builder-level Turso provisioning credential",
};

test("copies every config-read secret that is not a builder-level credential", async () => {
  const source = await Deno.readTextFile(
    relativeToProject("src/shared/config.ts"),
  );
  // The lexer keeps each literal's quotes, so strip them before the check.
  const envKeyName = (literal: string): string | null => {
    const name = literal.match(/^(['"])([A-Z][A-Z0-9_]+)\1$/)?.[2];
    return name ?? null;
  };
  const candidates = unique(
    stringSpanTexts(source)
      .map(envKeyName)
      .filter((name) => name !== null),
  );
  // Set every candidate so collectHostSecrets copies the names it declares.
  using _env = withEnv(
    Object.fromEntries(candidates.map((name) => [name, "set"])),
  );
  const copied = collectHostSecrets("bunny").map(([name]) => name);
  const unclassified = candidates.filter(
    (name) => !copied.includes(name) && !(name in NOT_SITE_SECRETS),
  );
  expect(unclassified).toEqual([]);
});
