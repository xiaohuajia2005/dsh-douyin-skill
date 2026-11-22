// ============================================================
// 证据层 · 分享视频采样核验（迭代 17 从 chat-service.mjs 原样抽出）
//
// 与 video-progress.mjs 的分工：
//   playbackProgress        —— 两次观测之间播放头推进了多少秒（时间轴数学）；
//   verifiedSharedVideoSample —— 这一整份采样到底能不能信（结构完整性）。
//
// 判断的是"对方分享的视频确实在我这边播放过"，四个条件缺一不可：
//   1. 采样时的视频 ID、观测对象里的视频 ID 都必须是它（防止拿别的视频的帧充数）；
//   2. 观测前后都必须是播放中（paused 必须显式 false，缺失不算）；
//   3. 前后时间点有推进，且至少 0.1 秒（不足 0.1 秒等于没动）；
//   4. 落在观测时间窗（前后各 0.25 秒容差）内的帧至少 2 张，且末帧比首帧晚 0.1 秒以上。
// 任何一条不满足就返回 false —— 宁可这次不评论，也不拿模糊证据去夸人。
// ============================================================

export function verifiedSharedVideoSample(value, videoId) {
  const observation = value?.observation;
  const frames = (value?.frames ?? []).filter(frame => frame.videoId === videoId && Number.isFinite(frame.time) && frame.time >= observation?.beforeTime - 0.25 && frame.time <= observation?.afterTime + 0.25);
  return value?.state?.video?.id === videoId && observation?.videoId === videoId && observation.beforePaused === false && observation.paused === false
    && Number.isFinite(observation.beforeTime) && Number.isFinite(observation.afterTime) && observation.afterTime > observation.beforeTime + 0.1
    && frames.length >= 2 && frames.some(frame => frame.time > frames[0].time + 0.1);
}
