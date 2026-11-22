// ============================================================
// 证据层 · 水位族（迭代 7 从 chat-message.mjs 原样抽出）
//
// 水位的两种形态：
//   messageWatermark       —— 采一份"当时看到的快照"，含内容清单与时间轴方向；
//   compareMessageWatermark —— 发送前再核一次，虚拟列表补载前缀可容忍，
//                              锚点丢失 / 内容改动 / 未经核实的尾部一律拒绝。
// 拒绝比误发便宜：这里返回 matches:false 只是"这次不发"。
// ============================================================
import { messageContent } from './fingerprint.mjs';

export function messageWatermark(messages, evidence = {}) {
  const source = evidence.dayEvidence ?? evidence;
  return { content: messageContent(messages), chronology: source.chronology ?? 'unknown', latestEndVerified: messages.length > 0 && messages.every(message => message.latestEndVerified === true) && source.latestEndVerified !== false };
}

// 虚拟列表可以补载或移除旧前缀；最新锚点和全部连续重叠内容必须保留。
export function compareMessageWatermark(expected, messages, evidence = {}) {
  const source = evidence.dayEvidence ?? evidence, expectedContent = expected?.content;
  const invalidDirection = message => !['incoming', 'outgoing'].includes(message?.sender || message?.direction) || message?.sender && message?.direction && message.sender !== message.direction;
  const validContent = content => Array.isArray(content) && content.every(item => item && typeof item.id === 'string' && item.id.length > 0 && /^[a-f0-9]{64}$/.test(item.fingerprint ?? '')) && new Set(content.map(item => item.id)).size === content.length;
  if (!validContent(expectedContent) || !Array.isArray(messages) || messages.some(message => !message || typeof message.id !== 'string' || !message.id) || new Set(messages.map(message => message.id)).size !== messages.length) return { matches: false, diagnostic: { invalidWatermark: true } };
  const expectedIds = expectedContent.map(item => item.id), known = new Map(expectedContent.map(item => [item.id, item.fingerprint]));
  const actual = messageContent(messages), anchor = expectedIds.at(-1), anchorIndex = messages.findIndex(item => item.id === anchor);
  const currentLatestEndVerified = messages.length > 0 && messages.every(message => message.latestEndVerified === true) && source.latestEndVerified !== false;
  const diagnostic = { expectedCount: expectedIds.length, currentCount: messages.length, expectedLatestEndVerified: expected.latestEndVerified === true, currentLatestEndVerified, chronology: source.chronology ?? 'unknown', suffixOffset: messages.length <= expectedIds.length ? expectedIds.length - messages.length : null,
    latestAnchorPresent: anchorIndex >= 0, latestAnchorAtEnd: anchorIndex >= 0 && anchorIndex === messages.length - 1, latestAnchorFingerprintMatches: anchorIndex >= 0 && actual[anchorIndex].fingerprint === known.get(anchor), allOverlapContentMatches: actual.filter(item => known.has(item.id)).every(item => item.fingerprint === known.get(item.id)), unknownDirectionCount: messages.filter(invalidDirection).length,
    additionalCount: messages.filter(item => !known.has(item.id)).length, additionalClassifications: Object.fromEntries(['old-history', 'known-old-window', 'new-tail', 'ambiguous-new', 'baseline'].map(kind => [kind, messages.filter(item => !known.has(item.id) && item.arrivalClassification === kind).length])) };
  if (diagnostic.unknownDirectionCount) return { matches: false, diagnostic };
  if (JSON.stringify(actual) === JSON.stringify(expectedContent)) return { matches: true, diagnostic };
  if (!messages.length || expected.chronology !== 'oldest-first' || source.chronology !== 'oldest-first' || expected.latestEndVerified !== true || !currentLatestEndVerified || !diagnostic.latestAnchorAtEnd || !diagnostic.latestAnchorFingerprintMatches || !diagnostic.allOverlapContentMatches) return { matches: false, diagnostic };
  const firstOverlap = messages.findIndex(item => known.has(item.id)), expectedOffset = expectedIds.indexOf(messages[firstOverlap]?.id);
  if (firstOverlap < 0 || expectedOffset < 0) return { matches: false, diagnostic };
  const overlap = actual.slice(firstOverlap), prefix = messages.slice(0, firstOverlap);
  diagnostic.suffixOffset = expectedOffset; diagnostic.additionalPrefixCount = prefix.length;
  const matches = JSON.stringify(overlap) === JSON.stringify(expectedContent.slice(expectedOffset))
    && prefix.every(item => !known.has(item.id) && ['old-history', 'known-old-window'].includes(item.arrivalClassification) && item.eligibleForReply !== true);
  return { matches, diagnostic };
}
