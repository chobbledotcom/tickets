/**
 * Public HTTPS tunnel via cloudflared "quick tunnels" (no account needed).
 *
 * cloudflared preserves the incoming Host header, so the app's per-request
 * `loadEffectiveDomain()` resolves to the *.trycloudflare.com hostname. That is
 * what makes Stripe webhook registration (which needs a public HTTPS URL) and
 * the provider return URLs work end-to-end from an ephemeral CI runner.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { config } from "./config.ts";
import { log } from "./log.ts";

export interface Tunnel {
  /** Public base URL, e.g. https://foo-bar.trycloudflare.com (no trailing slash). */
  publicBaseUrl: string;
  stop: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export const startTunnel = async (localPort: number): Promise<Tunnel> => {
  log("Starting cloudflared quick tunnel…");
  const child: ChildProcess = spawn(
    config.cloudflaredBin,
    [
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${localPort}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let publicUrl: string | null = null;
  const scan = (chunk: Buffer): void => {
    const m = chunk.toString().match(TRYCLOUDFLARE_RE);
    if (m && !publicUrl) publicUrl = m[0];
  };
  child.stdout?.on("data", scan);
  child.stderr?.on("data", scan);

  const stop = (): Promise<void> =>
    new Promise<void>((resolveP) => {
      child.once("exit", () => resolveP());
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
        resolveP();
      }, 3_000);
    });

  const deadline = Date.now() + config.tunnelTimeoutMs;
  while (Date.now() < deadline) {
    if (publicUrl) {
      // Confirm the tunnel actually routes to the app before returning.
      try {
        const res = await fetch(`${publicUrl}/health`);
        const ok = res.ok;
        await res.body?.cancel();
        if (ok) {
          log(`Tunnel is live: ${publicUrl}`);
          return { publicBaseUrl: publicUrl, stop };
        }
      } catch {
        // tunnel edge not ready yet
      }
    }
    await sleep(1_000);
  }
  await stop();
  throw new Error(
    `cloudflared tunnel did not become reachable within ${config.tunnelTimeoutMs}ms`,
  );
};

/** No-op passthrough used when a target does not need a public URL. */
export const noTunnel = (localBaseUrl: string): Tunnel => ({
  publicBaseUrl: localBaseUrl,
  stop: () => Promise.resolve(),
});
