import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import type { FetchResult } from "#shared/fetch.ts";
import { decryptField } from "#shared/sms/e2e.ts";
import {
  DEFAULT_SMS_BASE_URL,
  buildMessagePayload,
  generateSmsPassphrase,
  getSmsGatewayConfig,
  isSmsGatewayConfigured,
  sendEncryptedMessage,
  sendSmsViaGateway,
} from "#shared/sms/gateway.ts";
import { describeWithEnv } from "#test-utils";

const PASS = "test-passphrase";

const result = (over: Partial<FetchResult> = {}): FetchResult => ({
  headers: new Headers(),
  ok: true,
  status: 200,
  text: '{"id":"msg-1"}',
  ...over,
});

const fakeFetch = (
  res: FetchResult,
  onCall?: (url: string, init?: RequestInit) => void,
): ((url: string, init?: RequestInit) => Promise<FetchResult>) =>
  (url, init) => {
    onCall?.(url, init);
    return Promise.resolve(res);
  };

const config = {
  baseUrl: DEFAULT_SMS_BASE_URL,
  passphrase: PASS,
  password: "pw",
  username: "user",
};

describe("sms gateway payload", () => {
  it("generateSmsPassphrase returns distinct non-empty tokens", () => {
    const a = generateSmsPassphrase();
    const b = generateSmsPassphrase();
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
  });

  it("buildMessagePayload encrypts the body and recipient", async () => {
    const payload = await buildMessagePayload("+447700900123", "Hi there", PASS);

    expect(payload.isEncrypted).toBe(true);
    expect(payload.withDeliveryReport).toBe(true);
    expect(payload.phoneNumbers).toHaveLength(1);
    // The wire fields are ciphertext, not the plaintext values
    expect(payload.textMessage.text).not.toBe("Hi there");
    expect(payload.phoneNumbers[0]).not.toBe("+447700900123");
    // ...but they decrypt back with the passphrase
    expect(await decryptField(payload.textMessage.text, PASS)).toBe("Hi there");
    expect(await decryptField(payload.phoneNumbers[0]!, PASS)).toBe(
      "+447700900123",
    );
  });
});

describe("sms gateway send", () => {
  it("posts to the messages endpoint with Basic auth and returns the id", async () => {
    let seenUrl = "";
    let seenAuth: string | null = null;
    const fetchImpl = fakeFetch(result(), (url, init) => {
      seenUrl = url;
      seenAuth = new Headers(init?.headers).get("authorization");
    });

    const { providerId } = await sendEncryptedMessage(
      config,
      await buildMessagePayload("+1", "hi", PASS),
      fetchImpl,
    );

    expect(providerId).toBe("msg-1");
    expect(seenUrl).toBe(`${DEFAULT_SMS_BASE_URL}/3rdparty/v1/messages`);
    expect(seenAuth).toBe(`Basic ${btoa("user:pw")}`);
  });

  it("sendSmsViaGateway encrypts then sends the ciphertext", async () => {
    let body: string | null = null;
    const fetchImpl = fakeFetch(result(), (_url, init) => {
      body = init?.body as string;
    });

    const { providerId } = await sendSmsViaGateway(
      config,
      { body: "secret message", phone: "+44123" },
      fetchImpl,
    );

    expect(providerId).toBe("msg-1");
    // The transmitted body never contains the plaintext
    expect(body).not.toBeNull();
    expect(body!).not.toContain("secret message");
    expect(body!).not.toContain("+44123");
    expect(JSON.parse(body!).isEncrypted).toBe(true);
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = fakeFetch(
      result({ ok: false, status: 401, text: "unauthorized" }),
    );
    await expect(
      sendEncryptedMessage(config, await buildMessagePayload("+1", "x", PASS), fetchImpl),
    ).rejects.toThrow("returned 401");
  });

  it("throws on a non-JSON response", async () => {
    const fetchImpl = fakeFetch(result({ text: "<html>" }));
    await expect(
      sendEncryptedMessage(config, await buildMessagePayload("+1", "x", PASS), fetchImpl),
    ).rejects.toThrow("non-JSON");
  });

  it("throws when the response has no message id", async () => {
    const fetchImpl = fakeFetch(result({ text: "{}" }));
    await expect(
      sendEncryptedMessage(config, await buildMessagePayload("+1", "x", PASS), fetchImpl),
    ).rejects.toThrow("missing message id");
  });
});

describeWithEnv("sms gateway config", { db: true }, () => {
  it("is unconfigured by default", () => {
    expect(getSmsGatewayConfig()).toBeNull();
    expect(isSmsGatewayConfigured()).toBe(false);
  });

  it("requires passphrase and both credentials", async () => {
    await settings.update.smsGatewayPassphrase("p");
    await settings.update.smsGatewayUsername("u");
    expect(getSmsGatewayConfig()).toBeNull(); // password still missing

    await settings.update.smsGatewayPassword("pw");
    const cfg = getSmsGatewayConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.username).toBe("u");
    expect(cfg!.password).toBe("pw");
    expect(cfg!.passphrase).toBe("p");
    expect(cfg!.baseUrl).toBe(DEFAULT_SMS_BASE_URL);
    expect(isSmsGatewayConfigured()).toBe(true);
  });

  it("uses a custom base URL when set", async () => {
    await settings.update.smsGatewayPassphrase("p");
    await settings.update.smsGatewayUsername("u");
    await settings.update.smsGatewayPassword("pw");
    await settings.update.smsGatewayBaseUrl("https://sms.example.com");
    expect(getSmsGatewayConfig()!.baseUrl).toBe("https://sms.example.com");
  });
});
