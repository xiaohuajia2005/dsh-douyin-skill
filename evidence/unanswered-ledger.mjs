// ============================================================
// 证据层 · 待答清单与对账（迭代 14 从 chat-service.mjs 原样抽出）
//
// 这一层产出的是"人看到的那张待核对清单"，以及它的对账指纹：
//   unansweredRecordId —— 一条待答记录的确定性身份。archiveId 优先，
//                         否则由 phase/skippedAt/at/incoming 的 id+kind+type+media 组成。
//                         **这段 JSON 一旦改字段或顺序，全部历史记录的 ID 都会变**，
//                         界面上表现为旧待答"消失"、新待答"重现"。改动必须先改测试。
//   unansweredSnapshot —— 只取仍未关闭的记录，按 recordId 排序后哈希；
//                         顺序排序保证同一批记录无论读取顺序如何都得到同一个快照。
//   autoPendingCount   —— 自动待答计数：未关闭的待答 + 处于 inflight/delivery-uncertain
//                         且尚未取得补答许可的进行中项。
//   unansweredReason / messageKind / unansweredPreview —— 只做"如实转述"，
//                         没有正文就说没有正文，绝不猜测内容。
// 全部纯函数，零文件与浏览器依赖，可离线全量测试。
// ============================================================
import { createHash } from 'node:crypto';
import { messageFingerprint } from './fingerprint.mjs';
import { isOpenBacklogRecord } from './backlog.mjs';

export const contentOf=messages=>messages.map(message=>({id:message.id,fingerprint:messageFingerprint(message)}));
export const unresolvedManual=mark=>mark.accountActionRequired===true?1:0;
export const autoPendingCount=mark=>(mark.unanswered||[]).filter(isOpenBacklogRecord).length+(['inflight','delivery-uncertain'].includes(mark.status)&&mark.pending?.incoming?.length&&!mark.pending.backlogAuthorization?1:0);
export const unansweredReason=item=>typeof item?.reason==='string'&&item.reason.trim()?item.reason.trim().slice(0,200):({
  unqualified:'新消息尚未取得可靠的新到达资格，未自动回复。',
  'unsupported-media':'消息附件未能可靠读取，未推断内容。',
  'not-sent':'发送前检查未通过，未发送。',
  'stopped-before-send':'维护或停止前未发送，保留待核对。',
  'delivery-uncertain':'上次发送结果未确认，未自动重发。',
}[item?.phase]||'这条消息没有完成自动回复，保留待核对。');
export const messageKind=message=>message?.media?.type==='voice'?'语音':message?.media?.type==='image'?'图片':message?.media?.type==='emoji'?'表情':message?.media?.type==='shared-work'?'分享作品':message?.unsupported===true?'不支持的消息':typeof message?.text==='string'&&message.text.trim()?'文字':'未知类型';
export const unansweredRecordId=(contactId,item)=>createHash('sha256').update(JSON.stringify([contactId,item?.archiveId?['archive',item.archiveId]:['legacy',item?.phase||'',item?.skippedAt||null,item?.at||null,(item?.incoming||[]).map(message=>({id:message?.id||'',kind:message?.kind||null,type:message?.type||null,media:message?.media?.type||null}))]])).digest('hex');
export function unansweredItems(watermarks,policy){const items=[];for(const contact of policy.allowlist){const mark=watermarks.contacts?.[contact.id];for(const item of mark?.unanswered||[])items.push({contact,item,recordId:unansweredRecordId(contact.id,item)});}return items;}
export function unansweredSnapshot(items){return createHash('sha256').update(items.filter(entry=>isOpenBacklogRecord(entry.item)).map(entry=>entry.recordId).sort().join('\n')).digest('hex');}
export function unansweredPreview(item){const messages=Array.isArray(item?.incoming)?item.incoming:[];const text=messages.find(message=>typeof message?.text==='string'&&message.text.trim());if(text)return{preview:text.text.trim().slice(0,160),previewNote:'本地保留的文字预览，仅用于核对；不会自动补发。'};const kinds=[...new Set(messages.map(messageKind))];return{preview:null,previewNote:kinds.length?`${kinds.join('、')}消息没有可显示的文字正文，未做识别或猜测。`:'本地没有这条消息的可显示内容，未做识别或猜测。'};}
