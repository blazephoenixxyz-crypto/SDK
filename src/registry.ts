// =============================================================================
//  Registry — resolves (chain, version selector) → a contract set, merging the
//  embedded snapshot, the site's published registry, and your overrides.
//
//  TRUST MODEL (why fetching addresses from a website is not blind trust):
//   • Embedded non-zero addresses are PINS. A remote document that disagrees
//     with a pin is ignored for that field and reported via onWarning.
//   • Remote can only fill what the snapshot does not know (zero addresses,
//     new 2.x+ versions — a new 1.x could not be verified on-chain, so it is
//     refused). The client verifies every remote-sourced set on YOUR RPC
//     before its first use (code exists, VERSION() matches, the Quoter and the
//     Router point at the same Hub and Solver) and fails closed otherwise.
//   • Your `contracts` overrides always win and are never second-guessed.
//   • mode: 'embedded' turns the network fetch off entirely.
// =============================================================================

import {
  CONTRACT_KEYS, EMBEDDED_DEPLOYMENTS, compareVersions, featuresOf, isDeployed, isValidSelector, isZero,
  matchesSelector, validateRegistry,
  type ContractSet, type DeploymentRegistry, type DeploymentStatus, type VersionSelector,
} from './deployments.js';
import { DEPLOYMENTS_URL, SUPPORTED_CHAIN_IDS, tryResolveChain, type SupportedChainId } from './constants.js';
import { BlazeError } from './errors.js';
import { resilientFetch, singleflight } from './resilience.js';
import type { Address } from './types.js';

export type DeploymentSource = 'embedded' | 'remote' | 'override';

export interface ResolvedDeployment {
  chainId: SupportedChainId;
  version: string;
  status: DeploymentStatus | 'custom';
  contracts: ContractSet;
  /** Where the router/quoter pair came from — the part you send money to. */
  source: DeploymentSource;
}

export interface ContractOverride extends Partial<ContractSet> {
  /** Protocol version these contracts speak (selects the ABI features). */
  version?: string;
}

export type ContractOverrides = { readonly [chain: string]: ContractOverride | undefined };

export interface RegistryOptions {
  /** 'auto' (default): embedded + the site's registry, refreshed every ttlMs.
   *  'embedded': never touch the network — only this SDK's snapshot + overrides. */
  mode?: 'auto' | 'embedded';
  url?: string;
  /** Refresh interval for the remote document (default 10 min). */
  ttlMs?: number;
  fetchFn?: typeof fetch;
  /** Fetch timeout (default 3000 ms). Only the FIRST fetch of a process can
   *  delay a call, and by at most this much; later refreshes run in the
   *  background (stale-while-revalidate). */
  timeoutMs?: number;
  /** Called for every pin conflict or rejected document — never silently. */
  onWarning?: (msg: string) => void;
}

type FieldSource = Record<string, DeploymentSource>; // `${version}|${chain}|${key}` → source

export class Registry {
  private doc: DeploymentRegistry;
  private fieldSource: FieldSource = {};
  private fetchedAt = 0;
  private lastError?: string;
  private readonly mode: 'auto' | 'embedded';
  private readonly url: string;
  private readonly ttlMs: number;
  private readonly fetchFn?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly warn: (msg: string) => void;
  private readonly overrides = new Map<SupportedChainId, ContractOverride>();

