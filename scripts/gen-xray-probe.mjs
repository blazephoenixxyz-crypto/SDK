import fs from 'node:fs';
const [pinPath, out] = process.argv.slice(2);
const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
const s = `// Generated from deep-xray@8d6e81c sim/probe.pinned.json (solc ${pin.solc}, flags ${pin.flags.join(' ')}).
// The keccak below is a literal on purpose (IC7): it is NOT derived from PROBE_RUNTIME, so a changed
// runtime cannot carry its own pin. The test recompiles the probe when solc 0.8.30 is available.
export const PROBE_SOLC = ${JSON.stringify(pin.solc)};
export const PROBE_FLAGS = ${JSON.stringify(pin.flags)} as const;
export const PROBE_KECCAK = '0xdc31eef19b438288846792692c047ab5ef8a6fe17fda0fc89282f7e8d357afe8' as const;
export const PROBE_SELECTOR = '0x61153369' as const;
export const PROBE_RUNTIME = ${JSON.stringify(pin.runtime)} as const;
export const PROBE_ABI = ${JSON.stringify(pin.abi)} as const;
`;
if (pin.keccak !== '0xdc31eef19b438288846792692c047ab5ef8a6fe17fda0fc89282f7e8d357afe8') throw new Error('pin differs');
fs.writeFileSync(out, s);
