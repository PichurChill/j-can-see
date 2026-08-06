/**
 * 错误类型定义。
 *
 * 按来源区分，便于上层（tool 编排 / MCP 响应）精确呈现原因，
 * 而不是用一个泛型 Error 模糊归因。
 */

/** 配置错误：环境变量缺失或非法，启动期即可暴露 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 来源错误：图片获取阶段失败（文件不存在、剪贴板无图、下载失败等） */
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

/** 图片处理错误：解码失败、格式不支持、体积超限等 */
export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageError";
  }
}

/** 视觉调用错误：HTTP 401/429/5xx/超时等。携带 status 便于区分 */
export class VisionError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "VisionError";
    this.status = status;
  }
}
