// ============================================================
// 评论链路的页内作用域定义（唯一定义源）—— R1
//
// 为什么需要这个文件：
//   visible / privateArea / 身份判定都运行在浏览器上下文（page.evaluate /
//   locator.evaluate）。Playwright 只序列化函数源码、不传递 Node 作用域，
//   所以同一个 helper 过去被复制了 4 份，且已经漂移（readCommentDom 那份
//   少了 opacity 祖先检查）。这里把定义收敛到一处，调用点用
//   `scopeSource()` 把源码注入闭包 —— 与 video-forward.mjs 的
//   `installForwardWitness` 同一套做法。
//
// 行为契约：
//   visibleWithOpacity 与重构前 58 / 104 / 278 行三份等价；
//   visiblePaintOnly  与重构前 331 行那份等价（确实少了 opacity 检查，
//   **不合并**，合并会改变 readCommentDom 的判定结果）。
//   tests/comment-scope.test.mjs 用重构前实现做等价性 oracle。
// ============================================================

// 三处"私有区"选择器各不相同，历史上各有原因，这里只集中定义、不合并语义：
// identity   —— 身份判定时排除私信、会话项、评论项（原 57 / 277 行）
// pointer    —— 几何见证时额外排除评论列表、弹幕容器（原 105 行）
// publicRows —— 公开评论回读时只排除私信与会话项（原 335 行）
export const PRIVATE_AREA = Object.freeze({
  identity: '[data-e2e="im-dialog"],[data-e2e="conversation-item"],[data-e2e="comment-item"]',
  pointer: '[data-e2e="im-dialog"],[data-e2e="conversation-item"],[data-e2e="comment-item"],[data-e2e="comment-list"],[data-e2e="danmaku-container"]',
  publicRows: '[data-e2e="im-dialog"],[data-e2e="conversation-item"]',
});

// 几何 + 绘制 + opacity 祖先链：身份判定与指针见证使用（原 58 / 104 / 278 行）。
export function visibleWithOpacity(element) {
  const r = element.getBoundingClientRect(), s = getComputedStyle(element);
  if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden')) return false;
  for (let node = element; node; node = node.parentElement) if (Number(getComputedStyle(node).opacity) === 0) return false;
  return true;
}

// 只判几何与 display/visibility，不查 opacity：公开评论回读使用（原 331 行）。
// 语义与上面不同，属于既有行为，未在本次重构中收紧。
export function visiblePaintOnly(element) {
  const r = element.getBoundingClientRect(), s = getComputedStyle(element);
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden';
}

// 生成注入用的作用域前缀：`const visible=...;const privateArea="...";`
// 调用点把它拼进 new Function 的源码，页内函数即可拿到与这里同名同值的绑定。
export function scopeSource({ area = 'pointer', paint = false } = {}) {
  const visible = paint ? visiblePaintOnly : visibleWithOpacity;
  return `const visible=(${visible.toString()});const privateArea=${JSON.stringify(PRIVATE_AREA[area])};`;
}

// 身份判定本体：只依赖传入的两个 helper，便于被注入到任意页内闭包。
// 判定顺序、错误码、短路条件与重构前逐字一致，改动此函数等于改生产行为。
function readCommentSelfIdentityCore(visible, privateArea) {
  const denied = reasonCode => ({ ready: false, ownProfileId: null, reasonCode });
  if (location.origin !== 'https://www.douyin.com') return denied('self-origin-unavailable');
  const anchors = [...document.querySelectorAll('.tab-user_self a[href]')].filter(anchor => visible(anchor) && !anchor.closest(privateArea));
  if (anchors.length !== 1) return denied('self-navigation-ambiguous');
  let route;
  try { route = new URL(anchors[0].getAttribute('href'), location.origin); } catch { return denied('self-navigation-invalid'); }
  if (route.origin !== location.origin || route.username || route.password) return denied('self-navigation-invalid');
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{5,300}$/.test(value) && value !== 'self';
  const secureId = /^\/user\/([A-Za-z0-9_-]{5,300})\/?$/.exec(route.pathname)?.[1] || null;
  if (!secureId && !/^\/user\/self\/?$/.test(route.pathname)) return denied('self-navigation-invalid');
  let accessor = false, conflict = false, loggedOut = false;
  const data = (object, key) => {
    if (!object || typeof object !== 'object') return undefined;
    let descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) { const prototype = Object.getPrototypeOf(object); if (prototype) descriptor = Object.getOwnPropertyDescriptor(prototype, key); }
    if (!descriptor) return undefined;
    if (!('value' in descriptor)) { accessor = true; return undefined; }
    return descriptor.value;
  };
  const ids = new Set(), seen = new Set();
  for (const node of new Set([anchors[0], anchors[0].closest('.tab-user_self')])) {
    if (!node) continue;
    const keys = Object.getOwnPropertyNames(node).filter(key => key.startsWith('__reactFiber$'));
    if (keys.length > 1) { conflict = true; continue; }
    let fiber = keys.length === 1 ? data(node, keys[0]) : null;
    for (let depth = 0; fiber && depth <= 5; depth++) {
      if (depth > 0) fiber = data(fiber, 'return');
      if (!fiber) break;
      const props = data(fiber, 'memoizedProps'), user = data(props, 'userInfo');
      if (!user || typeof user !== 'object' || seen.has(user)) continue;
      seen.add(user);
      const isLogin = data(user, 'isLogin'), status = data(user, 'statusCode');
      if (isLogin === false || typeof status === 'number' && status !== 0) { loggedOut = true; continue; }
      if (isLogin !== true || status !== 0) continue;
      const info = data(user, 'info'); if (!info || typeof info !== 'object') continue;
      const camel = data(info, 'secUid'), snake = data(info, 'sec_uid');
      if (camel !== undefined && !validId(camel) || snake !== undefined && !validId(snake) || camel !== undefined && snake !== undefined && camel !== snake) { conflict = true; continue; }
      if (validId(camel)) ids.add(camel); if (validId(snake)) ids.add(snake);
    }
  }
  if (accessor) return denied('self-metadata-accessor');
  if (loggedOut) return denied('self-not-logged-in');
  if (conflict || ids.size > 1 || secureId && ids.size === 1 && !ids.has(secureId)) return denied('self-identity-conflict');
  const ownProfileId = secureId || [...ids][0];
  if (!validId(ownProfileId)) return denied('self-identity-unavailable');
  return { ready: true, ownProfileId, source: secureId ? ids.size ? 'navigation-and-login-metadata' : 'secure-navigation' : 'navigation-login-metadata' };
}

// 页面可直接调用的零参版本：page.evaluate(readCommentSelfIdentity) 用法保持不变。
// 注意：这里导出的是"函数本身"（不带尾随调用），toString() 得到的是自包含源码
// （前缀里的 visible / privateArea 会一起被序列化），因此它既能交给 Playwright，
// 也能被再注入进别的页内闭包。
export const readCommentSelfIdentity = new Function(`${scopeSource({ area: 'identity' })}return (${readCommentSelfIdentityCore.toString()})(visible,privateArea);`);