  constructor(opts: RegistryOptions = {}, overrides?: ContractOverrides) {
    this.mode = opts.mode ?? 'auto';
    this.url = opts.url ?? DEPLOYMENTS_URL;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as typeof fetch | undefined);
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.warn = opts.onWarning ?? (() => {});
    this.doc = structuredClone(EMBEDDED_DEPLOYMENTS);
    for (const v of this.doc.versions) {
      for (const [cid, set] of Object.entries(v.chains)) {
        for (const k of CONTRACT_KEYS) {
          if (!isZero((set as ContractSet)[k])) this.fieldSource[`${v.version}|${cid}|${k}`] = 'embedded';
        }
      }
    }
    for (const [k, o] of Object.entries(overrides ?? {})) {
      if (!o) continue;
      const id = tryResolveChain(k);
      if (!id) throw new BlazeError('bad_request', `contracts override: unknown chain "${k}"`);
      for (const key of CONTRACT_KEYS) {
        const a = o[key];
        if (a !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(a)) {
          throw new BlazeError('bad_request', `contracts override for ${k}: ${key} is not an address`);
        }
      }
      if (o.version !== undefined && !isValidSelector(o.version)) {
        throw new BlazeError('bad_request', `contracts override for ${k}: bad version "${o.version}"`);
      }
      this.overrides.set(id, o);
    }
  }

  /** Before a lookup: the first time, wait for the remote document (bounded
   *  by timeoutMs); afterwards serve the current state and revalidate in the
   *  background when stale. Never throws. */
  async ready(): Promise<void> {
    if (this.mode !== 'auto' || !this.fetchFn) return;
    if (!this.fetchedAt) { await this.refresh(); return; }
    if (Date.now() - this.fetchedAt >= this.ttlMs) void this.refresh();
  }

  /** Fetch the remote document when stale (mode 'auto'). Never throws: a
   *  failed fetch keeps the last good state and is reported via onWarning. */
  async refresh(force = false): Promise<void> {
    if (this.mode !== 'auto' || !this.fetchFn) return;
    if (!force && this.fetchedAt && Date.now() - this.fetchedAt < this.ttlMs) return;
    // Concurrent refreshes of the same URL (several clients in one process)
    // share ONE download — but every instance merges the document into its
    // OWN state. (Sharing the merge too would leave the followers stale.)
    try {
      const raw = await singleflight(`registry ${this.url}`, async () => {
        const res = await resilientFetch(this.fetchFn!, this.url, { headers: { accept: 'application/json' } }, {
          retries: 0, timeoutMs: this.timeoutMs,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as unknown;
        // The site wraps nothing today, but accept { registry: … } too.
        return body && typeof body === 'object' && 'registry' in (body as object)
          ? (body as { registry: unknown }).registry : body;
      });
      this.merge(raw);
      this.lastError = undefined;
    } catch (e) {
      this.lastError = (e as Error)?.message ?? String(e);
      this.warn(`deployment registry fetch failed (${this.lastError}) — using the embedded snapshot`);
    } finally {
      // Back off on failure too: a dead URL must not be hit on every quote.
      this.fetchedAt = Date.now();
    }
  }

  /** Merge a registry document under the pinning rules. Exposed for tests and
   *  for callers who distribute the registry through their own channel. */
  merge(raw: unknown): void {
    const v = validateRegistry(raw);
    if (!v.ok) {
      this.warn(`deployment registry rejected: ${v.error}`);
      return;
    }
    for (const rv of v.registry.versions) {
      let local = this.doc.versions.find((x) => x.version === rv.version);
      // A version this SDK has never heard of is only accepted when it can be
      // verified on the user's RPC before use: 2.x contracts answer VERSION(),
      // hub() and solver(); a "new" 1.x set could only be checked for code at
      // an address — not enough to route anyone's approvals to it.
      if (!local && !featuresOf(rv.version).introspection) {
        this.warn(`registry announced unknown version ${rv.version}, which cannot be verified on-chain — ignored`);
        continue;
      }
      if (!local) {
        local = { version: rv.version, status: rv.status, chains: {} };
        if (rv.source) local.source = rv.source;
        if (rv.notes) local.notes = rv.notes;
        this.doc.versions.push(local);
      } else {
        local.status = rv.status;
        if (rv.source && !local.source) local.source = rv.source;
      }
      for (const [cid, rset] of Object.entries(rv.chains) as [string, ContractSet][]) {
        const id = Number(cid) as SupportedChainId;
        const cur: ContractSet = local.chains[id] ?? {
          core: '0x0000000000000000000000000000000000000000',
          hub: '0x0000000000000000000000000000000000000000',
          solver: '0x0000000000000000000000000000000000000000',
          router: '0x0000000000000000000000000000000000000000',
          quoter: '0x0000000000000000000000000000000000000000',
        };
        for (const k of CONTRACT_KEYS) {
          const key = `${rv.version}|${cid}|${k}`;
          const incoming = rset[k];
          if (this.fieldSource[key] === 'embedded') {
            if (!isZero(incoming) && incoming.toLowerCase() !== cur[k].toLowerCase()) {
              this.warn(`registry tried to move pinned ${k} of ${rv.version} on chain ${cid} `
                + `(${cur[k]} → ${incoming}) — ignored`);
            }
            continue;
          }
          if (isZero(incoming)) continue;
          cur[k] = incoming;
          this.fieldSource[key] = 'remote';
        }
        local.chains[id] = cur;
      }
    }
    this.doc.versions.sort((a, b) => compareVersions(b.version, a.version));
    if (v.registry.updatedAt) this.doc.updatedAt = v.registry.updatedAt;
  }

  /** The merged document (embedded + remote), overrides NOT applied. */
  snapshot(): DeploymentRegistry {
    return structuredClone(this.doc);
  }

  status(): { mode: 'auto' | 'embedded'; url: string; fetchedAt: number | null; lastError?: string } {
    return { mode: this.mode, url: this.url, fetchedAt: this.fetchedAt || null, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  /** Every deployed version on a chain, newest first. */
  versionsOn(chainId: SupportedChainId): string[] {
    return this.doc.versions
      .filter((v) => isDeployed(v.chains[chainId]))
      .map((v) => v.version)
      .sort((a, b) => compareVersions(b, a));
  }

  resolve(chainId: SupportedChainId, selector: VersionSelector = 'latest'): ResolvedDeployment {
    if (!isValidSelector(selector)) throw new BlazeError('bad_request', `bad version selector "${selector}"`);
    const ov = this.overrides.get(chainId);
    const sel = ov?.version && (selector === 'latest') ? ov.version : selector;

    const candidates = this.doc.versions
      .filter((v) => matchesSelector(v.version, sel) && isDeployed(v.chains[chainId]))
      .sort((a, b) => compareVersions(b.version, a.version));
    const pick = candidates[0];

    if (ov && (ov.router || ov.quoter)) {
      // An override may stand on its own (your deployment) or patch a known one.
      const base: ContractSet = pick ? { ...pick.chains[chainId]! } : {
        core: '0x0000000000000000000000000000000000000000',
        hub: '0x0000000000000000000000000000000000000000',
        solver: '0x0000000000000000000000000000000000000000',
        router: '0x0000000000000000000000000000000000000000',
        quoter: '0x0000000000000000000000000000000000000000',
      };
      const contracts = { ...base };
      for (const k of CONTRACT_KEYS) if (ov[k]) contracts[k] = ov[k] as Address;
      if (!isDeployed(contracts)) {
        throw new BlazeError('bad_request', `contracts override for chain ${chainId} needs both router and quoter`);
      }
      const version = ov.version && /^\d+\.\d+\.\d+$/.test(ov.version)
        ? ov.version
        : pick?.version ?? this.latestKnownVersion(ov.version);
      return { chainId, version, status: 'custom', contracts, source: 'override' };
    }

    if (!pick) {
      const deployed = this.versionsOn(chainId);
      throw new BlazeError('not_deployed',
        `no BlazePhoenix deployment matching version "${selector}" on chain ${chainId}`
        + (deployed.length ? ` (deployed: ${deployed.join(', ')})` : ''),
        { details: { chainId, selector, deployed } });
    }
    const set = pick.chains[chainId]!;
    const src = (k: string) => this.fieldSource[`${pick.version}|${chainId}|${k}`] ?? 'embedded';
    const source: DeploymentSource = src('router') === 'remote' || src('quoter') === 'remote' ? 'remote' : 'embedded';
    return { chainId, version: pick.version, status: pick.status, contracts: { ...set }, source };
  }

  private latestKnownVersion(selector?: string): string {
    const all = this.doc.versions.map((v) => v.version).sort((a, b) => compareVersions(b, a));
    const m = selector ? all.find((v) => matchesSelector(v, selector)) : undefined;
    return m ?? all[0] ?? '2.0.0';
  }

  /** chains × versions table (for dashboards, the MCP, debugging). */
  table(): { chainId: SupportedChainId; version: string; status: string; contracts: ContractSet; source: DeploymentSource }[] {
    const rows: { chainId: SupportedChainId; version: string; status: string; contracts: ContractSet; source: DeploymentSource }[] = [];
    for (const v of this.doc.versions) {
      for (const id of SUPPORTED_CHAIN_IDS) {
        const set = v.chains[id];
        if (!set) continue;
        const s = this.fieldSource[`${v.version}|${id}|router`] ?? 'embedded';
        rows.push({ chainId: id, version: v.version, status: isDeployed(set) ? v.status : 'pending', contracts: { ...set }, source: s });
      }
    }
    return rows;
  }
}
