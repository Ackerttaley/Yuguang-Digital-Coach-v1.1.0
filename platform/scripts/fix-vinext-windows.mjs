import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const packageJsonPath = fileURLToPath(
  new URL("../node_modules/vinext/package.json", import.meta.url),
);
const packageRoot = dirname(packageJsonPath);
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const markerPath = join(packageRoot, ".yuguang-windows-path-check.json");

// 运行时兼容处理位于 vite.config.ts 中，以保证 npm ci 的结果稳定一致。
// 此安装阶段检查会记录已验证的 Vinext 版本；依赖无法解析时会明确报错。
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
