// ============================================================
// 证据层 · 待答与恢复资格（迭代 8 从 chat-message.mjs 原样抽出）
//
// 三件事，都靠"证据链"而不是"看起来像"：
//   validBacklogQualification —— 这条待答消息当初为什么算合格（原生到达时间 + 指纹 + 基线）；
//   qualifyNativeUnanswered   —— 进程停摆期间漏掉的原生新私信，能不能补答（展示时间不算证据）；
//   mapBacklogMessages        —— 把待答目标映射到当前窗口，靠完整上下文后缀 + 相邻唯一性；
//   backlogOutgoingReadback   —— 补答之后，读回那条出站消息确认真的发出去了。
// 任何一环证据不足都返回不可用，绝不"猜一个位置"发出去。
// ============================================================
import { messageContent, messageFingerprint } from './fingerprint.mjs';

export const isOpenBacklogRecord = record => Boolean(record && !record.handledByUserAt && record.autoHandled !== true && !record.autoHandledAt);
const nativeArrivalSource = 'bound-native-after-observed-baseline-v1';
const plainNativeIncoming = message => message?.sender === 'incoming' && (!message.direction || message.direction === 'incoming') && message.kind === 'text' && !message.media && !message.reference && message.identitySource === 'dom-message-id' && message.nativeServerMessageBound === true && typeof message.text === 'string' && message.text.trim() && Number.isFinite(Date.parse(message.nativeCreatedAt));
export function validBacklogQualification(record, item, current) {
  if (item?.qualified !== true || item.message?.sender !== 'incoming' || !/^[a-f0-9]{64}$/.test(item.fingerprint ?? '') || messageFingerprint(item.message) !== item.fingerprint) return false;
  if (item.originalEligibleForReply === true) return true;
  const proof = item.nativeArrivalEvidence, evidence = record?.recoveryEvidence;
  if (record.phase !== 'unqualified' || item.originalEligibleForReply !== false || evidence?.qualificationSource !== nativeArrivalSource || proof?.source !== nativeArrivalSource || evidence.contact?.isGroup !== false || !plainNativeIncoming(item.message)) return false;
  const baseline = Date.parse(proof.observedBaselineAt), created = Date.parse(proof.nativeCreatedAt), detected = Date.parse(proof.detectedAt);
  if (![baseline, created, detected].every(Number.isFinite) || created <= baseline || created > detected || detected - created > 60_000 || proof.detectedAt !== record.at || proof.nativeCreatedAt !== item.message.nativeCreatedAt || proof.fingerprint !== item.fingerprint || !record.incoming?.some(message => message.id === item.message.id && message.text === item.message.text)) return false;
  return !current || plainNativeIncoming(current) && current.id === item.message.id && current.nativeCreatedAt === proof.nativeCreatedAt && messageFingerprint(current) === item.fingerprint;
}

