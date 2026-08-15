#!/usr/bin/env node
/**
 * j-can-see MCP server 入口（stdio 传输）。
 *
 * 暴露一组视觉/像素工具（see_image / locate / inspect / ...）。
 * 视觉配置为懒校验：缺 J_SEE_* 时 server 照常启动、本地像素工具全部可用，
 * 仅在 stderr 留警告；视觉工具在调用时才完整校验并返回 ConfigError。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, loadBaseConfig } from "./config.js";
import { listTools, getTool } from "./tools/registry.js";
import { VERSION } from "./version.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// 辅助命令：导出 Claude Code PreToolUse hook 脚本，便于一行安装：
//   npx j-can-see --hook > ~/.claude/hooks/block-image-read.mjs
const argv = process.argv.slice(2);
if (argv.includes("--hook") || argv.includes("--print-hook")) {
  const hookPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "hooks",
    "block-image-read.mjs",
  );
  try {
    process.stdout.write(readFileSync(hookPath, "utf8"));
  } catch {
    process.stderr.write(
      "无法定位 hook 脚本，请从仓库获取 hooks/block-image-read.mjs\n",
    );
    process.exit(1);
  }
  process.exit(0);
}

function main(): void {
  // 视觉配置懒校验：缺 J_SEE_* 时 server 仍启动（本地工具可用），
  // 仅在 stderr 留警告；视觉工具调用时才做完整校验并返回 ConfigError
  try {
    loadConfig();
  } catch (e) {
    console.error(
      `[j-can-see] 视觉配置缺失，仅本地工具（crop/image_diff/colors/trace/extract_fg）可用：\n${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  const server = new Server(
    { name: "j-can-see", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const entry = getTool(name);
    if (!entry) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `未知工具：${name}` }],
      };
    }

    const parsed = entry.schema.safeParse(args);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `参数错误：${parsed.error.issues
              .map((i) => i.message)
              .join("; ")}`,
          },
        ],
      };
    }

    try {
      // 判别联合按 needsVision 收窄：本地工具拿 BaseConfig（零视觉配置可用），
      // 视觉工具拿完整校验过的 AppConfig
      const text = entry.needsVision
        ? await entry.run(parsed.data, loadConfig())
        : await entry.run(parsed.data, loadBaseConfig());
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      // 运行期错误（来源/图片/视觉调用）以 isError 形式返回，
      // 让客户端看到清晰原因而非崩溃
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  });

  const transport = new StdioServerTransport();
  server.connect(transport).catch((e) => {
    console.error(
      "[j-can-see] 连接传输失败：",
      e instanceof Error ? e.message : String(e),
    );
    process.exit(1);
  });
}

try {
  main();
} catch (e) {
  // 启动期错误（主要是配置缺失）—— 打印清晰原因后退出
  console.error(`[j-can-see] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
