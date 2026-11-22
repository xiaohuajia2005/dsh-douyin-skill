// tests/comment-lock-policy.test.mjs —— 评论发布锁能否接管（R3）
//
// 判据是收据，不是 pid。因为 post() 的顺序是「先写收据(clicking) → 再点发布」：
//   收据里有这条操作未终止  = 可能已经点过，接管等于允许再发一条
//   收据里查不到这条操作    = 还没走到点击，可以安全接管
// 任何一条判错，代价都是给同一条作品多发一条评论。

import test from 'node:test';
import assert from 'node:assert/strict';
import { commentPostLockDecision } from '../comment/lock-policy.mjs';

const LIVE = { present: true, owner: { pid: 4321, token: 't' }, validOwner: true, alive: true, stale: false };
const DEAD = { present: true, owner: { pid: 4321, token: 't' }, validOwner: true, alive: false, stale: true };
const deadWithOp = operationId => ({ ...DEAD, owner: { pid: 4321, token: 't', operationId } });
const corrupt = { present: true, owner: null, validOwner: false, alive: false, stale: false };
const absent = { present: false, owner: null, validOwner: false, alive: false, stale: false };

const receipt = (operationId, status, videoId = '700000000000000001') => ({ operationId, status, videoId });

test('P1 没有锁：直接可抢', () => {
  assert.equal(commentPostLockDecision(absent, []).reclaim, true);
});

test('P2 锁文件损坏：不接管，并提示人工检查具体路径', () => {
  const decision = commentPostLockDecision(corrupt, []);
  assert.equal(decision.reclaim, false);
  assert.match(decision.reason, /comment-post\.guard/);
});

test('P3 持有者还活着：报忙并带上 pid，理由不能是"已退出"', () => {
  const decision = commentPostLockDecision(LIVE, []);
  assert.equal(decision.reclaim, false);
  assert.match(decision.reason, /pid 4321/);
  assert.match(decision.reason, /正在发布评论/);
});

test('P4 收据读不出来：不猜，fail-closed', () => {
  assert.equal(commentPostLockDecision(DEAD, null).reclaim, false, 'null = 收据文件损坏');
  assert.equal(commentPostLockDecision(deadWithOp('op-1'), null).reclaim, false);
});

test('P5 持有者已死且自己那条收据停在 clicking：不接管，拒绝理由要指出是哪条作品', () => {
  const decision = commentPostLockDecision(deadWithOp('op-1'), [receipt('op-1', 'clicking', '700000000000000009')]);
  assert.equal(decision.reclaim, false);
  assert.match(decision.reason, /700000000000000009/);
  assert.match(decision.reason, /clicking/);
});

test('P6 收据为 uncertain（点过但结果不明）：同样不接管', () => {
  assert.equal(commentPostLockDecision(deadWithOp('op-1'), [receipt('op-1', 'uncertain')]).reclaim, false);
});

test('P7 收据已 confirmed：动作已完成，锁只是残留，可以接管', () => {
  assert.equal(commentPostLockDecision(deadWithOp('op-1'), [receipt('op-1', 'confirmed')]).reclaim, true);
});

test('P8 持有者已死且收据里没有这条操作：说明还没走到点击，可以接管', () => {
  assert.equal(commentPostLockDecision(deadWithOp('op-1'), [receipt('op-2', 'clicking')]).reclaim, true);
  assert.equal(commentPostLockDecision(deadWithOp('op-1'), []).reclaim, true);
});

test('P9 旧版 guard 只有 pid/token：退一步按"是否存在未终止点击收据"判断', () => {
  assert.equal(commentPostLockDecision(DEAD, [receipt('op-9', 'clicking')]).reclaim, false);
  assert.equal(commentPostLockDecision(DEAD, [receipt('op-9', 'uncertain')]).reclaim, false);
});

test('P10 旧版 guard 且收据全是终态：可以接管', () => {
  assert.equal(commentPostLockDecision(DEAD, [receipt('op-9', 'confirmed'), receipt('op-8', 'not-sent')]).reclaim, true);
  assert.equal(commentPostLockDecision(DEAD, []).reclaim, true);
});

test('P11 operationId 为空串或非字符串时按旧版处理，不误配收据', () => {
  const emptyOp = { ...DEAD, owner: { pid: 4321, token: 't', operationId: '' } };
  assert.equal(commentPostLockDecision(emptyOp, [receipt('op-1', 'confirmed')]).reclaim, true);
  const numeric = { ...DEAD, owner: { pid: 4321, token: 't', operationId: 7 } };
  assert.equal(commentPostLockDecision(numeric, [receipt('op-1', 'clicking')]).reclaim, false);
});
