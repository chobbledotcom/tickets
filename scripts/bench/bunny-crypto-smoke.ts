/**
 * Bunny Edge smoke test: is node:crypto available on the edge sandbox, is its
 * AES-256-GCM output interoperable with crypto.subtle, and how much faster is it?
 *
 * Deploy this as a standalone Bunny Edge Script and hit any URL. It returns JSON.
 * It never imports node:crypto at module load (dynamic import in a try/catch) so
 * a blocked/absent module reports a result instead of failing the deploy.
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk";

const KEY = crypto.getRandomValues(new Uint8Array(32));
const SAMPLE = "attendee-pii-value-12345@example.com";
const ITERS = 2000;

// --- crypto.subtle (current approach) ---
const subtleKey = await crypto.subtle.importKey(
  "raw",
  KEY,
  { name: "AES-GCM" },
  false,
  ["encrypt", "decrypt"],
);
const subtleEnc = async (pt: Uint8Array) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, subtleKey, pt),
  );
  return { iv, ct }; // ct has the 16-byte GCM tag appended (WebCrypto layout)
};
const subtleDec = async (iv: Uint8Array, ct: Uint8Array) =>
  new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, subtleKey, ct),
  );

type Result = Record<string, unknown>;

const run = async (): Promise<Result> => {
  const out: Result = {};

  // 1) Can we even load node:crypto on this runtime?
  let nc: typeof import("node:crypto");
  try {
    nc = await import("node:crypto");
    out.nodeCryptoLoaded = true;
    out.createCipheriv = typeof nc.createCipheriv;
  } catch (e) {
    return {
      nodeCryptoLoaded: false,
      verdict: "node:crypto NOT available on this edge runtime — stay on crypto.subtle",
      error: String(e),
    };
  }

  // node:crypto helpers — match WebCrypto layout (tag appended to ciphertext)
  const nodeEnc = (pt: Uint8Array) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const c = nc.createCipheriv("aes-256-gcm", KEY, iv);
    const body = Buffer.concat([c.update(pt), c.final()]);
    const ct = new Uint8Array(Buffer.concat([body, c.getAuthTag()]));
    return { iv, ct };
  };
  const nodeDec = (iv: Uint8Array, ct: Uint8Array) => {
    const tag = ct.subarray(ct.length - 16);
    const body = ct.subarray(0, ct.length - 16);
    const d = nc.createDecipheriv("aes-256-gcm", KEY, iv);
    d.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([d.update(body), d.final()]));
  };

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const pt = enc.encode(SAMPLE);

  try {
    // 2) node round-trips itself
    const a = nodeEnc(pt);
    out.nodeRoundTrip = dec.decode(nodeDec(a.iv, a.ct)) === SAMPLE;

    // 3) Interop both directions — proves existing subtle data stays decryptable
    const s = await subtleEnc(pt);
    out.nodeDecryptsSubtle = dec.decode(nodeDec(s.iv, s.ct)) === SAMPLE;
    const n = nodeEnc(pt);
    out.subtleDecryptsNode = dec.decode(await subtleDec(n.iv, n.ct)) === SAMPLE;

    // 4) Micro-bench (small payload, the hot path)
    let t0 = performance.now();
    for (let i = 0; i < ITERS; i++) {
      const x = await subtleEnc(pt);
      await subtleDec(x.iv, x.ct);
    }
    const subtleMs = performance.now() - t0;

    t0 = performance.now();
    for (let i = 0; i < ITERS; i++) {
      const x = nodeEnc(pt);
      nodeDec(x.iv, x.ct);
    }
    const nodeMs = performance.now() - t0;

    out.iterations = ITERS;
    out.subtle_us_per_op = +(subtleMs * 1000 / ITERS).toFixed(2);
    out.node_us_per_op = +(nodeMs * 1000 / ITERS).toFixed(2);
    out.node_speedup = +(subtleMs / nodeMs).toFixed(2);

    const interopOk =
      out.nodeRoundTrip && out.nodeDecryptsSubtle && out.subtleDecryptsNode;
    out.verdict = interopOk
      ? `node:crypto works and is interoperable — ~${out.node_speedup}x faster on small payloads`
      : "node:crypto loaded but interop FAILED — do not swap";
  } catch (e) {
    out.benchError = String(e);
    out.verdict = "node:crypto loaded but threw at runtime — stay on crypto.subtle";
  }

  return out;
};

BunnySDK.net.http.serve(async (): Promise<Response> => {
  const result = await run();
  return new Response(JSON.stringify(result, null, 2), {
    headers: { "content-type": "application/json" },
  });
});
