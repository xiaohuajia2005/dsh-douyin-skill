import fs from 'node:fs';
import path from 'node:path';
import { acquireStateLock } from './service/state-lock.mjs';

export function readFriendInteractionsEnabled(stateDir) {
  if(fs.existsSync(path.join(stateDir,'friend-interactions-settings.guard')))return false;
  let value;
  try { value=JSON.parse(fs.readFileSync(path.join(stateDir,'friend-interactions-policy.json'),'utf8')); }
  catch(error) {if(error.code==='ENOENT')return true;throw new Error('好友互动总开关记录损坏，已停止好友互动。');}
  if(!value || value.version!==1 || typeof value.enabled!=='boolean'||Object.keys(value).some(key=>!['version','enabled'].includes(key)))throw new Error('好友互动总开关记录损坏，已停止好友互动。');
  return value.enabled;
}

export function acquireFriendInteractionDispatch(stateDir) {
  // 控制锁：持有者进程已退出即可接管（R3）。若旧实现直接抛 EEXIST，
  // 一次崩溃会让好友互动永久卡在"总开关正在更新"上。
  const lock = acquireStateLock(path.join(stateDir, 'friend-interactions-control.guard'), {
    busyMessage: '好友互动总开关或发送正在更新，请稍后重试。',
    onBusy: message => Object.assign(new Error(message), { status: 409, code: 'FRIEND_INTERACTIONS_BUSY', beforeDelivery: true }),
  });
  return lock.release;
}
