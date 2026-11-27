import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { shortHash } from "#scripts/checksum.ts";
import { auditEquivalentMutants } from "#scripts/mutation/equivalent-audit.ts";
import { renewEquivalentMutants } from "#scripts/mutation/equivalent-review.ts";
import { type AuditFixture, gate, setup, source } from "./helpers.ts";

const optionsFor = (state: AuditFixture) => ({
  ignoreFiles: [state.ignoreFile],
  root: state.dir.path,
  sources: ["source.ts"],
});

const setupEdited = async (edited = `${source}// An unrelated edit.\n`) => {
  using cleanup = new DisposableStack();
  const state = await setup();
  cleanup.use(state.dir);
  await Deno.writeTextFile(state.sourceFile, edited);
  const lifetime = cleanup.move();
  return { ...state, edited, [Symbol.dispose]: () => lifetime.dispose() };
};

const renewalToken = async (state: AuditFixture): Promise<string> => {
  const report = await auditEquivalentMutants(
    { ...optionsFor(state), write: false },
    { createGates: () => Promise.resolve([]) },
  );
  const [review] = report.unconfirmed;
  if (!review) throw new Error("Expected a proof to review.");
  return review.token;
};

const renew = (state: AuditFixture, ...tokens: string[]) =>
  renewEquivalentMutants(optionsFor(state), tokens);

const expectNoRenewal = async (
  state: AuditFixture,
  expected: string,
  ...tokens: string[]
): Promise<void> => {
  await expect(renew(state, ...tokens)).rejects.toThrow("Run the audit again");
  expect(await Deno.readTextFile(state.ignoreFile)).toBe(expected);
};

const gone = "gone.ts::old~0000000 ?? → || audited:0000000 # removed\n";
const unrelated = "other.ts::old~0000000 ?? → || audited:0000000 # leave\n";

describe("scoped equivalent-mutant maintenance", () => {
  test("previews and prunes in scope", async () => {
    using state = await setupEdited();
    const registry = `# keep\n${gone}${unrelated}${state.entry}`;
    await Deno.writeTextFile(state.ignoreFile, registry);
    const changes = (write: boolean) =>
      auditEquivalentMutants(
        { ...optionsFor(state), sources: ["source.ts", "gone.ts"], write },
        {
          createGates: () =>
            Promise.resolve([
              gate("lint", async (file) =>
                (await Deno.readTextFile(file)).includes("||") ? 1 : 0,
              ),
            ]),
        },
      );

    const preview = await changes(false);
    expect(preview.checked).toBe(2);
    expect(preview.missing).toEqual([gone.trimEnd()]);
    expect(preview.killedByLint).toEqual([state.entry.trimEnd()]);
    expect(preview.unconfirmed).toEqual([]);
    expect(await Deno.readTextFile(state.ignoreFile)).toBe(registry);

    await changes(true);
    expect(await Deno.readTextFile(state.ignoreFile)).toBe(
      `# keep\n${unrelated}`,
    );
    expect(await Deno.readTextFile(state.sourceFile)).toBe(state.edited);
  });

  test("renews only the chosen record without a reason", async () => {
    using state = await setupEdited(source.trimEnd());
    const selected = state.entry.replace(/ +#.*\n$/, "\n");
    const notSelected = state.entry.replace("→ ||", "→ &&").trimEnd();
    await Deno.writeTextFile(state.ignoreFile, selected + notSelected);
    const token = await renewalToken(state);

    await renew(state, token);

    const updated =
      selected.replace(shortHash(source), shortHash(state.edited)) +
      notSelected;
    expect(await Deno.readTextFile(state.ignoreFile)).toBe(updated);
    await expectNoRenewal(state, updated, token);
  });

  test("rejects a stale renewal batch", async () => {
    using state = await setupEdited();
    const token = await renewalToken(state);
    const registry = await Deno.readTextFile(state.ignoreFile);

    await expectNoRenewal(state, registry, token, "0".repeat(64));

    await Deno.writeTextFile(
      state.sourceFile,
      `${state.edited}// A later edit.\n`,
    );
    await expectNoRenewal(state, registry, token);
  });

  test("rejects a revised reason", async () => {
    using state = await setupEdited();
    const token = await renewalToken(state);
    const changed = state.entry.replace("same fallback", "a different proof");
    await Deno.writeTextFile(state.ignoreFile, changed);

    await expectNoRenewal(state, changed, token);
  });

  test("rolls back on a source edit", async () => {
    using state = await setupEdited();
    const token = await renewalToken(state);
    const registry = await Deno.readTextFile(state.ignoreFile);
    const later = `${state.edited}// Concurrent edit.\n`;
    const rename = Deno.rename.bind(Deno);
    using _rename = stub(Deno, "rename", async (from, to) => {
      await rename(from, to);
      if (String(to) === state.ignoreFile) {
        await Deno.writeTextFile(state.sourceFile, later);
      }
    });

    await expect(renew(state, token)).rejects.toThrow("changed during renewal");
    expect(await Deno.readTextFile(state.ignoreFile)).toBe(registry);
    expect(await Deno.readTextFile(state.sourceFile)).toBe(later);
  });
});
