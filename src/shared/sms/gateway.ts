/**
 * SMS Gate cloud client.
 *
 * Talks to the SMS Gateway for Android™ 3rd-party API (default: the free public
 * cloud at api.sms-gate.app). Message text and recipient numbers are E2E
 * encrypted with the gateway passphrase BEFORE they leave this process, so the
 * relay only ever sees ciphertext (`isEncrypted: true`).
 *
 * Credentials and the passphrase live in encrypted settings; plaintext PII is
 * supplied transiently by the caller (decrypted under the owner's key) and is
 * never persisted in cleartext.
 */

import { settings } from "#shared/db/settings.ts";
import { type FetchResult, fetchText } from "#shared/fetch.ts";
import { DEFAULT_PBKDF2_ITERATIONS, encryptField } from "#shared/sms/e2e.ts";

/** Default base URL of the free public cloud relay. */
export const DEFAULT_SMS_BASE_URL = "https://api.sms-gate.app";

/** Path of the send-message endpoint (relative to the base URL). */
const MESSAGES_PATH = "/3rdparty/v1/messages";

export type SmsGatewayConfig = {
  baseUrl: string;
  username: string;
  password: string;
  passphrase: string;
};

/** The encrypted JSON body sent to the gateway (E2E ciphertext fields). */
export type EncryptedMessagePayload = {
  textMessage: { text: string };
  phoneNumbers: string[];
  isEncrypted: true;
  withDeliveryReport: true;
};

/**
 * Read gateway config from settings. Returns null unless the passphrase and
 * both Basic-auth credentials are present (the base URL falls back to the
 * public cloud).
 */
export const getSmsGatewayConfig = (): SmsGatewayConfig | null => {
  const passphrase = settings.smsGatewayPassphrase;
  const username = settings.smsGatewayUsername;
  const password = settings.smsGatewayPassword;
  if (!passphrase || !username || !password) return null;
  return {
    baseUrl: settings.smsGatewayBaseUrl || DEFAULT_SMS_BASE_URL,
    passphrase,
    password,
    username,
  };
};

/**
 * Build the encrypted send payload: the message body and the recipient number
 * are each E2E-encrypted with the passphrase.
 */
export const buildMessagePayload = async (
  phone: string,
  body: string,
  passphrase: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<EncryptedMessagePayload> => {
  const [text, encryptedPhone] = await Promise.all([
    encryptField(body, passphrase, iterations),
    encryptField(phone, passphrase, iterations),
  ]);
  return {
    isEncrypted: true,
    phoneNumbers: [encryptedPhone],
    textMessage: { text },
    withDeliveryReport: true,
  };
};

const basicAuthHeader = (username: string, password: string): string =>
  `Basic ${btoa(`${username}:${password}`)}`;

/** Parse the gateway response, returning the cloud message id or throwing. */
const parseMessageId = (result: FetchResult): string => {
  if (!result.ok) {
    throw new Error(
      `SMS gateway returned ${result.status}: ${result.text.slice(0, 200)}`,
    );
  }
  let id: unknown;
  try {
    id = (JSON.parse(result.text) as { id?: unknown }).id;
  } catch {
    throw new Error("SMS gateway returned a non-JSON response");
  }
  if (typeof id !== "string" || id === "") {
    throw new Error("SMS gateway response missing message id");
  }
  return id;
};

/**
 * POST an already-encrypted payload to the gateway. Returns the cloud message
 * id (stored on the outbox row for later status reconciliation).
 */
export const sendEncryptedMessage = async (
  config: SmsGatewayConfig,
  payload: EncryptedMessagePayload,
  fetchImpl: typeof fetchText = fetchText,
): Promise<{ providerId: string }> => {
  const result = await fetchImpl(`${config.baseUrl}${MESSAGES_PATH}`, {
    body: JSON.stringify(payload),
    headers: {
      authorization: basicAuthHeader(config.username, config.password),
      "content-type": "application/json",
    },
    method: "POST",
  });
  return { providerId: parseMessageId(result) };
};
