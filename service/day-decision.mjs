// ============================================================
// 常驻任务层 · 今日问候资格判定（迭代 11 从 chat-browser.mjs 原样抽出）
//
// 只回答一个问题：今天能不能给这位好友发主动问候。答案是四个状态之一：
//   already-sent     —— 共同账本或当前会话已证明今天发过，绝不重发；
//   pending-incoming —— 对方还有话没回，交给聊天回复，不抢着寒暄；
//   eligible         —— 有明确日期证据表明今天还没发过；
//   date-unknown     —— 证据不足，一律不发（这是默认答案）。
//
// 判定只认"日期证据"，不认"看起来像今天"：快照必须在 60 秒内、最新端已核实、
// 时间轴正序；消息里只要有一行方向不明/发送中/失败，整份快照作废。
// 60_000 是行为参数不是配置项 —— 见 refactor/PLAN.md 红线：魔法数字不进 config。
// ============================================================

const localDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));

export function analyzeConversationDay(snapshot, { now = Date.now, confirmedHistory = [] } = {}) {
  const current = typeof now === 'function' ? now() : now, today = localDay(current);
  const recipientId = snapshot?.conversation?.id || snapshot?.contact?.id;
  if (typeof recipientId === 'string' && recipientId.trim() && confirmedHistory.some(item => item?.confirmed === true && item.recipientId === recipientId && typeof item.messageId === 'string' && item.messageId.trim() && item.date === today && Number.isFinite(Date.parse(item.at)) && localDay(Date.parse(item.at)) === today && Date.parse(item.at) <= current)) return { status: 'already-sent', reason: '共同账本已确认今天向这位好友发过消息。' };
  const evidence = snapshot?.dayEvidence;
  if (snapshot?.blocked || snapshot?.loginRequired || snapshot?.verificationRequired || !recipientId || !Array.isArray(snapshot.messages) || !evidence?.latestEndVerified || evidence.chronology !== 'oldest-first' || !Number.isFinite(Date.parse(evidence.observedAt)) || localDay(Date.parse(evidence.observedAt)) !== today || Date.parse(evidence.observedAt) > current || current - Date.parse(evidence.observedAt) > 60_000) return { status: 'date-unknown', reason: '会话最新端、日期或快照时效尚未核实。' };
  const messages = snapshot.messages;
  if (messages.some(item => !['incoming', 'outgoing'].includes(item.sender || item.direction) || item.pending || item.failed)) return { status: 'date-unknown', reason: '会话含方向不明或未确认的消息，未自动问候。' };
  const dayOf = item => {
    if (item.dateEvidence?.kind === 'unknown') return null;
    const raw = String(item.dateEvidence?.raw ?? item.sentAt ?? item.timestamp ?? '').trim();
    if (/^今天(?:\s|$)/.test(raw)) return today;
    const date = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:$|[ T\s])/.exec(raw);
    if (!date) return null;
    const padded = `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`;
    if (!Number.isFinite(Date.parse(padded + 'T00:00:00+08:00')) || localDay(Date.parse(padded + 'T00:00:00+08:00')) !== padded) return null;
    if (/T.*(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return Number.isFinite(Date.parse(raw)) ? localDay(Date.parse(raw)) : null;
    return padded;
  };
  if (messages.some(item => (item.sender || item.direction) === 'outgoing' && dayOf(item) === today)) return { status: 'already-sent', reason: '当前会话已读到今天真实发出的消息。' };
  const outgoing = messages.findLastIndex(item => (item.sender || item.direction) === 'outgoing');
  if (messages.slice(outgoing + 1).some(item => (item.sender || item.direction) === 'incoming')) return { status: 'pending-incoming', reason: '对方有待回复消息，优先交给聊天回复。' };
  if (!messages.length && evidence.emptyTodayVerified === true) return { status: 'eligible', reason: '当前最新会话明确显示今天尚无消息。' };
  if (outgoing >= 0) {
    const date = dayOf(messages[outgoing]);
    if (date && date < today) return { status: 'eligible', reason: '已核对最新端，最近发出消息的明确日期早于今天。' };
  }
  return { status: 'date-unknown', reason: '没有足够日期证据判断今天是否发过消息。' };
}
