// service/reply-timing.mjs —— 回复时序埋点的纯计算（迭代 4，第一个 Phase B 新模块）
//
// 重构前，这行埋点散在 chat-service.mjs 的回复流程里：
//   this.log('reply.timing', { recipientId: contact.id, modelMs: tModelEnd - tModelStart,
//     rereadMs: tRereadEnd - tModelEnd, totalBeforeSendMs: Date.now() - tModelStart });
//
// 这里只抽出**计算**：三处 Date.now() 的采集时机仍留在 chat-service.mjs 原位置，
// 因为"什么时候取时间戳"本身就是埋点语义的一部分，挪动会改变指标。
// 字段名与键序是日志契约（下游巡检脚本按字段读数），改动前先改
// tests/reply-timing.test.mjs 并有意更新。

export function buildReplyTiming({ recipientId, tModelStart, tModelEnd, tRereadEnd, now }) {
  return {
    recipientId,
    modelMs: tModelEnd - tModelStart,
    rereadMs: tRereadEnd - tModelEnd,
    totalBeforeSendMs: now - tModelStart,
  };
}
