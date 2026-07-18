#!/usr/bin/env bun
import type { BunPlugin } from "bun";

// bun-plugin-tailwind 0.0.15 publishes a syntactically invalid index.d.ts.
// Keep the runtime import while containing that upstream declaration defect at
// this typed integration boundary.
const tailwindModuleName: string = "bun-plugin-tailwind";
const { default: tailwind } = await import(tailwindModuleName) as { default: BunPlugin };

await Bun.build({
  entrypoints: ["./src/index.html"],
  outdir: "./dist",
  minify: true,
  plugins: [tailwind],
});
