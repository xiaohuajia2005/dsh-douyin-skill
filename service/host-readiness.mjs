// ============================================================
// 常驻任务层 · 专用浏览器宿主就绪判定（迭代 13 从 core.mjs 原样抽出）
//
// 四个返回值，每个都对应启动流程里一个不同的动作：
//   failed  —— 本次等待的进程已死，立刻失败（不要傻等到 25 秒超时）；
//   pending —— 记录还是旧的，或进程活着但尚未 ready，继续等；
//   foreign —— 记录里的 profile/port 不是我们的，拒绝连接该端口（可能是别人的浏览器）；
//   ready   —— 可以连了。
//
// 关键不变量：**只核对本次等待的 pid**。新宿主写入前，旧记录可能还停留在文件里，
// 把旧记录当成"自己的"会导到上一个已退出的宿主上——所以 pid 不匹配一律 pending，
// 而不是 failed，也不是 ready。
// ============================================================

const hostAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

export function dedicatedHostReadiness(state, { pid, profile, port, processAlive = hostAlive } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !processAlive(pid)) return 'failed';
  // 新宿主写入前可能仍读到旧的已退出记录；只核对本次等待的进程。
  if (!state || state.pid !== pid) return 'pending';
  if (state.profile !== profile || state.port !== port) return 'foreign';
  return state.ready === true ? 'ready' : 'pending';
}
