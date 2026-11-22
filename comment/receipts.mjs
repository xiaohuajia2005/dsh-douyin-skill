// ============================================================
// 评论发布收据的容量裁剪 —— R5
//
// 为什么这不是"洁癖优化"：
//   receipt-baseline.mjs 的 writeDurableReceiptFile() 在序列化结果 >4MB 时
//   **直接抛错**（"本地收据超过有界大小，未执行输入"）。而 comment-browser
//   从不裁剪 operations，每条收据的 baseline.knownIds 最多还能有 2000 个编号。
//   也就是说：评论发到一定次数后，写收据会永久失败 ——
//   表现是"每条评论都失败"，而不是"文件有点大"。这是可用性缺陷。
//
// 裁剪策略（顺序即优先级）：
//   1. 未结案（clicking / uncertain）**永不删除**：前者代表"可能已经点过"，
//      后者代表"结果不明，待人工核对"。删掉它们等于允许对同一作品再发一条。
//   2. 已结案（confirmed）只保留最近 confirmedItems 条。
//   3. 仍超过 budgetBytes 时，继续从最旧的 confirmed 开始丢，直到达标。
//   4. 只有未结案就超预算时才放弃裁剪，让上游照旧 fail-safe 抛错。
//
// 代价（必须写在明处）：同一作品的"永不重复评论"去重窗口，
//   从"永久"收窄为"最近 confirmedItems 条已确认 + 全部未结案"。
//   自主评论链路还有 autonomous-comments.mjs 的台账在做全量去重，
//   这里的收窄只影响直接调用 post() 的场景，且窗口仍是数百条量级。
// ============================================================

const UNRESOLVED = new Set(['clicking', 'uncertain']);
const unresolved = operation => UNRESOLVED.has(operation?.status);

const timeOf = operation => {
  const value = Date.parse(operation?.completedAt || operation?.startedAt || '');
  return Number.isFinite(value) ? value : 0;
};

// 纯函数：不读盘、不抛错（输入非法时原样返回，交由 receipts() 的校验去拒绝）。
export function trimCommentReceipts(value, { confirmedItems = 200, budgetBytes = 1_000_000 } = {}) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.operations)) return value;
  const size = input => JSON.stringify(input).length;

  const keep = new Set();
  const confirmed = [];
  for (const operation of value.operations) {
    if (unresolved(operation)) keep.add(operation);
    else confirmed.push(operation);
  }
  // 新的在前，按时间倒序；同时间戳按原顺序稳定（记录越靠后越新）。
  const ordered = confirmed.map((operation, index) => ({ operation, index })).sort((left, right) => timeOf(right.operation) - timeOf(left.operation) || right.index - left.index);
  let retained = ordered.slice(0, Math.max(0, confirmedItems));
  for (const entry of retained) keep.add(entry.operation);

  let next = value.operations.filter(operation => keep.has(operation));
  // 条数达标后再看字节：从最旧的已结案开始丢。
  for (let index = retained.length - 1; index >= 0 && size({ ...value, operations: next }) > budgetBytes; index--) {
    keep.delete(retained[index].operation);
    next = value.operations.filter(operation => keep.has(operation));
  }
  const dropped = value.operations.length - next.length;
  return dropped === 0 ? value : { ...value, operations: next };
}
