// =============================================================================
//  Router rescue and renunciation events, across protocol versions.
//
//  Two Router control doors changed their event; the legacy form is the earlier one:
//
//    door             legacy form                          current 2.0.0 form
//    cancelRescue     RescueQueued(token, to, 0)          RescueCancelled(token, to)
//    renounceControl  Cfg(0, address(0))                  ControlRenounced()
//
//  The live 1.0.0 Routers have no rescue door: they emit only Cfg(0, address(0))
//  from renounceControl (source verified on Sourcify). RescueQueued(token, to, 0)
//  is the cancel of 2.0.0 sources before the rename. RescueQueued (eta > 0) from
//  queueRescue and Cfg from the setters stay. The legacy forms are unambiguous:
//  queueRescue writes eta = block.timestamp + 48h, never 0, and setAdmin refuses
//  address(0) in every version, so a RescueQueued with eta 0 can only be a cancel
//  and a Cfg(0, 0) only a renunciation. The decoder therefore reads every version
//  without being told which one emitted the log.
//
//  The caller filters by Router address: the Hub and the Gate also emit
//  ControlRenounced(), with the same topic0.
// =============================================================================
import { decodeEventLog, zeroAddress, type Hex } from 'viem';
import type { Address } from './types.js';

/** The Router events the decoder reads, as the Dex sources declare them. */
export const ROUTER_CONTROL_EVENTS_ABI = [
  {
    type: 'event', name: 'RescueQueued', inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'eta', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'RescueCancelled', inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event', name: 'Cfg', inputs: [
      { name: 'id', type: 'uint8', indexed: false },
      { name: 'who', type: 'address', indexed: false },
    ],
  },
  { type: 'event', name: 'ControlRenounced', inputs: [] },
] as const;

/** A rescue or renunciation event. `legacy` is true when the log has the legacy form. */
export type RouterControlEvent =
  | { kind: 'RescueQueued'; token: Address; to: Address; eta: bigint }
  | { kind: 'RescueCancelled'; token: Address; to: Address; legacy: boolean }
  | { kind: 'ControlRenounced'; legacy: boolean };

/**
 * Decode one Router log into a rescue or renunciation event, in either version's
 * form. Returns undefined for every other log: unknown topic0, a malformed log,
 * and the Cfg logs of the setters (admin, treasuries, Permit2, WETH).
 */
export function decodeRouterControlLog(
  log: { topics: readonly Hex[]; data: Hex },
): RouterControlEvent | undefined {
  let ev;
  try {
    ev = decodeEventLog({
      abi: ROUTER_CONTROL_EVENTS_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true,
    });
  } catch {
    return undefined;
  }
  switch (ev.eventName) {
    case 'RescueQueued': {
      const { token, to, eta } = ev.args;
      return eta === 0n
        ? { kind: 'RescueCancelled', token, to, legacy: true }
        : { kind: 'RescueQueued', token, to, eta };
    }
    case 'RescueCancelled':
      return { kind: 'RescueCancelled', token: ev.args.token, to: ev.args.to, legacy: false };
    case 'ControlRenounced':
      return { kind: 'ControlRenounced', legacy: false };
    case 'Cfg':
      return ev.args.id === 0 && ev.args.who === zeroAddress
        ? { kind: 'ControlRenounced', legacy: true }
        : undefined;
  }
}
