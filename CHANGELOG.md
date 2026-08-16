# Changelog

## [0.5.0] - 2026-08-14

### Added
- **视觉工具链**：从单一 `see_image` 扩展为 9 个分工工具，AI 按任务自动编排
  - `see_image` 增强：`region` 局部放大（先裁后看）+ 多图对比（向后兼容）
  - `locate`：定位单个目标 → 像素坐标（自动换算为原图坐标）
  - `inspect`：枚举所有同类元素 → 编号列表 + 文字 + 坐标
  - `ocr_long`：长截图 / 长页面分块 OCR + 重叠区合并去重
  - `crop`：按坐标裁剪存文件（可放大，BICUBIC）
  - `image_diff`：两图逐像素差异 → 差异% + 差异区域坐标
  - `colors`：主色分析 + 候选色精确匹配（色差计算）
  - `trace`：扁平高对比图形矢量化 → SVG（新增依赖 `@image-tracer-ts/core`）
  - `extract_fg`：图标前景提取 → 透明 PNG
- `SKILL.md`：工具选择决策树 + 粗到细方法论 + 5 个场景 playbook
- 工具注册表架构（`src/tools/`），新增工具只需注册一项

### Changed
- `vision.ts`：`VisionInput` 改为多图（`images` 数组），单图是其特例
- `index.ts`：改用注册表分发，支持任意数量工具
- `image.ts`：新增 `cropAndProcess` / `processImageWithScale` / `parseRegion`，导出 `decodeJimp` 供本地工具复用

### Fixed（评审修复）
- **region 越界不再触发 jimp 裸 RangeError**：`resolveRegion` 把轻微越界收进图片边界、完全越界抛带图片尺寸的 ImageError；locate/inspect 返回的坐标同样 clamp——「定位 → region 回环」链路全程自洽
- **crop/extract_fg 非文件 source 的默认输出路径修复**：URL/clipboard/latest 省略 `output` 时立即报"必须显式指定 output"（原先会写出 `https:/...` 非法路径或静默污染进程 cwd）；输出路径决策提前到读取图片之前（fail fast）
- **颜色输入不再静默出错**：非法 hex（如 `#xyz`）抛 ImageError（原先解析为 NaN，colors 会静默返回错误候选、extract_fg 会输出未抠过的原图）
- **extract_fg 阈值语义修正**：改用线性色差（三通道绝对差最大值，0-255），文档方向描述与实现一致（越小保留越多）；零前景时附明确警告
- **colors 返回真实均值色**（原量化色 `#f80000` → 现精确 `#ff0000`），并跳过完全透明像素（全透明图返回明确提示）
- **locate/inspect/ocr_long 契约与实现一致**：schema 明确拒绝数组 source（原先声明多图但静默只取第一张）
- **坐标解析健壮性**：标签词边界（`x12:`/`box1:` 不再污染 x1）；inspect 标签剥离只认带分隔符的坐标（`1920x1080` 等正文不再被吃掉），剥除 markdown 列表符号避免双重编号
- **ocr_long 去重比较忽略空白差异**（模型对重叠区文字轻微改写时仍能去重）
- **image_diff 尺寸不一致时披露对齐行为**；threshold 范围修正为 0-765（三通道之和）
- **crop 放大改用 BICUBIC**（jimp 1.6 无 LANCZOS，原描述与默认双线性实现不符）；`output` 支持 `~` 展开
- **url.ts 漏改的版本号**（`j-can-see/0.1`）统一从 package.json 读取
- `see_image` 的 region+多图互斥改为 zod 校验错误（原为运行期裸 Error）
- 修正 `Server` version（原硬编码 `0.4.1`）与 `USER_AGENT`（原写死 `0.1`）与 `package.json` 的版本号不一致——现统一从 `package.json` 运行时读取

### Fixed（第二轮评审修复）
- **非整除缩放比下的坐标回环修复**：`processImageWithScale` 改为缩放前保存真实 `originalWidth/Height`（原先用缩放后尺寸÷scale 反推，3137×1568 这类图会得到 1568.5 小数，locate 输出小数坐标被 region 整数校验拒绝）
- **ocr_long 去重边界审计**：合并时记录每条边界删除的具体行并附误删风险提示（重叠区去重无法区分「重叠行」与「原文连续重复行」，如聊天记录重复消息；可用 see_image region 复核边界）
- **纯本地模式（视觉配置懒加载）**：缺 `J_SEE_*` 时 server 正常启动、本地工具全部可用（stderr 留警告），视觉工具调用时才校验并返回 ConfigError——原先无条件启动崩溃
- **crop 默认输出路径支持 `~` 展开**（`~/x.png` → `$HOME/x_crop.png`，原先写出字面 `~/x_crop.png` 导致 ENOENT）
- **crop 按输出扩展名编码**（`.jpg/.jpeg` → JPEG q90，原先 .jpg 文件里是 PNG 字节）
- **inspect 标签清理加前置词边界**：`box1: 20` 这类正文不再被误吃成 `bo`
- **输出 token 上限可按工具覆盖**：`VisionInput.maxTokens`（responses 映射 `max_output_tokens`）；inspect/ocr_long 用 8192（原三规范不一致且 2000 对密集列表/长文会截断）
- **locate 多匹配如实输出**：模型返回多个 box 时全部列出并提示细化 target（原先静默取第一个）
- package-lock.json 版本与 package.json 同步（0.5.0）

