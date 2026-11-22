// 门面（迭代 18）：群聊提及判定已搬进 evidence/mentions.mjs，这里只做 re-export。
// 调用方（chat-service）的 import 路径不变；回滚只需恢复本文件内容。
export { normalizeMentionNames, groupMessageAddressesFish } from './evidence/mentions.mjs';
