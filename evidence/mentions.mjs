// ============================================================
// 证据层 · 群聊提及判定（迭代 18 从包根 group-reply-trigger.mjs 原样搬入）
//
// 只回答一件事：这条群消息是不是在叫我们。
//   normalizeMentionNames   —— 昵称归一：NFKC（全角→半角）、去零宽字符、去前缀 @、去重，
//                              并要求 1–10 个、每个不超过 40 字；
//   groupMessageAddressesFish —— 页面已经标了 mentionedSelf 就直接算；
//                              否则在正文里找昵称（同样先归一、再小写化）。
// 判错的代价不对称：漏判只是少回一句，误判会在群里对无关发言插嘴。
// 所以宁可漏判 —— 这里没有模糊匹配，只有"昵称出现在正文里"。
// ============================================================

export function normalizeMentionNames(value = ['大肥鱼']) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10 || value.some(name => typeof name !== 'string' || !name.trim() || name.trim().length > 40 || /[\0\r\n]/.test(name))) throw new Error('群聊响应昵称须填写1至10个，每个最多40字。');
  const names = value.map(name => name.normalize('NFKC').replace(/[\u200B-\u200F\uFEFF]/g, '').trim().replace(/^@/, '').trim());
  if (names.some(name => !name || name.length > 40 || /^@+$/.test(name))) throw new Error('群聊响应昵称不能为空或只填 @。');
  return [...new Set(names)];
}

export function groupMessageAddressesFish(message, names = ['大肥鱼']) {
  if (message?.mentionedSelf === true) return true;
  const text = String(message?.text || '').normalize('NFKC').replace(/[\u200B-\u200F\uFEFF]/g, '').toLocaleLowerCase();
  return normalizeMentionNames(names).some(name => text.includes(name.toLocaleLowerCase()));
}
