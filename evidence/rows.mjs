import { createHash } from 'node:crypto';

// ============================================================
// 采集层：把浏览器读到的原始行正规化成"可对账的公开消息"。
//
// 这里只做纯映射，不碰 DOM、不碰实例状态、不读时钟：
//   - clientId / member 等运行时字段在这里被折叠成稳定哈希，绝不外泄原始值
//     （原始值可能含页面内部 ID，泄漏进水位文件就等于把页面结构写进磁盘）；
//   - 媒体资源只留 resourceRef + label，真正的字节仍由 chat-browser 的
//     mediaResources 保管 —— 因为"什么时候可以取字节"是授权问题，不是映射问题。
//
// 迭代 5：从 chat-browser.mjs 的 publicMessages() 原样抽出，行为零变更。
// ============================================================

const hash = value => createHash('sha256').update(value).digest('hex');

/**
 * 媒体资源引用名。
 * data: URL 用整串（内联内容就是身份）；普通 URL 只取 pathname ——
 * 查询串里带过期签名，参与身份会让同一张图每次刷新都换 ref。
 */
export function mediaResourceRef(src) {
  const identity = src.startsWith('data:') ? src : (() => {
    try { return new URL(src).pathname; } catch { return src; }
  })();
  return `media:${hash(identity)}`;
}

/**
 * 单行正规化。
 * @returns {{ message: object, refs: Array<{ref: string, src: string, label: string|null}> }}
 *   message —— 与重构前 publicMessages() 里 map 的返回值逐字段一致；
 *   refs    —— 语音资源登记表，交回调用方决定是否写入 mediaResources。
 */
export function normalizePublicRow(recipientId, row) {
  const { member, clientId, ...rest } = row;
  const identified = clientId ? { ...rest, clientMessageKey: hash(`${recipientId}\0${clientId}`) } : rest;
  const base = member ? {
    ...identified,
    memberId: member.nativeId ? `member:${hash(`${recipientId}\0${member.nativeId}`)}` : null,
    memberName: member.name || null,
    mentionedSelf: row.mentionedSelf === true,
  } : identified;
  if (!row.media) return { message: base, refs: [] };
  const { images = [], audioSources = [], ...media } = row.media;
  const refs = [...images, ...audioSources].filter(image => image.src).map(image => ({
    ref: mediaResourceRef(image.src),
    src: image.src,
    label: image.label ?? null,
  }));
  return {
    message: {
      ...base,
      media: {
        ...media,
        ...(media.type === 'voice' ? { sourceCount: refs.length } : { imageCount: refs.length }),
        resources: refs.map(({ ref, label }) => ({ resourceRef: ref, label })),
      },
    },
    refs,
  };
}
