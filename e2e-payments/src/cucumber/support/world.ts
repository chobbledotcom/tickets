// jscpd:ignore-start -- imports
import { World } from "@cucumber/cucumber";
import type { Page } from "playwright";
import type { AppBrowser, BrowserSession } from "#e2e/browser.ts";
import {
  type BookerIdentity,
  config,
  newBookerIdentity,
  type OwnerCredentials,
  randomId,
  randomOwnerCredentials,
} from "#e2e/config.ts";
import type { InstalledFault } from "#e2e/db-fault.ts";
import { login, runSetup } from "#e2e/flow.ts";
import type {
  BuiltOrderCatalog,
  OrderCatalog,
  OrderJourneyIdentity,
} from "#e2e/order-flow.ts";
import type { RefusalProbeReport } from "#e2e/providers/sumup-callback.ts";
import type {
  PaidSandboxCheckout,
  PaymentProvider,
} from "#e2e/providers/types.ts";
import type { AppServer } from "#e2e/server.ts";
import { parseLiveTarget } from "#e2e/targets.ts";
import type { Tunnel } from "#e2e/tunnel.ts";
import { newJournal, type ScenarioJournal, writeJournal } from "./journal.ts";

// jscpd:ignore-end

/** Everything that makes this scenario's values selectable and unique. */
export interface ScenarioIdentity {
  booker: BookerIdentity;
  caseId: string;
  listingName: string;
  owner: OwnerCredentials;
  runId: string;
}

/** The infrastructure one running scenario owns. */
export interface ScenarioInfra {
  browser: AppBrowser;
  owner: BrowserSession;
  server: AppServer;
  tunnel: Tunnel;
  visitor: BrowserSession;
}

/** The typed per-scenario refund result the summary reports on. */
export interface RefundState {
  outcome: "refund_recorded" | "refund_observing";
  provider: string;
}

const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(
      `${what} is not set up yet in this scenario — a step ran out of order`,
    );
  }
  return value;
};

export class LiveWorld extends World {
  /** Set by the AfterStep hook so teardown knows the scenario's fate. */
  stepFailed = false;
  private checkout: PaidSandboxCheckout | null = null;
  private fault: InstalledFault | null = null;
  private identity: ScenarioIdentity | null = null;
  private infra: ScenarioInfra | null = null;
  private journal: ScenarioJournal | null = null;
  private listingPath: string | null = null;
  private provider: PaymentProvider | null = null;
  private refundState: RefundState | null = null;
  private secondOwner: BrowserSession | null = null;
  private secrets: Record<string, string> | null = null;
  private ownerPrepared = false;
  private builtOrder: BuiltOrderCatalog | null = null;
  private heldReturnUrl: string | null = null;
  private pendingReturnTab: Page | null = null;
  private pendingReturnTarget: string | null = null;
  private refusalProbeReport: RefusalProbeReport | null = null;
  private orderNames: OrderCatalog | null = null;

  /** Which provider this run targets ("free" for no provider). */
  readonly target = parseLiveTarget(process.env.E2E_PROVIDER);

  beginScenario(caseId: string): void {
    const runId = randomId(6);
    this.identity = {
      booker: newBookerIdentity(runId),
      caseId,
      listingName: `E2E Concert ${runId}`,
      owner: randomOwnerCredentials(),
      runId,
    };
    this.journal = newJournal(runId, caseId, this.target);
  }

  get scenario(): ScenarioIdentity {
    return required(this.identity, "the scenario identity");
  }

  get runJournal(): ScenarioJournal {
    return required(this.journal, "the scenario journal");
  }

  /** Everything the scenario acquired, failing loudly before it exists. */
  get resources(): ScenarioInfra {
    return required(this.infra, "the scenario's server, tunnel and browser");
  }

  /** The same infrastructure, or null when startup never got that far. */
  get infraMaybe(): ScenarioInfra | null {
    return this.infra;
  }

  /** The paid driver for this target — absent only for the free target. */
  get paidProvider(): {
    provider: PaymentProvider;
    secrets: Record<string, string>;
  } {
    const provider = required(this.provider, "the paid provider driver");
    const secrets = required(this.secrets, "the paid provider secrets");
    return { provider, secrets };
  }

  setPaidProvider(
    provider: PaymentProvider,
    secrets: Record<string, string>,
  ): void {
    this.provider = provider;
    this.secrets = secrets;
  }

  get paidCheckout(): PaidSandboxCheckout {
    return required(this.checkout, "the completed paid checkout identity");
  }

