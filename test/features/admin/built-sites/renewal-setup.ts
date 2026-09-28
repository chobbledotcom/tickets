import { afterEach, beforeEach } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { updateBuiltSiteRenewalState } from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import {
  createTestBuiltSite,
  provisionTestBuiltSite,
} from "#test-utils/db-helpers/built-sites.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** The secret-stub lifecycle every renewal action suite runs on: a fresh
 * success stub per test, restored after. Call once inside the suite body. */
export const renewalSuiteHelpers = () => {
  let secretStub: Stub;

  const installSecretStub = () =>
    stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
      Promise.resolve({ ok: true as const }),
    );

  /** Restore and re-install the secret stub (clears its recorded calls). */
  const resetSecretStub = () => {
    if (!secretStub.restored) secretStub.restore();
    secretStub = installSecretStub();
  };

  beforeEach(() => {
    secretStub = installSecretStub();
  });

  afterEach(() => {
    if (!secretStub.restored) secretStub.restore();
  });

  /** Run `body` with the secret stub swapped for one that fails every push. */
  const withFailingSecretStub = async (body: () => Promise<void>) => {
    secretStub.restore();
    const failStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
      Promise.resolve({ error: "edge push failed", ok: false as const }),
    );
    try {
      await body();
    } finally {
      failStub.restore();
    }
  };

  return {
    resetSecretStub,
    get secretStub(): Stub {
      return secretStub;
    },
    withFailingSecretStub,
  };
};

/** The secret names (`args[1]`) recorded by a setEdgeScriptSecret stub. */
export const secretNamesOf = (secretStub: Stub): string[] =>
  secretStub.calls.map((c: Stub["calls"][number]) => c.args[1] as string);

/** POST a built-site action form (`/admin/built-sites/:id/<action>`). */
export const siteAction = (
  site: { id: number },
  action: string,
  data?: Record<string, string>,
) => adminFormPost(`/admin/built-sites/${site.id}/${action}`, data);

/** Re-sync a site's deadline: stage the site, reset the stub, post the
 * action, and return the secret names the re-push used. */
export const reSyncDeadlineSecrets = async (
  suite: { resetSecretStub: () => void; secretStub: Stub },
  hostingId: string,
  name: string,
  readOnlyFrom: string,
  provisioned: boolean,
): Promise<string[]> => {
  const site = await createTestBuiltSite({ hostingId, name });
  if (provisioned) await provisionTestBuiltSite(site.id);
  await updateBuiltSiteRenewalState(site.id, { readOnlyFrom });
  suite.resetSecretStub();

  const { response } = await siteAction(site, "re-sync-deadline");
  await expectFlashRedirect(
    `/admin/built-sites/${site.id}/renewal`,
    "Deadline re-synced",
  )(response);
  return secretNamesOf(suite.secretStub);
};
