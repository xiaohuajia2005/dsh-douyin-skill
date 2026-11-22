// ============================================================
// 证据层 · 播放推进核验（迭代 12 从 core.mjs 原样抽出）
//
// 输入是两帧采样各自的"视频状态 + 双时钟"快照，输出这段时间内**可采信**的播放推进秒数；
// 拿不到证据就返回 null，调用方据此拒收画面。
//
// 判据全部是物理一致性，不信任任何单一字段：
//   · 同一视频 / 同一元素 / 同一源 / 同一时间原点，前后都未暂停、未 seek、readyState >= 2；
//   · 时长有限且两次一致（±0.05s），倍速合法（0 < r <= 4）且前后不变，loop 标记不变；
//   · 宿主墙钟与页面墙钟互相印证（差 <= 0.35s），墙钟不倒退且不超过 40s；
//   · 视频时间推进 ≈ 墙钟 × 倍速，偏差容忍 15%（且至少 0.2s），loop 回绕按圈数折算。
//
// 返回 null 不是"出错"，是"这批画面不能用"——宁可少一帧证据，也不采信猜出来的进度。
// ============================================================
export function playbackProgress(before, after) {
  if (!before || !after || before.videoId !== after.videoId || before.elementToken !== after.elementToken || before.sourceHash !== after.sourceHash || before.documentTimeOrigin !== after.documentTimeOrigin
    || before.paused !== false || after.paused !== false || before.seeking !== false || after.seeking !== false || before.readyState < 2 || after.readyState < 2
    || !Number.isFinite(before.duration) || before.duration <= 0 || Math.abs(before.duration - after.duration) > 0.05 || before.loop !== after.loop
    || !Number.isFinite(before.playbackRate) || before.playbackRate <= 0 || before.playbackRate > 4 || before.playbackRate !== after.playbackRate) return null;
  const wall = (after.hostTimeMs - before.hostTimeMs) / 1000, pageWall = (after.pageTimeMs - before.pageTimeMs) / 1000;
  if (!Number.isFinite(wall) || wall < 0 || wall > 40 || !Number.isFinite(pageWall) || pageWall < 0 || Math.abs(wall - pageWall) > 0.35) return null;
  const expected = pageWall * before.playbackRate, direct = after.time - before.time;
  if (![before.time, after.time].every(time => Number.isFinite(time) && time >= 0 && time <= before.duration + 0.05)) return null;
  const turns = before.loop ? Math.max(0, Math.round((expected - direct) / before.duration)) : 0;
  const advanced = direct + turns * before.duration;
  return advanced >= -0.04 && Math.abs(advanced - expected) <= Math.max(0.2, expected * 0.15) ? Math.max(0, advanced) : null;
}
