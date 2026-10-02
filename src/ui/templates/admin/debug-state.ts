/** The debug page's input facts: one member per card it renders. */

import type { DatabaseHost } from "#db/host.ts";
import type { LIMIT_ENTRIES } from "#shared/limits.ts";
import type { RuntimeInfo } from "#shared/runtime.ts";
import type { Theme } from "#types";

export type DebugPageState = {
  appleWallet: {
    dbConfigured: boolean;
    envConfigured: boolean;
    passTypeId: string;
    source: string;
    certValidation: {
      signingCert: string;
      signingKey: string;
      wwdrCert: string;
    };
  };
  googleWallet: {
    dbConfigured: boolean;
    envConfigured: boolean;
    issuerId: string;
    source: string;
    privateKeyValid: string;
  };
  payment: {
    provider: string;
    keyConfigured: boolean;
    webhookConfigured: boolean;
    mode: string;
  };
  site: {
    publicSite: boolean;
    publicApi: boolean;
    contactForm: boolean;
    spamProtection: boolean;
    country: string;
    currency: string;
    timezone: string;
    bookingFee: string;
  };
  availability: {
    state: "active" | "warning" | "readonly";
    cutoff: string;
    renewalConfigured: boolean;
    serverTime: string;
  };
  email: {
    provider: string;
    apiKeyConfigured: boolean;
    fromAddress: string;
    hostProvider: string;
  };
  notifications: {
    ntfyConfigured: boolean;
    sentryConfigured: boolean;
  };
  bunny: {
    storageBackend: "bunny" | "local" | "none";
    cdnEnabled: boolean;
    cdnHostname: string;
    customDomain: string;
    dnsEnabled: boolean;
    subdomainSuffix: string;
    registeredSubdomain: string;
  };
  database: {
    host: DatabaseHost | null;
    hostConfigured: boolean;
    schemaInSync: boolean;
    schemaHash: string;
  };
  build: {
    timestamp: string;
    commit: string;
  };
  runtime: RuntimeInfo;
  domain: string;
  limits: typeof LIMIT_ENTRIES;
  theme: Theme;
};
