// 门面（迭代 10）：授权判定已搬进 evidence/authorization.mjs，这里只做 re-export。
//
// 七个模块（chat-browser / chat-service / autonomous-share / spark-service /
// video-forward / receipt-baseline / tests）的 import 路径一律不变；
// 回滚只需把 implementation 搬回本文件，调用方零改动。
export {
  MAX_AUTHORIZED_CONTACTS,
  hasVerifiedConversationIdentity,
  hasStableConversationIdentity,
  canAuthorizeConversation,
  isStoredContactAuthorized,
  matchesAuthorizedContact,
  upgradeAuthorizedContact,
  sameWeakConversation,
} from './evidence/authorization.mjs';
