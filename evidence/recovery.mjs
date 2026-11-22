// ============================================================
// 证据层 · 重启后能否续发（迭代 15 从 chat-service.mjs 原样抽出）
//
// 这是"上次发送结果不明"之后唯一的闸门，两道：
//   recoveryEvidence    —— 发之前先把"我准备发什么、依据是什么"落盘：
//                          每条消息的指纹、当前窗口完整内容、许可会话快照、停止请求 ID。
//   recoverableIncoming —— 重启后逐条回核：许可会话仍是同一个（双向比对）、
//                          窗口内容与落盘时**逐字节**相同、每条消息的指纹仍能对上、
//                          恢复许可未过期、最后一条之后不能再有出站消息。
// 任何一条不成立就返回 null / 空数组 —— 宁可把消息留在待答清单里让人看，
// 也不重发一条可能已经发出去的消息。
// ============================================================
import { messageFingerprint } from './fingerprint.mjs';
import { matchesAuthorizedContact } from './authorization.mjs';
import { contentOf } from './unanswered-ledger.mjs';

export function recoveryEvidence(contact,incoming,messages,prior,stopRequest) {
  if(!incoming.length)return null;
  const qualifiedIncoming=incoming.map(message=>{const qualified=message.eligibleForReply===true||prior?.qualifiedIncoming?.some(item=>item.qualified===true&&item.originalEligibleForReply===true&&item.message?.id===message.id&&item.fingerprint===messageFingerprint(message))===true;return{message:structuredClone(message),fingerprint:messageFingerprint(message),qualified,originalEligibleForReply:qualified};});
  if(qualifiedIncoming.some(item=>!item.qualified||item.message.sender!=='incoming'))return null;
  return{version:1,beforeDispatch:true,contact:structuredClone(contact),qualifiedIncoming,expectedContent:contentOf(messages),qualifiedAt:prior?.qualifiedAt||new Date().toISOString(),stopRequestId:prior?.stopRequestId??stopRequest?.requestId??null};
}
export function recoverableIncoming(pending,contact,messages,stopRequest) {
  const evidence=pending?.recoveryEvidence;
  if(!pending?.restartAllowed||!Number.isFinite(pending.recoveryExpiresAt)||pending.recoveryExpiresAt<Date.now()||evidence?.version!==1||evidence.beforeDispatch!==true||!matchesAuthorizedContact(evidence.contact,contact)||!matchesAuthorizedContact(contact,evidence.contact)||!Array.isArray(evidence.qualifiedIncoming)||!evidence.qualifiedIncoming.length||JSON.stringify(evidence.expectedContent)!==JSON.stringify(contentOf(messages))||messages.some(item=>item.sender==='unknown'))return null;
  if(stopRequest&&stopRequest.preservePending!==true&&stopRequest.requestId!==evidence.stopRequestId)return null;
  const incoming=[];
  for(const item of evidence.qualifiedIncoming){const current=messages.find(value=>value.id===item.message?.id);if(item.qualified!==true||item.originalEligibleForReply!==true||!current||current.sender!=='incoming'||item.fingerprint!==messageFingerprint(current))return null;incoming.push(current);}
  const last=messages.findLastIndex(item=>incoming.some(value=>value.id===item.id));if(last<0||messages.slice(last+1).some(item=>item.sender==='outgoing'))return null;
  return incoming;
}
