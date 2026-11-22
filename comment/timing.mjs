// ============================================================
// 评论链路的时序、重试与扫描预算（唯一定义源）—— R4
//
// 为什么是 .mjs 而不是 config/comment.json：
//   config/_README.md 已经把"超时 / 输出上限这类行为参数"列为不进 config 的红线
//   （"改一个 JSON 字段就改超时"）。本文件的目的不是把行为外置成可热改配置，
//   而是消除散落字面量：值仍然在代码里、仍然由测试锁住，想改必须过 git review。
//   审查报告 R4 原提议新建 config/comment.json，与这条红线冲突，故改为代码内单点。
//
// 两类常量，注入方式不同（这是本文件最重要的注释）：
//   1. Node 侧调度常量 —— 本文件导出，comment-browser.mjs 直接引用；
//   2. 页内序列化代码里的字面量（installInputWitness / readCommentDomCore）——
//      它们要 toString() 进浏览器，**抓不到模块作用域**。直接引用会静默变成
//      undefined（比硬编码更坏）。所以：eventGateMs 经 input 载荷传参，
//      扫描预算经 new Function 模板字符串插值。两者都有测试锁住。
// ============================================================

export const COMMENT_TIMING = Object.freeze({
  // 填写期持续核对的节拍。40ms 时一次评论可产生每秒 150–200 次 CDP 往返；
  // 120ms 仍是"人眼不可感知"的检测延迟，且每次点击前都有完整的最终核对。
  postPollMs: 120,
  // 每 N 拍做一次发布控件的全量重查（findCommentSubmit，单次约 5 个往返）。
  // 1 = 每拍都查（重构前行为）；4 ≈ 每 480ms 一次。点击前的决策点另有 full 核对。
  fullRecheckEvery: 4,
  // waitCommentState 的轮询间隔。
  stateTickMs: 75,
  // 几何稳定采样：连续 stableSamples 次一致才算稳定。
  stableSampleMs: 75,
  stableSamples: 3,
  stableTimeoutMs: 3000,
  // 激活空的评论输入区后，等待编辑器出现的上限。
  activationTimeoutMs: 1500,
  // 等待发布控件可用的上限。
  enableTimeoutMs: 3000,
  // 键入延迟：逐个字符输入，模拟真人节奏。
  typeDelayMs: 10,
  // 点击后回读新评论：重试次数与间隔。
  readbackAttempts: 12,
  readbackMs: 150,
  // 页内事件门禁窗口：布防后超过该时长的事件一律拦截。经 input 载荷传入页内。
  eventGateMs: 1500,
});

// 公开评论文本重建的预算。经 new Function 模板插值进 readCommentDomCore。
export const COMMENT_SCAN_BUDGET = Object.freeze({
  nodes: 180,
  textLength: 512,
  images: 8,
  altLength: 32,
});

// 收据容量上限：落盘前裁剪。receipt-baseline.mjs 在 >4MB 时会直接抛错，
// 而一条收据的 knownIds 最多 2000 个，所以必须按"条数 + 字节"双上限裁剪。
export const COMMENT_RECEIPT_LIMIT = Object.freeze({
  confirmedItems: 200,
  budgetBytes: 1_000_000,
});
