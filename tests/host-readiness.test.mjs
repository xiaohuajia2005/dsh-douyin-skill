// ============================================================
// 宿主就绪四态特征测试 —— 迭代 13
//
// 这四个返回值各自对应启动流程里不同的动作，判错会直接表现为：
//   把死进程当 pending → 干等 25 秒才报超时；
//   把旧记录当 ready  → 连到上一个已退出的宿主；
//   把别人的端口当自己的 → 连错浏览器。
// processAlive 一律注入，测试不碰真实进程表。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { dedicatedHostReadiness } from '../service/host-readiness.mjs';

const never = () => { throw new Error('pid 非法时不应查询进程表'); };
const yes = () => true;
const no = () => false;
const asked = { pid: 4242, profile: '/p/a', port: 9227 };
const state = (extra = {}) => ({ pid: 4242, profile: '/p/a', port: 9227, ready: true, ...extra });
const check = (snapshot, options = {}) => dedicatedHostReadiness(snapshot, { ...asked, processAlive: yes, ...options });

test('H1 pid 非法直接 failed，且不去查询进程表', () => {
  for (const pid of [0, -1, 1.5, '4242', undefined, NaN])
    assert.equal(dedicatedHostReadiness(state(), { ...asked, pid, processAlive: never }), 'failed', `pid=${String(pid)}`);
});

test('H2 本次等待的进程已死就是 failed（不要等到超时）', () => {
  assert.equal(check(state(), { processAlive: no }), 'failed');
  assert.equal(check(null, { processAlive: no }), 'failed', '进程都没了，记录缺失也直接失败');
});

test('H3 记录还没写出来是 pending，不是失败', () => {
  assert.equal(check(null), 'pending');
  assert.equal(check(undefined), 'pending');
});

test('H4 记录里的 pid 不是本次等待的进程 → pending（旧记录残留不能当成自己的）', () => {
  assert.equal(check(state({ pid: 999 })), 'pending');
  assert.equal(check(state({ pid: 999, ready: true })), 'pending', '旧记录写着 ready 也不算');
});

test('H5 profile 或 port 不是自己的 → foreign，即使 ready 也拒绝连接', () => {
  assert.equal(check(state({ profile: '/p/b' })), 'foreign');
  assert.equal(check(state({ port: 9222 })), 'foreign');
  assert.equal(check(state({ profile: '/p/b', ready: false })), 'foreign', '归属不符优先于就绪状态');
});

test('H6 ready 必须是严格 true，字符串 "true" 不算', () => {
  assert.equal(check(state()), 'ready');
  assert.equal(check(state({ ready: 'true' })), 'pending');
  assert.equal(check(state({ ready: 1 })), 'pending');
  assert.equal(check(state({ ready: undefined })), 'pending');
});

test('H7 判定顺序：失败 → 归属 → 就绪，三者不会互相掩盖', () => {
  assert.equal(check(state({ pid: 1, profile: '/x' }), { processAlive: no }), 'failed', '进程死了优先报 failed');
  assert.equal(check(state({ pid: 1, profile: '/x' })), 'pending', 'pid 不符时连归属都不看');
});

test('H8 默认 processAlive 走真实进程表：当前进程算活着', () => {
  const self = { pid: process.pid, profile: '/p/a', port: 9227, ready: true };
  assert.equal(dedicatedHostReadiness(self, { pid: process.pid, profile: '/p/a', port: 9227 }), 'ready');
  assert.equal(dedicatedHostReadiness({ ...self, ready: false }, { pid: process.pid, profile: '/p/a', port: 9227 }), 'pending');
});
