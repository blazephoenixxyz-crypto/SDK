// =============================================================================
//  Versioned deployment registry — which contracts, of which protocol version,
//  live at which address on which chain.
//
//  THREE LAYERS, applied in this order (see registry.ts):
//    1. EMBEDDED — this file. Ships inside the package, works fully offline.
//       A non-zero address here is a PIN: nothing fetched at runtime can move it.
//    2. REMOTE   — GET https://blazephoenix.xyz/api/deployments (static JSON,
//       same schema). Fills in what the embedded snapshot does not know yet —
//       e.g. the 2.0.0 addresses the day they are deployed — so integrators
//       pick up a new deployment without a new SDK release. Remote-sourced
//       contract sets are cross-checked ON YOUR RPC before first use.
//    3. OVERRIDES — your own `contracts` option. Always wins (your fork, your
//       testnet, your pinned audit target).
//
//  Versions are protocol versions, not SDK versions: 1.0.0 is what is live on
//  chain today; 2.0.0 is the final Core/Hub/Solver/Quoter/Router generation
//  from BlazePhoenix-Dex (every contract's VERSION() returns "2.0.0").
// =============================================================================

import { ZERO_ADDRESS, type SupportedChainId } from './constants.js';
import type { Address } from './types.js';

export interface ContractSet {
  /** BlazePhoenixCore — the deployed library the Solver/Quoter/Router link.
   *  Zero on 1.x (no separately published Core address). */
  core: Address;
  hub: Address;
  solver: Address;
  router: Address;
  quoter: Address;
}

export type DeploymentStatus = 'live' | 'pending' | 'deprecated';

export interface DeploymentVersion {
  /** Protocol semver, e.g. "2.0.0" — what the contracts' VERSION() returns (2.x). */
  version: string;
  status: DeploymentStatus;
  /** BlazePhoenix-Dex revision the bytecode was built from, when known. */
  source?: string;
  notes?: string;
  chains: Partial<Record<SupportedChainId, ContractSet>>;
}

export interface DeploymentRegistry {
  schema: 1;
  updatedAt?: string;
  versions: DeploymentVersion[];
}

const Z = ZERO_ADDRESS;
const pending = (): ContractSet => ({ core: Z, hub: Z, solver: Z, router: Z, quoter: Z });

/** The snapshot shipped with this SDK release. */
export const EMBEDDED_DEPLOYMENTS: DeploymentRegistry = {
  schema: 1,
  updatedAt: '2026-09-25',
  versions: [
    {
      version: '2.0.0',
      status: 'pending',
      source: 'blazephoenixxyz-crypto/Blaze-Phoenix-Dex@07c8563',
      notes: 'Final generation (Core/Hub/Solver/Quoter/Router). Addresses arrive through the registry the day they are deployed.',
      chains: { 8453: pending(), 1: pending(), 10: pending(), 42161: pending(), 4663: pending() },
    },
    {
      version: '1.0.0',
      status: 'live',
      notes: 'The generation live on chain since launch.',
      chains: {
        1: {
          core: Z,
          hub: '0xc4FA9a5720fe3294D3AA9fc427E2a760591E57ae',
          solver: '0xc124d91258db0C14bf13b826CF64E16bfEA8a73e',
          router: '0xE1aE5f49013920CF71De8CED4043e14C4d63416b',
          quoter: '0x4a20AA0912388ff7A9221Ab6BFC224cc20Baa0c3',
        },
        8453: {
          core: Z,
          hub: '0x428554DEe93A1B8B5Bc6Fd19adDAfe55106fc04C',
          solver: '0xB1902990260975dD4C89ad74B1f317bc100CB830',
          router: '0x2a779f9Be49aac57495A8B6467Cc325a8a47Eb9f',
          quoter: '0x4cEF0615614B212895F45Aa1D4833B16666E18d3',
        },
        10: {
          core: Z,
          hub: '0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
          solver: '0x0c0d96B237FABa8FE5e8aE77754Ef29109D2B33f',
          router: '0x7262e7483ab6f0db7b8f90eC3a9de3B02Ab36F6A',
          quoter: '0xfB18EF6f62A0278A273Af4b7A46b454F9E482dc2',
        },
        42161: {
          core: Z,
          hub: '0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
          solver: '0x0c0d96B237FABa8FE5e8aE77754Ef29109D2B33f',
          router: '0x7262e7483ab6f0db7b8f90eC3a9de3B02Ab36F6A',
          quoter: '0xfB18EF6f62A0278A273Af4b7A46b454F9E482dc2',
        },
        4663: {
          core: Z,
          hub: '0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
          solver: '0x0c0d96B237FABa8FE5e8aE77754Ef29109D2B33f',
          router: '0x7262e7483ab6f0db7b8f90eC3a9de3B02Ab36F6A',
          quoter: '0xE1aE5f49013920CF71De8CED4043e14C4d63416b',
        },
      },
    },
  ],
};

