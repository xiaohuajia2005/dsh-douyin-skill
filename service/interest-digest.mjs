/**
 * 月度兴趣总结：把一个自然月里模型自己看出来的判定，归纳成一段可写进人格卡的文字。
 *
 * 纯函数：不读磁盘、不调模型、不依赖浏览器。口径与 behaviorByVideo / projectedInterests
 * 保持一致 —— 判定永远来自实际观看进度与已确认互动，题材只是分组，不单独构成喜好。
 *
 * 生成的总结会存进人格学习数据并在人格卡里长期保留，不随下个月的观察被冲掉。
 */

const BEIJING_OFFSET_MS = 8 * 3_600_000;
const monthFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' });

/** 人格卡里保留最近几个月；更早的仍在数据文件里，只是不渲染。 */
export const DIGEST_CARD_LIMIT = 3;
/** 数据文件最多保留几个月，超出按月份先后丢弃最旧的。 */
export const DIGEST_STORE_LIMIT = 12;
/** 单行上限，防止某条归纳把人格卡撑爆。 */
export const DIGEST_LINE_LIMIT = 200;
/** 单月行数上限。 */
export const DIGEST_LINES_LIMIT = 24;

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const SIGNAL_TEXT = { like: '感兴趣', dislike: '不太想看', neutral: '待观察' };
/** 题材下至少要有这么多条"有依据"的作品，才允许给出结论。 */
const TOPIC_MIN_EVIDENCE = 2;
/** 同向依据占比达到这个比例才算结论，1 票正向 1 票负向不该被说成喜欢。 */
const TOPIC_DOMINANCE = 0.6;

export function isMonthKey(value) {
  return typeof value === 'string' && MONTH_PATTERN.test(value);
}

function parseKey(key) {
  const match = typeof key === 'string' ? MONTH_PATTERN.exec(key) : null;
  if (!match) throw new TypeError('月份必须是 YYYY-MM 形式。');
  return [Number(match[1]), Number(match[2])];
}

/** 折算北京时间所属自然月。 */
export function monthKey(timestamp) {
  if (!Number.isFinite(timestamp)) throw new TypeError('时间戳无效。');
  const parts = monthFormat.formatToParts(new Date(timestamp));
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  if (!year || !month) throw new TypeError('无法折算自然月。');
  return `${year}-${month}`;
}

