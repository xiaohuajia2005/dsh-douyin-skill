// ============================================================
// 收据裁剪（R5）的测试
//
// 重点不是"能裁到 200 条"，而是**裁剪永远不会删掉未结案的收据**：
//   clicking = 可能已经点过；uncertain = 结果不明待核对。
// 删掉它们等于允许对同一作品再发一条评论——这正是整个收据机制要防的事。
// 其次才是容量：条数上限 + 字节上限，且刚写入的那条不能被自己裁掉。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { trimCommentReceipts } from '../comment/receipts.mjs';

const operation = (index, status = 'confirmed', extra = {}) => ({
  operationId: `op-${index}`,
  videoId: String(7000000000000000000 + index),
  status,
  startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  completedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  ...extra,
});
const book = operations => ({ version: 1, operations });
const ids = value => value.operations.map(item => item.operationId);

test('C1 已确认收据超过上限时只留最新的 N 条，且保持原顺序', () => {
  const value = book(Array.from({ length: 260 }, (_, index) => operation(index)));
  const trimmed = trimCommentReceipts(value, { confirmedItems: 200 });
  assert.equal(trimmed.operations.length, 200);
  assert.deepEqual(ids(trimmed), Array.from({ length: 200 }, (_, index) => `op-${index + 60}`), '应丢弃最旧的 60 条');
});

test('C2 未结案（clicking / uncertain）永不被裁掉，哪怕远超上限', () => {
  const pending = Array.from({ length: 30 }, (_, index) => operation(index, index % 2 ? 'uncertain' : 'clicking'));
  const settled = Array.from({ length: 300 }, (_, index) => operation(1000 + index));
  const trimmed = trimCommentReceipts(book([...pending, ...settled]), { confirmedItems: 5 });
  assert.equal(trimmed.operations.length, 35, '30 条未结案 + 5 条最新已确认');
  for (const item of pending) assert.ok(trimmed.operations.includes(item), `${item.operationId} 未结案却被裁掉`);
});

test('C3 刚写入的那条（最新）不会被裁剪掉', () => {
  const settled = Array.from({ length: 199 }, (_, index) => operation(index));
  const fresh = operation(5000, 'clicking');
  const trimmed = trimCommentReceipts(book([...settled, fresh]), { confirmedItems: 200 });
  assert.equal(trimmed.operations.length, 200);
  assert.ok(trimmed.operations.includes(fresh), '刚写入的 clicking 收据被裁掉，等于放弃"可能已点过"的证据');
});

test('C4 字节上限优先丢最旧的已确认收据', () => {
  const bulky = index => operation(index, 'confirmed', { baseline: { knownIds: Array.from({ length: 400 }, (_, id) => String(id).padStart(8, '0')) } });
  const value = book(Array.from({ length: 40 }, (_, index) => bulky(index)));
  const before = JSON.stringify(value).length;
  assert.ok(before > 60_000, `构造的样本不够大（${before}），测试失去意义`);
  const trimmed = trimCommentReceipts(value, { confirmedItems: 200, budgetBytes: 40_000 });
  assert.ok(JSON.stringify(trimmed).length <= 40_000, '裁剪后仍超字节预算');
  assert.ok(trimmed.operations.length < 40, '没有丢任何收据');
  // 丢的必须是最旧的：剩下的最小序号应大于被丢掉的最大序号。
  const kept = trimmed.operations.map(item => Number(item.operationId.split('-')[1]));
  assert.equal(Math.min(...kept) + kept.length - 1, Math.max(...kept), '保留的应是连续的最新一段');
});

test('C5 字节预算不够时也绝不拿未结案开刀', () => {
  const pending = Array.from({ length: 5 }, (_, index) => operation(index, 'uncertain', { baseline: { knownIds: Array.from({ length: 400 }, () => '12345678') } }));
  const trimmed = trimCommentReceipts(book(pending), { confirmedItems: 200, budgetBytes: 1000 });
  assert.equal(trimmed.operations.length, 5, '未结案全被删了');
});

test('C6 不需要裁剪时返回原对象（避免无意义重写与 mtime 抖动）', () => {
  const value = book([operation(1), operation(2)]);
  assert.equal(trimCommentReceipts(value, { confirmedItems: 200 }), value);
});

test('C7 形状异常时原样返回，交给 receipts() 的严格校验去拒绝', () => {
  for (const value of [null, undefined, {}, { operations: 'x' }, 42]) assert.equal(trimCommentReceipts(value), value);
});

test('C8 版本号与其他顶层字段必须保留', () => {
  const trimmed = trimCommentReceipts({ version: 1, operations: [operation(1)], note: 'x' }, { confirmedItems: 200 });
  assert.equal(trimmed.note, 'x');
  assert.equal(trimmed.version, 1);
});
