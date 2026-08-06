/**
 * 应用配置：从环境变量读取并校验。
 *
 * 设计原则：缺必填项 → 启动即崩并打印清晰原因（fail fast），
 * 不带残缺配置进入运行时。
 */
import { z } from "zod";
import { ConfigError } from "./errors.js";

const envSchema = z.object({
  // 识图通道专用 key（必须显式配置，不内嵌）
  J_SEE_TOKEN: z
    .string()
    .min(1, "J_SEE_TOKEN 未配置：需要视觉模型的 API key"),

  // CLIProxyAPI / 兼容端点的根地址（必须显式配置）
  // 末尾斜杠在此处统一去除，下游直接拼接路径
  J_SEE_BASE_URL: z
    .string()
    .min(1, "J_SEE_BASE_URL 未配置")
    .url("J_SEE_BASE_URL 不是合法 URL")
    .transform((s) => s.replace(/\/+$/, "")),

  // 视觉模型名
  J_SEE_MODEL: z.string().min(1).default("grok-4.5"),

  // 推理强度。实测 CLIProxyAPI 转换层不会把 none 真正关到 0，
  // 但 none 仍能比默认快约一倍、省约 28% token，且识别质量无损
  J_SEE_REASONING: z
    .enum(["none", "low", "medium", "high"])
    .default("none"),

  // 图片压缩目标：长边像素上限
  J_SEE_MAX_EDGE: z.coerce.number().int().positive().default(1568),

  // 源文件体积上限（字节），超出直接拒绝以防解码爆内存
  J_SEE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),

  // 视觉调用超时（毫秒）。需短于 CF Tunnel 的 100s 上限，
  // 让客户端先于 524 给出清晰错误
  J_SEE_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * 读取并校验配置。失败抛 ConfigError。
 * @param env 可注入，便于测试；默认读 process.env
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`配置无效，请检查环境变量：\n${issues}`);
  }
  return parsed.data;
}