// 仅恢复运行期间漏掉的原生新私信；展示时间、未发过的旧历史和发送不明均不足以放行。
export function qualifyNativeUnanswered(record, previousMark, messages, snapshot, contact, stopRequest, now = Date.now()) {
  if (!isOpenBacklogRecord(record) || record.phase !== 'unqualified' || record.recoveryEvidence || record.autoAttempt || record.legacyUncertain || contact?.isGroup !== false || !Array.isArray(record.incoming) || record.incoming.length !== 1 || !Array.isArray(messages) || !messages.length || messages.length > 512) return null;
  const source = snapshot?.dayEvidence ?? snapshot;
  if (source?.chronology !== 'oldest-first' || source.latestEndVerified !== true || messages.some(message => message.latestEndVerified !== true || !['incoming', 'outgoing'].includes(message.sender) || message.direction && message.direction !== message.sender) || new Set(messages.map(message => message.id)).size !== messages.length) return null;
  const original = record.incoming[0], prior = previousMark?.context?.find(message => message.id === original.id), index = messages.findIndex(message => message.id === original.id), current = messages[index];
  if (!plainNativeIncoming(current) || !prior || prior.sender !== 'incoming' || prior.identitySource !== 'dom-message-id' || prior.eligibleForReply !== false || prior.arrivalClassification !== 'ambiguous-new' || prior.latestEndVerified !== true || prior.text !== original.text || messageFingerprint(prior) !== messageFingerprint(current) || messages.slice(index + 1).some(message => message.sender === 'outgoing')) return null;
  const baseline = Date.parse(previousMark.startedAt), created = Date.parse(current.nativeCreatedAt), detected = Date.parse(record.at), stopAt = Date.parse(stopRequest?.requestedAt);
  if (![baseline, created, detected].every(Number.isFinite) || baseline >= created || created > detected || detected - created > 60_000 || detected > now || Date.parse(prior.timestamp ?? prior.sentAt) !== created || stopRequest?.preservePending !== true && Number.isFinite(stopAt) && stopAt >= detected) return null;
  const fingerprint = messageFingerprint(current), item = { message: structuredClone(current), fingerprint, qualified: true, originalEligibleForReply: false, nativeArrivalEvidence: { source: nativeArrivalSource, observedBaselineAt: previousMark.startedAt, nativeCreatedAt: current.nativeCreatedAt, detectedAt: record.at, fingerprint } };
  const evidence = { version: 1, qualificationSource: nativeArrivalSource, beforeDispatch: true, contact: structuredClone(contact), qualifiedIncoming: [item], expectedContent: messageContent(messages), qualifiedAt: new Date(now).toISOString() };
  return validBacklogQualification({ ...record, recoveryEvidence: evidence }, item, current) ? evidence : null;
}
export function mapBacklogMessages(record, messages) {
  const evidence = record?.recoveryEvidence, qualified = evidence?.qualifiedIncoming;
  if (!Array.isArray(messages) || messages.length > 512 || messages.some(message => !message || typeof message.id !== 'string' || !message.id || !['incoming', 'outgoing'].includes(message.sender || message.direction) || message.sender && message.direction && message.sender !== message.direction) || new Set(messages.map(message => message.id)).size !== messages.length) return { ready: false, reason: 'current-direction-or-identity' };
  if (evidence?.version !== 1 || !Array.isArray(qualified) || !qualified.length || qualified.length > 8 || qualified.some(item => !validBacklogQualification(record, item, item.originalEligibleForReply === false ? messages.find(message => message.id === item.message?.id) ?? {} : undefined))) return { ready: false, reason: 'qualification-evidence-unavailable' };
  const expected = evidence.expectedContent;
  if (!Array.isArray(expected) || !expected.length || expected.length > 2000 || expected.some(item => !item || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint ?? '')) || new Set(expected.map(item => item.id)).size !== expected.length) return { ready: false, reason: 'context-evidence-unavailable' };
  const current = messages.map(message => messageFingerprint(message)), joinedCurrent = current.join('|'), targets = [];
  for (const item of qualified) {
    const targetIndex = expected.findIndex(message => message.id === item.message.id && message.fingerprint === item.fingerprint);
    if (targetIndex < 0) return { ready: false, reason: 'target-context-unavailable' };
    let context;
    const minimum = item.message.identitySource === 'dom-message-id' ? Math.min(3, expected.length) : 3;
    for (let offset = Math.max(0, expected.length - messages.length); offset <= Math.min(targetIndex, expected.length - minimum); offset++) {
      const suffix = expected.slice(offset), sequence = suffix.map(message => message.fingerprint).join('|'), start = joinedCurrent.indexOf(sequence);
      if (start < 0) continue;
      if (start % 65 !== 0 || joinedCurrent.lastIndexOf(sequence) !== start) return { ready: false, reason: 'context-not-unique' };
      const relativeTarget = targetIndex - offset;
      const neighbors = suffix.slice(Math.max(0, relativeTarget - 2), Math.min(suffix.length, relativeTarget + 3)).filter((_, index) => Math.max(0, relativeTarget - 2) + index !== relativeTarget);
      if (item.message.identitySource !== 'dom-message-id' && new Set(neighbors.map(value => value.fingerprint).filter(value => value !== item.fingerprint)).size < 2) return { ready: false, reason: 'legacy-adjacency-insufficient' };
      context = { start: start / 65, end: start / 65 + suffix.length - 1, target: start / 65 + relativeTarget, offset };
      break;
    }
    if (!context) return { ready: false, reason: 'complete-context-suffix-unavailable' };
    if (item.message.identitySource === 'dom-message-id') {
      const index = messages.findIndex(message => message.id === item.message.id);
      if (index < 0 || index !== context.target || messages[index].identitySource !== 'dom-message-id' || messages[index].sender !== 'incoming' || current[index] !== item.fingerprint) return { ready: false, reason: 'native-target-unavailable' };
      targets.push({ index, message: messages[index], fingerprint: item.fingerprint, mapping: 'native-id-fingerprint-context', context });
      continue;
    }
    if (targetIndex < 0 || expected.length < 3) return { ready: false, reason: 'legacy-context-incomplete' };
    const index = context.target;
    if (messages[index].identitySource !== 'dom-message-id' || messages[index].sender !== 'incoming') return { ready: false, reason: 'legacy-native-target-unavailable' };
    targets.push({ index, message: messages[index], fingerprint: item.fingerprint, mapping: 'unique-complete-context-suffix-adjacency', context });
  }
  if (new Set(targets.map(item => item.message.id)).size !== targets.length) return { ready: false, reason: 'duplicate-target' };
  const uncertain = ['reserved', 'uncertain'].includes(record.autoAttempt?.state) || record.recoveryEvidence.beforeDispatch === false || ['sending', 'delivery-uncertain'].includes(record.phase);
  const laterOutgoing = messages.slice(Math.max(...targets.map(item => item.index)) + 1).some(message => message.sender === 'outgoing');
  return { ready: true, targets, uncertain, laterOutgoing, canSend: !uncertain && !laterOutgoing && (['not-sent', 'model', 'observing', 'superseded', 'stopped-before-send'].includes(record.phase) || record.phase === 'unqualified' && evidence.qualificationSource === nativeArrivalSource) && record.recoveryEvidence.beforeDispatch === true };
}

export function backlogOutgoingReadback(record, mapping, messages, expectedText) {
  if (!mapping?.ready) return null;
  const last = Math.max(...mapping.targets.map(item => item.context.end)), known = new Set(record.recoveryEvidence.expectedContent.map(item => item.id));
  const candidates = messages.slice(last + 1).filter(message => message.sender === 'outgoing' && message.identitySource === 'dom-message-id' && !known.has(message.id) && message.failed !== true && message.pending !== true && message.sent !== false && (!mapping.uncertain || typeof expectedText === 'string' && message.text?.trim() === expectedText.trim()));
  if (mapping.uncertain) return candidates.length === 1 ? candidates[0] : null;
  return candidates.at(-1) || null;
}
