import { readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL(".", import.meta.url));
const sources = await readdir(new URL("src/", import.meta.url));
const entries = sources.filter((file) => file === "plugin.ts" || file === "plugin.tsx");
if (entries.length !== 1) {
  throw new Error("Expected exactly one src/plugin.ts or src/plugin.tsx");
}

const result = await build({
  absWorkingDir: root,
  entryPoints: [`src/${entries[0]}`],
  outfile: "plugin.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "transform",
  legalComments: "inline",
  metafile: true,
  write: false,
});

const [module, ...otherOutputs] = Object.values(result.metafile.outputs);
if (otherOutputs.length || module.imports.length) {
  throw new Error("Buzz requires one JavaScript module with no runtime imports");
}
if (!module.exports.includes("apply") || !module.exports.includes("inject")) {
  throw new Error("A Buzz plugin must export apply and inject");
}
await writeFile(new URL("plugin.js", import.meta.url), result.outputFiles[0].contents);
console.log(`Built plugin.js (${module.bytes} bytes)`);
