// Loads one kiro-acp test file through pi's dependency tree.
//
// pi's own packages (pi-ai, pi-coding-agent) ship an exports map with only an
// ESM `import` condition, so the CommonJS resolver jiti uses by default cannot
// load them (ERR_PACKAGE_PATH_NOT_EXPORTED). Alias them to the same entry
// points pi's extension loader injects (core/extensions/virtual-modules.js)
// and keep NODE_PATH out of the picture.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PI_NODE_MODULES =
  process.env.PI_NODE_MODULES ??
  join(process.execPath, "../../lib/node_modules/@earendil-works/pi-coding-agent/node_modules");

const { createJiti } = await import(
  pathToFileURL(join(PI_NODE_MODULES, "jiti/lib/jiti.mjs")).href
);

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-ai": join(
      PI_NODE_MODULES,
      "@earendil-works/pi-ai/dist/compat.js",
    ),
    "@earendil-works/pi-coding-agent": join(
      PI_NODE_MODULES,
      "@earendil-works/pi-coding-agent/dist/index.js",
    ),
  },
});

await jiti.import(pathToFileURL(join(process.cwd(), process.argv[2])).href);
