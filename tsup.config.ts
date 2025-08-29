import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"], // build for both require() and import
  dts: true,              // generate .d.ts
  clean: true,
  sourcemap: true,
  target: "es2022"
});
