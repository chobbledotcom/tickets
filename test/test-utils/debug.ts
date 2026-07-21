import type { DebugPageState } from "#templates/admin/debug.tsx";

/** Build a complete debug page state, overriding only fields a test needs. */
export const makeDebugState = (
  overrides: Partial<DebugPageState> = {},
): DebugPageState => ({
  appleWallet: {
    certValidation: {
      signingCert: "Not set",
      signingKey: "Not set",
      wwdrCert: "Not set",
    },
    dbConfigured: false,
    envConfigured: false,
    passTypeId: "",
    source: "",
  },
  availability: {
    cutoff: "",
    renewalConfigured: false,
    serverTime: "1970-01-01T00:00:00.000Z",
    state: "active",
  },
  build: { commit: "", timestamp: "" },
  bunny: {
    cdnEnabled: false,
    cdnHostname: "",
    customDomain: "",
    dnsEnabled: false,
    registeredSubdomain: "",
    storageBackend: "none",
    subdomainSuffix: "",
  },
  database: { hostConfigured: false, schemaHash: "", schemaInSync: false },
  domain: "localhost",
  email: {
    apiKeyConfigured: false,
    fromAddress: "",
    hostProvider: "",
    provider: "",
  },
  googleWallet: {
    dbConfigured: false,
    envConfigured: false,
    issuerId: "",
    privateKeyValid: "Not set",
    source: "",
  },
  limits: [],
  notifications: { ntfyConfigured: false, sentryConfigured: false },
  payment: {
    keyConfigured: false,
    mode: "",
    provider: "",
    webhookConfigured: false,
  },
  runtime: {
    arch: "",
    denoVersion: "",
    nodeCompatVersion: "",
    os: "",
    runtime: "unknown",
    typescriptVersion: "",
    userAgent: "",
    v8Version: "",
  },
  site: {
    bookingFee: "0",
    contactForm: false,
    country: "",
    currency: "",
    publicApi: false,
    publicSite: false,
    spamProtection: false,
    timezone: "",
  },
  theme: "light",
  ...overrides,
});

export const debugOwnerSession = { adminLevel: "owner" as const };