  rememberCheckout(checkout: PaidSandboxCheckout): void {
    this.checkout = checkout;
    this.journal!.checkoutMayHaveHappened = true;
    this.journal!.resourceIds = {
      ...Object.fromEntries(
        Object.entries(checkout).filter(([key]) => key !== "provider"),
      ),
      ...this.journal!.resourceIds,
    };
  }

  get bookingPath(): string {
    return required(this.listingPath, "the published listing's booking path");
  }

  rememberListing(path: string): void {
    this.listingPath = path;
  }

  attachInfra(infra: ScenarioInfra): void {
    this.infra = infra;
  }

  /** The second independently signed-in owner window (the stale-form race). */
  async secondOwnerWindow(): Promise<BrowserSession> {
    if (this.secondOwner === null) {
      const session = await this.resources.browser.session(
        `${this.scenario.caseId}-owner2`,
      );
      this.secondOwner = session;
    }
    return this.secondOwner;
  }

  installFault(fault: InstalledFault): void {
    this.fault = fault;
    this.journal!.refundMayHaveLanded = true;
  }

  get installedFault(): InstalledFault | null {
    return this.fault;
  }

  recordRefundState(state: RefundState): void {
    this.refundState = state;
    this.journal!.finalLocalState = state.outcome;
    this.journal!.pendingObserved = state.outcome === "refund_observing";
  }

  get refundResult(): RefundState | null {
    return this.refundState;
  }

  /** First-run setup + admin login, run once per scenario by whichever Given
   * step needs the owner first. */
  async prepareOwner(): Promise<void> {
    if (this.ownerPrepared) return;
    this.ownerPrepared = true;
    const provider = this.target === "free" ? null : this.paidProvider.provider;
    const country =
      process.env.SETUP_COUNTRY?.trim() ||
      provider?.setupCountry ||
      config.setupCountry;
    const owner = this.resources.owner;
    await runSetup(owner, country, this.scenario.owner);
    await login(owner, this.scenario.owner);
  }

  rememberBuiltOrder(built: BuiltOrderCatalog, names: OrderCatalog): void {
    this.builtOrder = built;
    this.orderNames = names;
  }

  get builtOrderCatalog(): BuiltOrderCatalog {
    return required(
      this.builtOrder,
      "the complex-order catalog (the owner has not published it yet)",
    );
  }

  get orderCatalogNames(): OrderCatalog {
    return required(
      this.orderNames,
      "the complex-order catalog names (the owner has not published it yet)",
    );
  }

  /** The order journey's identity: this scenario's booker and catalog names. */
  get orderIdentity(): OrderJourneyIdentity {
    return {
      booker: this.scenario.booker,
      catalog: this.orderCatalogNames,
      owner: this.scenario.owner,
    };
  }

  rememberHeldReturn(url: string): void {
    this.heldReturnUrl = url;
  }

  /** The exact intercepted return URL, before the replay step uses it. */
  get heldReturn(): string {
    return required(
      this.heldReturnUrl,
      "the held browser return URL (no return was intercepted yet)",
    );
  }

  /** The second tab the visitor opened on the pending payment return, and
   * the exact return URL it sits on — kept open together, because the
   * waiting steps read and drive the same live tab. */
  rememberPendingReturn(page: Page, url: string): void {
    this.pendingReturnTab = page;
    this.pendingReturnTarget = url;
  }

  /** The visitor's open tab on the pending payment return. */
  get pendingReturnPage(): Page {
    return required(
      this.pendingReturnTab,
      "the pending return tab (the visitor never opened it)",
    );
  }

  /** The exact return URL the pending tab first opened. */
  get pendingReturnUrl(): string {
    return required(
      this.pendingReturnTarget,
      "the pending return URL (the visitor never opened it)",
    );
  }

  rememberRefusalProbes(report: RefusalProbeReport): void {
    this.refusalProbeReport = report;
  }

  get refusalProbes(): RefusalProbeReport {
    return required(
      this.refusalProbeReport,
      "the callback refusal probes (they have not been delivered yet)",
    );
  }

  recordPhase(phase: string): void {
    this.journal?.phases.push({ at: new Date().toISOString(), phase });
  }

  recordObservation(observation: string): void {
    if (this.journal !== null) {
      this.journal.finalProviderObservation = observation;
    }
  }

  /** Persist the journal; called as the scenario progresses and at teardown. */
  async saveJournal(): Promise<void> {
    if (this.journal !== null) await writeJournal(this.journal);
  }
}