### Added / Changed（实测会话驱动的体验优化）

- **ocr_long 总时间预算 + 部分返回**：新增 `J_SEE_OCR_TOTAL_TIMEOUT_MS`（默认 85s，低于常见客户端 MCP 工具超时如 ZCode 100s）。多块 OCR 预算耗尽时不再整单失败——返回已完成块的合并文本 + 未处理块的 y 区间 + crop 补齐建议；正文缺口处插入显式标记。真实错误（网络/上游拒绝）仍 fail fast。实测动机：860×7264 长图 6 块并发总时长破客户端 100s，整单被掐、颗粒无收
- **callVision 支持单次超时覆盖**（`timeoutMs` 参数）：ocr_long 把每块超时压到剩余预算
- **locate NOT_FOUND 附可操作建议**：提示长图先 crop 局部化再定位、或改用 inspect 枚举（实测中模型在压缩后的长图上必然找不到，干巴巴的"未找到"误导 AI 得出"定位功能不好用"）
- **crop/extract_fg/trace 输出目录自动创建**（`mkdir -p`）：实测 AI 写新路径时 7 次 ENOENT 失败可避免
- **启动清扫剪贴板中转残留**：server 启动时删除 os.tmpdir() 下自身命名空间（`j-can-see-clip-*.png`）的残留文件——正常路径由 finally 清理，仅进程被强杀时可能漏
- **工作区约定**（SKILL.md）：中间产物进项目 `.j-can-see/<task>/`（首建时入 .gitignore、任务结束清理），交付物显式写正式路径——实测 AI 自选 /tmp/design 散落 24 文件无人清理
- **文档**：README 中英补三层超时机制说明与 locate/inspect 的模型 grounding 选型建议（grok 系列定位偏弱，坐标任务建议 Gemini/Qwen-VL 类）

### Fixed（第四轮评审修复）

- **修复部分返回的假缺口标记（必现）**：拼装循环 `prev = -2` 初值导致「三块全部完成」的正文开头也插入一行描述为空的 `⋯⋯［ 未完成，内容缺失］⋯⋯`——「有标记 ⇔ 真缺块」是部分返回设计的支点，假标记会让 AI 误以为开头丢内容而触发无谓补齐。拼装逻辑抽为纯函数 `assembleChunks`（首块不产生标记；开头/中间/尾部缺口给出准确块号与 y 区间），契约由 5 组独立测试锁定，集成测试补反向断言「全部完成时不得出现内容缺失」
- **预算内错误分类从「按发生时刻」改为「按错误类型」**：超时（`VisionError` + 视觉调用超时）→ 该块记未处理；其余错误哪怕恰在 deadline 之后到达也照常 fail fast 上报（原先按 `remaining() <= 0` 判断，理论上会把 deadline 后到达的真实故障吞成未处理）
- **剪贴板中转清扫加 10 分钟 mtime 门限**：并行第二个实例正处于「写入→读取」窗口的新文件不再被启动清扫误删
- 测试修正：替换一条零验证力的超时用例（mock 立即返回只证明不崩 → 改为小超时 + 尊重 abort 的慢上游，真实走默认超时路径）
- **真实错误立即取消全部在途块调用**：`callVision` 新增外部 `AbortSignal` 参数，`ocrWithBudget` 在首个非超时错误时 abort 共享信号 —— fail fast 不再等在途调用各自跑满超时（原先最坏为数倍单次超时才见错误）。被取消的调用以超时同型错误退出，不影响已记录的真实错误优先上报

### Fixed（第五轮评审修复）

- **修复「传入时已 aborted 的 signal 不生效」**：`addEventListener` 对已触发过的 abort 事件不会回调，而传给 fetch 的是内部 controller.signal —— 并行块失败恰落在另一块的 JPEG 编码窗口（几十至几百 ms）时，该块的请求会照常发出、要等自身超时。现在 `callVision` 入口显式检查 `signal.aborted` 立即同步取消
- **超时分类从「中文文案匹配」改为类型契约**：新增 `VisionTimeoutError extends VisionError` 子类（`instanceof VisionError` 处仍成立，向后兼容），`callVision` 超时抛子类、`ocrWithBudget` 按 `instanceof` 分类 —— vision.ts 的报错文案从此可以随意改，不会再静默破坏 ocr 的部分返回设计。补两个针对性测试：传入时已 aborted 的 signal 立即生效；真实 `callVision` 超时端到端归类为未处理（跨模块类型契约生效）
- `assembleChunks` 的首块守卫从 `merged &&`（隐含依赖「每块内容非空」这一 callVision 的外部保证）改为显式的 `prev >= 0 &&`，语义直白不再有隐藏依赖

### Fixed（第六轮评审，小项收口）