export const CONTRACT_KEYS = ['core', 'hub', 'solver', 'router', 'quoter'] as const;
export type ContractKey = (typeof CONTRACT_KEYS)[number];

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export const isZero = (a: string | undefined): boolean => !a || /^0x0{40}$/i.test(a);

/** A set is executable once its Router and Quoter exist. */
export function isDeployed(set: Partial<ContractSet> | undefined): set is ContractSet {
  return !!set && !isZero(set.router) && !isZero(set.quoter);
}

export function parseVersion(v: string): [number, number, number] | undefined {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [0, 0, 0];
  const pb = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Version selector:
 *   'latest'        — the highest version DEPLOYED on the chain (default)
 *   '2' | '2.0'     — the highest deployed 2.x / 2.0.x
 *   '2.0.0'         — exactly that version
 */
export type VersionSelector = 'latest' | (string & {});

export function matchesSelector(version: string, selector: VersionSelector): boolean {
  const s = selector.trim().replace(/^v/i, '');
  if (s === 'latest' || s === '') return true;
  const parts = s.split('.');
  const vp = version.split('.');
  return parts.every((p, i) => p === vp[i]);
}

export function isValidSelector(selector: string): boolean {
  const s = selector.trim().replace(/^v/i, '');
  return s === 'latest' || /^\d+(\.\d+){0,2}$/.test(s);
}

/** What a protocol version can do — the SDK adapts its calls to it. */
export interface VersionFeatures {
  /** Quoter.previewAndEncode[WithMinOut]: preview + ready Router calldata in one call. */
  previewAndEncode: boolean;
  /** Quoter.batchQuote: up to 32 previews in one eth_call. */
  batchQuote: boolean;
  /** Router.swapExactInNative: pay with native ETH, no pre-wrap. */
  nativeEntry: boolean;
  /** Router.swapBestExactIn: solve + execute in the same transaction. */
  swapBest: boolean;
  /** VERSION(), hub(), solver() getters used for on-chain verification. */
  introspection: boolean;
  /** Router emits ExecutionProof (2.x) vs Surplus (1.x). */
  executionProof: boolean;
}

export function featuresOf(version: string): VersionFeatures {
  const major = parseVersion(version)?.[0] ?? 0;
  const v2 = major >= 2;
  return {
    previewAndEncode: v2,
    batchQuote: v2,
    nativeEntry: v2,
    swapBest: v2,
    introspection: v2,
    executionProof: v2,
  };
}

/** Strict structural validation of a registry document (remote input). */
export function validateRegistry(raw: unknown): { ok: true; registry: DeploymentRegistry } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'registry is not an object' };
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1) return { ok: false, error: `unsupported registry schema ${String(r.schema)}` };
  if (!Array.isArray(r.versions)) return { ok: false, error: 'versions must be an array' };
  const versions: DeploymentVersion[] = [];
  for (const v of r.versions as unknown[]) {
    if (!v || typeof v !== 'object') return { ok: false, error: 'version entry is not an object' };
    const e = v as Record<string, unknown>;
    if (typeof e.version !== 'string' || !parseVersion(e.version)) {
      return { ok: false, error: `bad version ${String(e.version)}` };
    }
    const status = e.status === 'live' || e.status === 'pending' || e.status === 'deprecated' ? e.status : 'live';
    if (!e.chains || typeof e.chains !== 'object') return { ok: false, error: `version ${e.version}: chains missing` };
    const chains: Partial<Record<SupportedChainId, ContractSet>> = {};
    for (const [cid, set] of Object.entries(e.chains as Record<string, unknown>)) {
      const id = Number(cid) as SupportedChainId;
      if (![1, 8453, 10, 42161, 4663].includes(id)) continue; // unknown chains are ignored, not fatal
      if (!set || typeof set !== 'object') return { ok: false, error: `version ${e.version} chain ${cid}: not an object` };
      const s = set as Record<string, unknown>;
      const out: Partial<ContractSet> = {};
      for (const k of CONTRACT_KEYS) {
        const a = s[k] ?? ZERO_ADDRESS;
        if (typeof a !== 'string' || !ADDR.test(a)) {
          return { ok: false, error: `version ${e.version} chain ${cid}: ${k} is not an address` };
        }
        out[k] = a as Address;
      }
      chains[id] = out as ContractSet;
    }
    versions.push({
      version: e.version,
      status,
      ...(typeof e.source === 'string' ? { source: e.source } : {}),
      ...(typeof e.notes === 'string' ? { notes: e.notes } : {}),
      chains,
    });
  }
  return {
    ok: true,
    registry: { schema: 1, ...(typeof r.updatedAt === 'string' ? { updatedAt: r.updatedAt } : {}), versions },
  };
}
