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
import { log, warn } from "./log.ts";

export interface Tunnel {
  /** Public base URL, e.g. https://foo-bar.trycloudflare.com (no trailing slash). */
  publicBaseUrl: string;
  stop: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Spawn cloudflared once and resolve to a live Tunnel, or null if it never
 * printed a URL / the edge never routed within the per-attempt timeout. */
const attemptTunnel = async (localPort: number): Promise<Tunnel | null> => {
  const child: ChildProcess = spawn(
    config.cloudflaredBin,
    ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${localPort}`],
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
  // This attempt failed — tear it down so it doesn't linger.
  await stop();
  return null;
};

/**
 * Start a cloudflared quick tunnel, retrying on failure. trycloudflare quick
 * tunnels are best-effort and intermittently fail to register (more so when
 * several matrix legs start tunnels at once), which would otherwise fail the
 * whole leg before any payment work runs. Retry a few times before giving up.
 */
export const startTunnel = async (localPort: number): Promise<Tunnel> => {
  const attempts = config.tunnelAttempts;
  for (let i = 1; i <= attempts; i++) {
    log(`Starting cloudflared quick tunnel… (attempt ${i}/${attempts})`);
    const tunnel = await attemptTunnel(localPort);
    if (tunnel) return tunnel;
    if (i < attempts) {
      warn(
        `  tunnel not reachable within ${config.tunnelTimeoutMs}ms; retrying…`,
      );
      await sleep(2_000);
    }
  }
  throw new Error(
    `cloudflared tunnel did not become reachable after ${attempts} attempts ` +
      `of ${config.tunnelTimeoutMs}ms each`,
  );
};

/** No-op passthrough used when a target does not need a public URL. */
export const noTunnel = (localBaseUrl: string): Tunnel => ({
  publicBaseUrl: localBaseUrl,
  stop: () => Promise.resolve(),
});
