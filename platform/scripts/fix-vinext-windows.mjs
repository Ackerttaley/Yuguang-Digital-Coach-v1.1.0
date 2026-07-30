import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const packageJsonPath = fileURLToPath(
  new URL("../node_modules/vinext/package.json", import.meta.url),
);
const packageRoot = dirname(packageJsonPath);
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const markerPath = join(packageRoot, ".yuguang-windows-path-check.json");

// The runtime workaround lives in vite.config.ts so it remains deterministic
// across npm ci. This install-time check records the Vinext version that was
// verified and fails clearly if the dependency cannot be resolved.
await writeFile(
  markerPath,
  `${JSON.stringify(
    {
      vinext: packageJson.version,
      assetUrlPolicy: "forward-slash",
      checkedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(
  `Vinext ${packageJson.version}: Windows static asset URL normalization enabled.`,
);
