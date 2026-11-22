// 门面（迭代 8）：chat-message.mjs 的实现已全部搬走，这里只剩 re-export。
//
// 各族的去处：
//   指纹  messageFingerprint / messageContent          → evidence/fingerprint.mjs
//   水位  messageWatermark / compareMessageWatermark   → evidence/watermark.mjs
//   准入  isMetadataMessage / isReplyableMessage       → evidence/admission.mjs
//   待答  backlog 族（资格/补答/映射/读回）            → evidence/backlog.mjs
//   投影  chatMessageSummary（给模型看什么）           → agent/projection.mjs
//
// 为什么不改调用方 import：全部 import 带 `?v=` 缓存戳，改路径是一批可避免的回归面。
// 门面让回滚只动本文件，调用方（chat-browser / chat-service / chat-agent /
// spark-service / group-video-inbox）路径一律不变。
export { messageFingerprint, messageContent } from './evidence/fingerprint.mjs';
export { messageWatermark, compareMessageWatermark } from './evidence/watermark.mjs';
export { isMetadataMessage, isReplyableMessage } from './evidence/admission.mjs';
export {
  isOpenBacklogRecord, validBacklogQualification, qualifyNativeUnanswered, mapBacklogMessages, backlogOutgoingReadback,
} from './evidence/backlog.mjs';
export { chatMessageSummary } from './agent/projection.mjs';
