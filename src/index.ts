#!/usr/bin/env node
/**
 * j-can-see MCP server 入口（stdio 传输）。
 *
 * 仅暴露一个 see_image 工具。配置缺失 → 启动即崩并打印原因（fail fast）。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { seeImage, SEE_IMAGE_TOOL, seeImageArgsSchema } from "./tool.js";
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
  const config = loadConfig();

  const server = new Server(
    { name: "j-can-see", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [SEE_IMAGE_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== "see_image") {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `未知工具：${name}` }],
      };
    }

    const parsed = seeImageArgsSchema.safeParse(args);
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
      const text = await seeImage(parsed.data, config);
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
  console.error(
    `[j-can-see] ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
}