export function previousMonth(key) {
  const [year, month] = parseKey(key);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/** 北京时间当月闭开区间，返回毫秒时间戳。 */
export function monthRange(key) {
  const [year, month] = parseKey(key);
  const start = Date.UTC(year, month - 1, 1) - BEIJING_OFFSET_MS;
  const end = Date.UTC(year, month, 1) - BEIJING_OFFSET_MS;
  return { key, start, end };
}

/**
 * 题材级判定比作品级严格：样本太少或正负接近时一律"待观察"。
 * 一个作品被跳过不代表不喜欢这个题材；把这种情况写成结论，会让人格卡从此绕开它。
 */
function topicSignal(counts) {
  const decided = counts.like + counts.dislike;
  if (decided < TOPIC_MIN_EVIDENCE) return 'neutral';
  const dominant = Math.max(counts.like, counts.dislike);
  if (dominant / decided < TOPIC_DOMINANCE) return 'neutral';
  return counts.like > counts.dislike ? 'like' : 'dislike';
}

function topicRows(interests, videos, summaries) {
  const rows = [];
  for (const item of interests) {
    const hits = (item?.evidence ?? []).filter(ref => videos.has(ref.videoId));
    if (!hits.length) continue;
    const counts = { like: 0, dislike: 0, neutral: 0 };
    for (const ref of hits) counts[summaries.get(ref.videoId)?.signal ?? 'neutral']++;
    rows.push({ topic: String(item.topic), videos: hits.length, counts, signal: topicSignal(counts) });
  }
  return rows.sort((left, right) => right.counts.like - left.counts.like || right.videos - left.videos || left.topic.localeCompare(right.topic, 'zh-CN'));
}

/**
 * 汇总某个月的事实。作品级判定取自 summaries（全量累计），
 * 计数只统计该月确实出现过的作品与互动，所以跨月重复出现的作品不会被算两次。
 */
export function collectMonth(source, key) {
  const range = monthRange(key);
  const inMonth = at => Number.isFinite(at) && at >= range.start && at < range.end;
  const observations = (source?.observations ?? []).filter(row => inMonth(row?.observedAt));
  const viewings = (source?.viewings ?? []).filter(row => inMonth(row?.at));
  const actions = (source?.actions ?? []).filter(row => inMonth(row?.at));
  const videos = new Set([...observations, ...viewings, ...actions].map(row => row.videoId).filter(Boolean));
  const summaries = source?.summaries instanceof Map ? source.summaries : new Map();
  const counts = { like: 0, dislike: 0, neutral: 0 };
  for (const videoId of videos) counts[summaries.get(videoId)?.signal ?? 'neutral']++;
  const behavior = { stay: 0, skip: 0, share: 0 };
  for (const item of actions) if (Object.hasOwn(behavior, item.action)) behavior[item.action]++;
  const activeDays = new Set([...observations.map(row => row.observedAt), ...viewings.map(row => row.at), ...actions.map(row => row.at)]
    .map(at => new Date(at + BEIJING_OFFSET_MS).toISOString().slice(0, 10))).size;
  return {
    key, videos: videos.size, counts, behavior, activeDays,
    samples: viewings.length, observed: observations.length,
    topics: topicRows(source?.interests ?? [], videos, summaries),
  };
}

function compareTopics(current, previous) {
  // 第一次生成时没有上月：不写"和上个月比"，否则每个题材都会被说成"新出现"。
  if (!Array.isArray(previous) || !previous.length) return '';
  const before = new Map(previous.map(item => [item.topic, item]));
  const moves = [];
  for (const item of current) {
    const old = before.get(item.topic);
    if (!old) {
      // 待观察的题材没有结论，不能算"新出现的兴趣"。
      if (item.signal !== 'neutral') moves.push(`${item.topic}是新出现的题材`);
      continue;
    }
    const was = topicSignal(old.counts), now = item.signal;
    // 只报"形成结论"的方向；依据不足以支撑结论时不写"变成待观察"，那是噪音。
    if (now === 'neutral' || was === now) continue;
    moves.push(`${item.topic}从${SIGNAL_TEXT[was]}变成${SIGNAL_TEXT[now]}`);
  }
  return moves.slice(0, 3).join('；');
}

/**
 * 把统计归纳成几行文字。没有作品就返回空数组 —— 空月份不生成总结，
 * 也不留一条“本月无事发生”的占位，避免人格卡被无意义条目填满。
 */
export function composeDigest(stats, previous = null) {
  if (!stats || !stats.videos) return [];
  const lines = [];
  const { counts, behavior } = stats;
  lines.push(`这个月看过 ${stats.videos} 个作品，其中 ${counts.like} 个有停留或分享依据、${counts.dislike} 个快速跳过、${counts.neutral} 个证据不足；有 ${stats.activeDays} 天打开过抖音。`);
  const liked = stats.topics.filter(item => item.signal === 'like').slice(0, 3);
  const disliked = stats.topics.filter(item => item.signal === 'dislike').slice(0, 2);
  if (liked.length) lines.push(`更愿意看：${liked.map(item => `${item.topic}（${item.videos} 个作品里 ${item.counts.like} 个看完）`).join('、')}。`);
  if (disliked.length) lines.push(`不太想看：${disliked.map(item => `${item.topic}（${item.videos} 个作品里 ${item.counts.dislike} 个快速跳过）`).join('、')}。`);
  if (behavior.share) lines.push(`主动分享了 ${behavior.share} 次。`);
  const shift = compareTopics(stats.topics, previous?.topics);
  if (shift) lines.push(`和上个月比：${shift}。`);
  lines.push('这是自己看下来的归纳，只表示选题倾向，不代表用户喜欢。');
  return lines.slice(0, DIGEST_LINES_LIMIT).map(line => line.length > DIGEST_LINE_LIMIT ? line.slice(0, DIGEST_LINE_LIMIT) : line);
}

/** 该补哪个月的总结：只补上一个自然月，一个月只生成一次。 */
export function dueMonth(digests, now) {
  const key = previousMonth(monthKey(now));
  return (digests ?? []).some(item => item?.key === key) ? null : key;
}

/** 按月份去重合并，只保留最近 DIGEST_STORE_LIMIT 个月。 */
export function upsertDigest(digests, digest) {
  const kept = (digests ?? []).filter(item => item?.key !== digest.key);
  kept.push(digest);
  kept.sort((left, right) => String(left.key).localeCompare(String(right.key)));
  return kept.slice(-DIGEST_STORE_LIMIT);
}

/** 人格卡渲染：最近几个月，新的在上。 */
export function digestLines(digests) {
  const recent = [...(digests ?? [])]
    .filter(item => isMonthKey(item?.key) && Array.isArray(item?.lines) && item.lines.length)
    .sort((left, right) => left.key.localeCompare(right.key))
    .slice(-DIGEST_CARD_LIMIT)
    .reverse();
  return recent.flatMap(item => [`### ${item.key}`, ...item.lines.map(line => `- ${line}`)]);
}
