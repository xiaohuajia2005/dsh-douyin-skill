// comment/lock-policy.mjs —— 评论发布锁能否接管的判定（R3）
//
// 为什么不能照抄回复控制锁那套"pid 死了就删"：
//
//   post() 里的顺序是「先写收据（status: 'clicking'）→ 再点发布」，
//   见 comment-browser.mjs 第 488–489 行。于是 pid 死亡这件事有两种完全不同的含义：
//     · 收据里查不到这条操作  → 说明 record() 没跑过 → 一定没点过 → 可以安全接管
//     · 收据里有这条操作未终止 → 可能已经点过、结果不明 → 接管就等于允许再发一条
//
// 所以判定依据不是 pid，而是收据。这个函数只做判定、不碰文件系统，便于离线全量测试。

// 可能已经产生对外副作用、结果尚未确定的状态。
// 'confirmed' 是终态（评论编号已回读并落盘），此时锁只是残留，可以接管；
// 'uncertain' 与 'clicking' 都是"点过但不知道结果"，一律交人工。
const UNRESOLVED = new Set(['clicking', 'uncertain']);

const guardPath = 'state/comment-post.guard';

export function commentPostLockDecision(state, operations) {
  if (!state?.present) return { reclaim: true, reason: '' };
  if (!state.validOwner) {
    return { reclaim: false, reason: `评论发布锁无法核对持有者（内容为空、损坏或被手工改动）；未自动删除 ${guardPath}，请人工检查。` };
  }
  if (state.alive) {
    return { reclaim: false, reason: `另一个进程（pid ${state.owner.pid}）正在发布评论，未抢锁重试。` };
  }
  // 收据读不出来（文件损坏）时不得猜：没有收据就等于没有证据证明"没点过"。
  if (!Array.isArray(operations)) {
    return { reclaim: false, reason: `上一次评论进程（pid ${state.owner.pid}）已退出，但发布收据无法核对；未自动接管发布锁。` };
  }
  const operationId = typeof state.owner.operationId === 'string' && state.owner.operationId ? state.owner.operationId : null;
  if (operationId) {
    const receipt = operations.find(item => item?.operationId === operationId);
    if (receipt && UNRESOLVED.has(receipt.status)) {
      return { reclaim: false, reason: `上一次评论（作品 ${receipt.videoId}，状态 ${receipt.status}）的进程已退出，收据未终止；未自动接管发布锁，请先核对这条收据。` };
    }
    // 收据已确认，或压根没有这条收据：前者说明动作已完成，后者说明还没走到点击。
    return { reclaim: true, reason: `上一次评论进程（pid ${state.owner.pid}）已退出，收据未显示未完成的点击；已接管发布锁。` };
  }
  // 旧版 guard 只写 {pid, token}，无法与收据对上号：退一步看有没有任何未终止的点击记录。
  const pending = operations.find(item => UNRESOLVED.has(item?.status));
  if (pending) {
    return { reclaim: false, reason: `收据里还有未终止的发布记录（作品 ${pending.videoId}，状态 ${pending.status}）；未自动接管发布锁。` };
  }
  return { reclaim: true, reason: `上一次评论进程（pid ${state.owner.pid}）已退出，且没有留下未终止的点击记录；已接管发布锁。` };
}
