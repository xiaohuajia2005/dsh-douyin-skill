// ============================================================
// 入站分享记录（谁把哪条作品发给了大肥鱼）
//
// 为什么需要单独一份记录：
//   · 会话水位（chat-watermarks.json）只留 {id,sender,text}，不带 media.videoId，
//     用不了；群视频队列只服务「被许可群里的作品要单独看」，也不是身份的稳定来源。
//   · 自主分享要回答的问题只有一个：「这条作品是不是这位许可对象自己发过来的」。
//     如果是，再回发一次就是重复，也影响交流观感。
//
// 写入方：唯一聊天 worker（chat-service 轮询里发现新的入站 shared-work 卡片）。
// 读取方：自主分享（autonomous-share，跨进程只读）。
// 边界：只记会话编号、作品编号、消息编号与时间；不存标题、作者、画面或聊天正文。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

export const INBOUND_SHARE_FILE = 'chat-inbound-shares.json';
// 只保留最近这么多条；同一会话同一作品只留最新一条。
export const INBOUND_SHARE_LIMIT = 3000;
// 只在这么久之内算「刚发过来的」；更早的入站不能再永久禁止回发。
export const INBOUND_SHARE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const recipientPattern = /^conv:[a-f0-9]{64}$/;
const videoPattern = /^\d{1,64}$/;
const messagePattern = /^msg:[a-f0-9]{64}$/;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const empty = () => ({ version: 1, items: [] });
const validItem = item => Boolean(item) && recipientPattern.test(item.recipientId || '') && typeof item.isGroup === 'boolean'
  && videoPattern.test(item.videoId || '') && messagePattern.test(item.messageId || '') && isoPattern.test(item.at || '');

function valid(data) {
  return Boolean(data) && data.version === 1 && Array.isArray(data.items) && data.items.every(validItem);
}

// 从一张入站分享卡片上取可核实的作品编号：编号本身优先，其次公开链接。
// 身份冲突（同一张卡上出现两个不同作品）一律不记，宁可不判重复也不记错。
export function inboundVideoId(media) {
  if (media?.type !== 'shared-work' || media.identityConflict === true) return null;
  const direct = videoPattern.test(media.videoId || '') ? media.videoId : null;
  let linked = null;
  if (typeof media.url === 'string') {
    try { const url = new URL(media.url); if (url.protocol === 'https:' && /^(?:www\.)?douyin\.com$/.test(url.hostname)) linked = /^\/video\/(\d+)\/?$/.exec(url.pathname)?.[1] || null; } catch { linked = null; }
  }
  if (direct && linked && direct !== linked) return null;
  return direct || linked;
}

export function readInboundShares(stateDir) {
  const data = readFile(path.join(stateDir, INBOUND_SHARE_FILE));
  return data || empty();
}

function readFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return valid(data) ? data : null;
  } catch { return null; }
}

// 这位会话是不是已经把这条作品发过来过。读取失败只会返回 null（照常分享），
// 不会因为一次读文件出错就停掉整场观看。
export function inboundShareOf(stateDir, { recipientId, videoId, now = Date.now() } = {}) {
  if (!recipientPattern.test(recipientId || '') || !videoPattern.test(videoId || '')) return null;
  const data = readFile(path.join(stateDir, INBOUND_SHARE_FILE));
  if (!data) return null;
  const item = data.items.find(entry => entry.recipientId === recipientId && entry.videoId === videoId);
  return fresh(item, now);
}

function fresh(item, now) {
  if (!item) return null;
  const at = Date.parse(item.at);
  if (!Number.isFinite(at) || now - at > INBOUND_SHARE_WINDOW_MS || now < at - 60_000) return null;
  return { recipientId: item.recipientId, videoId: item.videoId, messageId: item.messageId, at: item.at };
}

// 一次读盘拿到「这条作品是从哪些会话发过来的」，供分享上下文一次性核对。
export function inboundReceipts(stateDir, { videoId, now = Date.now() } = {}) {
  if (!videoPattern.test(videoId || '')) return [];
  const data = readFile(path.join(stateDir, INBOUND_SHARE_FILE));
  if (!data) return [];
  return data.items.filter(item => item.videoId === videoId).map(item => fresh(item, now)).filter(Boolean);
}

export class InboundShareLog {
  constructor({ stateDir, now = Date.now } = {}) {
    if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('入站分享记录缺少状态目录。');
    this.file = path.join(stateDir, INBOUND_SHARE_FILE); this.now = now;
  }
  state() {
    const data = readFile(this.file) || empty();
    return { protocol: 'inbound-shares-v1', count: data.items.length, lastAt: data.items.at(-1)?.at || null };
  }
  // 只记真正从对方发来的作品卡片：出站、撤回、身份冲突、取不到作品编号的一律不进记录。
  record(contact, messages = []) {
    if (!recipientPattern.test(contact?.id || '') || typeof contact.isGroup !== 'boolean' || !Array.isArray(messages)) return 0;
    const incoming = messages.filter(message => Boolean(message) && message.sender === 'incoming'
      && message.media?.type === 'shared-work' && !['recalled', 'withdrawn', 'system', 'system-notice'].includes(message.kind || message.type)
      && message.media.identityConflict !== true);
    const resolved = incoming.map(message => ({ message, videoId: inboundVideoId(message.media) })).filter(item => item.videoId && typeof item.message.id === 'string' && messagePattern.test(item.message.id));
    if (!resolved.length) return 0;
    const data = readFile(this.file) || empty();
    let added = 0;
    for (const { message, videoId } of resolved) {
      // 同一位对象、同一条作品只留一条：重复发同一条不再刷新，避免反复往后挪把窗口无限延后。
      if (data.items.some(item => item.recipientId === contact.id && item.videoId === videoId)) continue;
      // 用消息自身的时间：补记历史时不能把一个月前的作品当成刚收到的，否则 30 天窗口会从补记时刻重新起算。
      const stamped = [message.sentAt, message.timestamp].find(value => typeof value === 'string' && isoPattern.test(value));
      const at = stamped && Date.parse(stamped) <= this.now() + 60_000 ? stamped : new Date(this.now()).toISOString();
      data.items.push({ recipientId: contact.id, isGroup: contact.isGroup, videoId, messageId: message.id, at });
      added++;
    }
    if (!added) return 0;
    data.items = data.items.slice(-INBOUND_SHARE_LIMIT);
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try { fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, this.file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return added;
  }
}
