// service/state-lock.mjs —— 进程间互斥锁的单一实现（R3）
//
// 为什么要有这个模块：同一个五行探活函数此前被抄成了 6 份
// （chat-service / autonomous-comments / autonomous-share / autonomous-watch / core×2）。
// 2026-11-21 只给回复控制锁修了「持有者已死则自愈」，评论发布锁至今仍是 EEXIST 直接抛，
// 于是进程一崩，锁永久残留，之后每一次评论都被拒。同一个 bug 修在一处、漏在另一处，
// 根因不是疏忽，是这份逻辑没有唯一归属。
//
// 两类锁，两套接管策略，这条界限是本模块最重要的约定：
//   1) 控制锁 / 短临界区（设置更新、开关、一次性动作的编排）
//      —— 持有者进程已不存在即可安全接管。它保护的是一次内存操作，没有对外副作用。
//   2) 收据锁 / 操作锁（评论发布、分享发送）
//      —— 本模块**不判断**能否接管，只如实报告 `lockState().stale`。
//      pid 死亡恰恰说明"某次真实副作用可能已经发生"，此时唯一安全的动作是查收据，
//      由调用方按自己的收据语义决定（见 comment/lock-policy.mjs）。
//
// 写锁一律 fsync：锁内容丢了等于锁状态不可核对，而它保护的正是"别重复做一次"。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const STATE_LOCK_BUSY = 'STATE_LOCK_BUSY';

// 探活口径与运行环境一致：ESRCH 才算死，EPERM 说明进程存在但属于其他用户（视为活）。
// pid 不合法一律按"死"处理——它不可能持有我们写下的锁。
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export function readLockOwner(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// 锁的三种状态必须分清，否则会误删别人的锁：
//   present=false            → 没锁，可直接抢
//   validOwner=false         → 文件在但读不出合法 pid（空文件/半截写入/被手工改坏）→ 交人工
//   stale=true               → 持有者确定已退出，**调用方**才可决定接管
export function lockState(file) {
  if (!fs.existsSync(file)) return { present: false, owner: null, validOwner: false, alive: false, stale: false };
  const owner = readLockOwner(file);
  const validOwner = Boolean(owner) && Number.isSafeInteger(owner.pid) && owner.pid > 0;
  const alive = validOwner && processAlive(owner.pid);
  return { present: true, owner, validOwner, alive, stale: validOwner && !alive };
}

function describeBusy(state) {
  if (!state.validOwner) return '锁文件无法核对持有者（为空、损坏或被手工改动），未自动删除。';
  if (state.alive) return `另一个进程（pid ${state.owner.pid}）正在处理，请稍后重试。`;
  return `持有者进程（pid ${state.owner.pid}）已退出，但按当前策略不允许自动接管，请人工核对。`;
}

// stale 取值：
//   'reclaim'  持有者已死即接管（控制锁默认）
//   'block'    任何冲突都不接管（操作锁应显式用这个）
//   (state) => 'reclaim' | 'block'   由调用方按收据判定
// 接管只做一次：unlink 与重新 open 之间可能被别人插入，第二次 EEXIST 一律报忙。
export function acquireStateLock(file, { owner = {}, stale = 'reclaim', busyMessage, onBusy } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString(), ...owner };
  for (let attempt = 0; ; attempt++) {
    let descriptor;
    try { descriptor = fs.openSync(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const state = lockState(file);
      const decision = typeof stale === 'function' ? stale(state) : (state.stale ? stale : 'block');
      if (attempt === 0 && decision === 'reclaim') {
        try { fs.unlinkSync(file); } catch { /* 并发清理：让下一轮 open 给出答案 */ }
        continue;
      }
      const message = typeof busyMessage === 'function' ? busyMessage(state) : busyMessage || describeBusy(state);
      throw onBusy ? onBusy(message, state) : Object.assign(new Error(message), { code: STATE_LOCK_BUSY, lock: state });
    }
    try { fs.writeFileSync(descriptor, JSON.stringify(record)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    return { file, owner: record, status: () => lockState(file), release: () => releaseStateLock(file, record) };
  }
}

// 只删自己写的锁。返回是否真的删除，便于调用方在日志里区分"释放了"和"早被别人接管了"。
export function releaseStateLock(file, owner) {
  const current = readLockOwner(file);
  if (!current || current.pid !== owner.pid || current.token !== owner.token) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}
