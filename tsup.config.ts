import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'xray/index': 'src/xray/index.ts', 'find/index': 'src/find/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // viem is an optional peer — never bundled, lazily imported at runtime.
  external: ['viem'],
});
