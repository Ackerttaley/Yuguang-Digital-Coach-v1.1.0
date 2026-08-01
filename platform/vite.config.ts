import vinext from "vinext";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const LOCAL_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const d1 = process.env.CLOUDFLARE_D1_BINDING ?? null;
const r2 = process.env.CLOUDFLARE_R2_BINDING ?? null;

// Vinext 清单保存的是 URL 数据，而不是文件系统路径。此后处理可防止
// Windows 路径分隔符进入最终生成的 CSS 和 JS 地址。
function normalizeWindowsAssetUrls(): Plugin {
  const normalize = (value: string) =>
    value.replace(
      /\b(src|href)=(["'])([^"']*)\2/gi,
      (_match, attribute: string, quote: string, url: string) =>
        `${attribute}=${quote}${url.replaceAll("\\", "/")}${quote}`,
    );
  return {
    name: "normalize-windows-asset-urls",
    enforce: "post",
    transformIndexHtml: { order: "post", handler: normalize },
    generateBundle(_options, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type === "asset" && asset.fileName.endsWith(".html")) {
          asset.source = normalize(String(asset.source));
        }
      }
    },
  };
}

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "yuguang-local-d1",
          database_id: LOCAL_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "yuguang-local-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // 将 Wrangler 和 Miniflare 的状态保存在项目目录内。这些属于非敏感工具配置；
  // 应用环境变量应放在已忽略的 `.env*` 文件中。
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler 会在导入 Cloudflare 插件时保存当时的日志路径。
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {

    plugins: [
      vinext(),
      normalizeWindowsAssetUrls(),

      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