- 补上「传入时已 aborted」用例中缺失的 `fetchCalled` 断言 —— 固化行为契约：实现仍带着 aborted signal 调 fetch（不跳过调用），快速退出依赖 fetch 规范的立即拒绝
- **测试纳入类型检查**：新增 `tsconfig.test.json`（覆盖 src + test，noEmit），`npm test` 先跑 typecheck 再跑 vitest，`prepublishOnly` 同样把关 —— 此前 tsconfig 只含 src，vitest 剥类型不查，测试里的类型错误静默放行
- 「没有任何块完成」的提示补齐调参旋钮：块耗时超单次超时应调 `J_SEE_TIMEOUT_MS`（此前文案只提总预算与客户端超时，指向了错误的旋钮）
- 注记（不改动）：`ocrWithBudget` 任一块超时即停发新块是保守策略 —— 单块异常慢通常意味着上游整体变慢，继续发块大概率白烧调用费；未处理块在输出中如实列出

### Fixed（第三轮评审修复）

两个实测复现的功能缺陷：

- **extract_fg 自动采样背景色失效**：`sampleBackground` 把 5 位量化值直接当背景色返回，量化误差最多 7/通道。实测背景 `#FEFEFE` + `threshold=4` 时输出 `1600/1600 像素为前景`（原图原样吐出，一个背景像素都没抠掉）；显式传 `background` 才正确。默认 `threshold=64` 掩盖了它，**只要按文档调小阈值做精确抠图就会踩中**。现改为与 `colors` 共用 `createColorClusters`（量化仅作聚类键、输出簇内真实均值），该累加器不提供拿到量化值的出口，结构上杜绝复发
- **ocr_long 部分边界去重失败时完全静默**：`mergeTwo` 要求首尾行完全一致，而行被切断导致两侧转录不一致是分块 OCR 的常态。实测重复内容原样进入结果，审计却只报成功去重的边界，失败的零提示，且全部失败时输出「各块边界未发现重叠内容」——把失败陈述成了正常。现每条边界都必须给出结论：成功列出删除行，失败明确警告「未能识别重叠内容，此处可能残留重复文字」并附可复核的原图 y 区间。**匹配算法保持保守不变**（重叠判定本质不可判定，放宽会引入误删）

设计债与健壮性：

- **配置类型分层**：`loadLocalConfig` 用空串伪造视觉三项（类型撒谎）→ 拆为 `BaseConfig` / `AppConfig`，`loadBaseConfig` 不再伪造字段；`ToolEntry` 改判别联合（`needsVision` 必填），本地工具的 `run` 只吃 `BaseConfig`，标错在编译期即报错，不会再拿空 token 打到上游变成网络错误
- **消除为测试而写的生产防御**：`see.ts` 的 `Array.isArray(source)` 分支（schema transform 后恒为数组）随测试统一走 `schema.parse` 一并删除；同类死代码兜底清理（`coords.ts` 的 `scale > 0 ? … : 1`、`resolveRegion` 的 `Math.max(0, x)`、`version.ts` 的 `?? "0.0.0"`）
- **解码内存上限（根因修复）**：`J_SEE_MAX_BYTES` 只管压缩后体积，拦不住高压缩比图（大面积纯色 PNG 压缩比可达 100:1）。新增 `J_SEE_MAX_PIXELS`（默认 40M 像素），用 `image-size` 在**解码前**从 header 读尺寸判定
- **image_diff 处理透明度**：双方全透明的像素视为相同（RGB 是未定义值），透明度变化直接计为差异
- **语义如实披露**：`image_diff` 返回的是 12×12 网格块而非精确包围盒；`colors` 的 5 位分桶不适合渐变/照片。措辞与工具描述同步更正
- **消除重复真值来源**：来源判定收敛为 `classifySource`（原 `readSource` 与 `pixels.ts` 各一份，会随新增来源漂移）；`writeOutput`/`deriveDefaultOutput`/`encodeForOutput` 提取到 `tools/output.ts`（原在两文件逐字重复）；region 格式统一由 `REGION_PATTERN` 定义
- **ocr_long 性能与边界**：去掉每块一次的全图 `clone`（改为 `Jimp.fromBitmap` 只分配块大小的 buffer，省下每块数十 MB 的 memcpy；注：修的是分配流量与 GC 压力，内存峰值本就是 ~2× 而非 N×）；并发 4 块；超过 16 块在切块前 fail fast 并提示先 `crop` 分段
- **trace 类型断言收敛**：原 `as unknown as Uint8ClampedArray` 是谎报（Buffer 不是 Uint8ClampedArray），现用零拷贝视图构造真正的 `Uint8ClampedArray`，只保留一处不可避免的断言（Node lib 无 DOM `ImageData`）
- **新增 registry 测试**：工具名唯一性、`required` 字段声明完整性、`needsVision` 标记正确性，以及「本地工具在零视觉配置下全部可用且不触网」——这是原先完全没有防线的一处

## [0.4.2] 及更早
- 单工具 `see_image` 版本（本地文件 / URL / 剪贴板 / 最近截图 → 视觉模型文字描述）
- 支持 responses / openai / anthropic 三种上游 API 规范
