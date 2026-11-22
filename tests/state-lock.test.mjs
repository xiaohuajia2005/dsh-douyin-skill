// tests/state-lock.test.mjs —— 统一状态锁（R3）的接管与拒绝接管
//
// 这个模块的存在理由是"同一个 bug 被修在一处、漏在另一处"，
// 所以测试重点不是"能抢到锁"，而是**不该接管时一定没删别人的锁**。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireStateLock, lockState, processAlive, readLockOwner, releaseStateLock, STATE_LOCK_BUSY } from '../service/state-lock.mjs';

const withDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// 拿一个确定已经退出的 pid：起一个立刻结束的子进程，用它的 pid。
// 比"猜一个很大的数字"可靠——后者在 Windows 上可能撞上真实进程。
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;

const writeLock = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });

test('S1 探活口径：ESRCH 才算死，非法 pid 一律按死处理', () => {
  assert.equal(processAlive(process.pid), true, '当前进程必须判活');
  assert.equal(processAlive(deadPid()), false, '已退出的子进程必须判死');
  for (const value of [0, -1, 1.5, null, undefined, '123', Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(processAlive(value), false, `${String(value)} 不是合法 pid，应判死`);
  }
});

test('S2 锁状态三分类：不存在 / 持有者合法 / 文件损坏必须分得开', t => {
  const dir = withDir(t);
  const file = path.join(dir, 'x.guard');
  assert.deepEqual(lockState(file), { present: false, owner: null, validOwner: false, alive: false, stale: false });

  writeLock(file, { pid: process.pid, token: 't' });
  const live = lockState(file);
  assert.equal(live.present, true);
  assert.equal(live.validOwner, true);
  assert.equal(live.alive, true);
  assert.equal(live.stale, false);

  writeLock(file, { pid: deadPid(), token: 't' });
  const stale = lockState(file);
  assert.equal(stale.validOwner, true);
  assert.equal(stale.alive, false);
  assert.equal(stale.stale, true, '持有者已退出才算 stale');

  for (const broken of ['', '{', 'null', '[]', '{}', '{"pid":0}', '{"pid":"1"}', '{"token":"t"}']) {
    writeLock(file, broken);
    const state = lockState(file);
    assert.equal(state.present, true, `${broken} 文件存在`);
    assert.equal(state.validOwner, false, `${broken} 没有合法 pid`);
    assert.equal(state.stale, false, `${broken} 不允许被当成 stale 自动清理`);
  }
});

test('S3 抢锁与释放：落盘字段齐全，释放只删自己的', t => {
  const dir = withDir(t);
  const file = path.join(dir, 'control.guard');
  const lock = acquireStateLock(file, { owner: { operationId: 'op-1' } });
  const stored = readLockOwner(file);
  assert.equal(stored.pid, process.pid);
  assert.equal(typeof stored.token, 'string');
  assert.equal(typeof stored.createdAt, 'string');
  assert.equal(stored.operationId, 'op-1');
  assert.equal(lock.release(), true);
  assert.equal(fs.existsSync(file), false, '释放后锁文件必须消失');
  assert.equal(lock.release(), false, '重复释放不得抛错，返回 false');
});

test('S4 活进程持锁：报忙、不删、不改写持有者', t => {
  const dir = withDir(t);
  const file = path.join(dir, 'control.guard');
  const held = acquireStateLock(file);
  const before = readLockOwner(file);
  assert.throws(() => acquireStateLock(file), error => error.code === STATE_LOCK_BUSY);
  assert.deepEqual(readLockOwner(file), before, '被拒时不得动别人的锁');
  held.release();
});

test('S5 死进程持锁：控制锁默认接管，且新持有者是本进程', t => {
  const dir = withDir(t);
  const file = path.join(dir, 'control.guard');
  writeLock(file, { pid: deadPid(), token: 'previous' });
  const lock = acquireStateLock(file, { owner: { operationId: 'fresh' } });
  const stored = readLockOwner(file);
  assert.equal(stored.pid, process.pid);
  assert.notEqual(stored.token, 'previous');
  assert.equal(stored.operationId, 'fresh');
  lock.release();
});

test('S6 stale 策略可关掉：操作锁声明不接管时，死进程的锁也必须留着', t => {
  const dir = withDir(t);
  const file = path.join(dir, 'post.guard');
  writeLock(file, { pid: deadPid(), token: 'previous' });
  assert.throws(() => acquireStateLock(file, { stale: 'block' }), error => error.code === STATE_LOCK_BUSY);
  assert.equal(fs.existsSync(file), true, '不许自动删除操作锁');
  const stored = readLockOwner(file);
  assert.equal(stored.token, 'previous', '原持有者信息必须原样保留');
  assert.notEqual(stored.pid, process.pid, '不得被本进程覆盖');
});

test('S7 锁文件损坏：fail-closed，交人工而不是猜着删', t => {
  const dir = withDir(t);
  const file = path.join(dir, 'control.guard');
  writeLock(file, '');
  assert.throws(() => acquireStateLock(file), error => error.code === STATE_LOCK_BUSY);
  assert.equal(fs.existsSync(file), true, '读不出持有者时不得删除');
});

test('S8 接管只做一次：清理与抢锁之间被别人插入时必须报忙', t => {
  const dir = withDir(t);
  const file = path.join(dir, 'control.guard');
  // 用目录冒充锁文件：openSync(wx) 同样是 EEXIST，但 unlinkSync 删不掉它，
  // 于是"清理后重试"会再次撞上 EEXIST——正好检验 attempt 上限。
  fs.mkdirSync(file);
  assert.throws(() => acquireStateLock(file), error => error.code === STATE_LOCK_BUSY);
  assert.equal(fs.statSync(file).isDirectory(), true);
});

test('S9 释放不得误删别人的锁（token 不同即放弃）', t => {
  const dir = withDir(t);
  const file = path.join(dir, 'control.guard');
  const foreign = { pid: process.pid, token: 'not-mine' };
  writeLock(file, foreign);
  assert.equal(releaseStateLock(file, { pid: process.pid, token: 'mine' }), false);
  assert.deepEqual(readLockOwner(file), foreign, '别人的锁必须原样保留');
});

test('S10 自定义文案与错误形状：调用方保留自己的错误语义', t => {
  const dir = withDir(t);
  const file = path.join(dir, 'control.guard');
  const held = acquireStateLock(file);
  let seen;
  assert.throws(() => acquireStateLock(file, {
    busyMessage: state => `自定义忙：pid ${state.owner.pid}`,
    onBusy: (message, state) => Object.assign(new Error(message), { status: 409, code: 'CUSTOM_BUSY', ownerPid: state.owner.pid }),
  }), error => {
    seen = error;
    return error.code === 'CUSTOM_BUSY' && error.status === 409 && error.ownerPid === process.pid;
  });
  assert.match(seen.message, /自定义忙：pid \d+/);
  held.release();
});
