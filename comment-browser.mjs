import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as waitForCommentTick } from 'node:timers/promises';
import { BrowserController, readPageState } from './core.mjs?v=9';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { validateCommentText } from './autonomous-comments.mjs';

import { acquireStateLock } from './service/state-lock.mjs';
import { commentPostLockDecision } from './comment/lock-policy.mjs';
import { readCommentSelfIdentity, scopeSource } from './comment/scope.mjs';
import { COMMENT_RECEIPT_LIMIT, COMMENT_SCAN_BUDGET, COMMENT_TIMING } from './comment/timing.mjs';
import { trimCommentReceipts } from './comment/receipts.mjs';
// 身份判定已迁至 comment/scope.mjs（唯一定义源）；保持原导出路径，video-forward 等调用方无需改动。
export { readCommentSelfIdentity };

const stop = signal => signal?.throwIfAborted();
const cleanDraft = value => String(value ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').trim();
const EDITORS = ['.comment-input-container [contenteditable="true"]', '.comment-input-container textarea', '.comment-input-inner-container [contenteditable="true"]', '.comment-input-inner-container textarea', '[data-e2e="comment-input"] [contenteditable="true"]', 'textarea[data-e2e="comment-input"]', '[contenteditable="true"][data-e2e="comment-input"]'].map(selector => `${selector}:not([data-e2e="im-dialog"] *):not([data-e2e="danmaku-container"] *)`).join(',');
const BUTTONS = '[data-e2e="comment-post"],[data-e2e="comment-submit"],[data-e2e="comment-publish"],button,[role="button"],a,div,span';
const LABELLED_BUTTONS = '[aria-label="发布"],[aria-label="发送"],[aria-label="发表评论"],[aria-label="发布评论"],[title="发布"],[title="发表评论"],[title="发布评论"]';
const NATIVE_PUBLISH = '.commentInput-right-ct .oWdMk9B9 span.wchsYBpK';
// 2026-10-24从专用浏览器只读核对；无标签图标仅接受这组结构与几何。
const NATIVE_PUBLISH_ICON = {
  viewBox: '0 0 36 36',
  paths: [
    { d: 'M17.5 30C23.851 30 29 24.851 29 18.5S23.851 7 17.5 7 6 12.149 6 18.5 11.149 30 17.5 30zm-5.16-13.883a1.16 1.16 0 0 0 1.64 1.64l2.395-2.394v8.838a1.16 1.16 0 0 0 2.321 0v-8.839l1.028 1.028 1.368 1.368a1.16 1.16 0 1 0 1.64-1.641l-4.219-4.22a1.382 1.382 0 0 0-1.954 0l-4.22 4.22h.001z', fill: '#fe2c55' },
    { d: 'M12.34 16.117a1.16 1.16 0 0 0 1.64 1.64l2.395-2.394v8.838a1.16 1.16 0 0 0 2.321 0v-8.839l1.028 1.028 1.368 1.368a1.16 1.16 0 1 0 1.64-1.641l-4.219-4.22a1.382 1.382 0 0 0-1.954 0l-4.22 4.22h.001z', fill: '#fff' },
  ],
};
const PUBLISH_LABEL = /^(?:发布|发送|发表评论|发布评论)$/;
import {writeDurableReceiptFile as write,createCommentReceiptBaseline,createShareReceiptBaseline,checkReceiptBaseline,preserveReceiptBaseline} from './receipt-baseline.mjs';

async function composerScopeValid(root, expectedVideoId) {
  return root.evaluate((element, expected) => {
    if (element.closest('[data-e2e="im-dialog"],[data-e2e="danmaku-container"],[data-e2e="comment-item"],[data-e2e="comment-list"]')) return false;
    const owner = element.closest('[data-aweme-id],[data-video-id]');
    const videoId = owner?.getAttribute('data-aweme-id') || owner?.getAttribute('data-video-id');
    return !videoId || videoId === expected;
  }, expectedVideoId);
}

const sameCommentPoint = (left, right) => Boolean(left && right && ['x', 'y', 'width', 'height'].every(key => Math.abs(left[key] - right[key]) <= 0.5));
async function waitCommentState(test, check, signal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do { stop(signal); await check(); if (await test()) return true; if (Date.now() >= deadline) break; await waitForCommentTick(COMMENT_TIMING.stateTickMs, undefined, { signal }); } while (Date.now() < deadline);
  return false;
}

// 页内几何见证本体：只依赖注入的 visible / privateArea / readSelf（R1 抽取）。
// 判定顺序与各条 return false 的条件与重构前逐字相同，仅把三个闭包捕获改成参数。
function installInputWitness(element, input, { visible, privateArea, readSelf }) {
  const scopes = [...document.querySelectorAll('[data-deepseek-comment-pointer-scope]')].filter(node => node.getAttribute('data-deepseek-comment-pointer-scope') === input.token), scope = scopes.length === 1 ? scopes[0] : null;
  // 2026-11-21 修复：评论输入区常位于页面滚动容器可视区之外，先滚入视口再做几何与命中核对。
  if (!element.isConnected) return false;
  { const box = element.getBoundingClientRect(); if (!(box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth)) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); }
  if (!scope || scope.matches('body,html') || !scope.isConnected || !scope.contains(element) || !element.isConnected || element.closest(privateArea) || scope.closest(privateArea) || scope.querySelector(privateArea) || !visible(element)) return false;
  const owner = scope.closest('[data-aweme-id],[data-video-id]');
  const ownerMatches = () => { const current = scope.closest('[data-aweme-id],[data-video-id]'); if (current !== owner) return false; const values = [current?.getAttribute('data-aweme-id'), current?.getAttribute('data-video-id')].filter(Boolean); return values.every(value => value === input.expectedVideoId); };
  if (!ownerMatches()) return false;
  const editorsInScope = () => [...scope.querySelectorAll('[contenteditable="true"],textarea'), ...(scope.matches('[contenteditable="true"],textarea') ? [scope] : [])];
  const entries = window.__deepseekCommentGeometryInputs ??= Object.create(null);
  element.setAttribute('data-deepseek-comment-pointer', input.token);
  let draftElement = null;
  if (input.mode === 'editor') draftElement = element;
  if (input.mode === 'submit') { const editors = editorsInScope(); if (editors.length === 1) draftElement = editors[0]; else { element.removeAttribute('data-deepseek-comment-pointer'); return false; } }
  const clean = value => String(value ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').trim();
  const entry = { element, scope, mode: input.mode, draftElement, dispatched: false, blocked: false, armed: false, armedAt: null, point: null, pointerStarted: false };
  const videoMatches = () => {
    const route = new URL(location.href), routeId = /^\/video\/(\d+)\/?$/.exec(route.pathname)?.[1] || route.searchParams.get('modal_id') || route.searchParams.get('aweme_id');
    if (routeId && routeId !== input.expectedVideoId) return false;
    const candidates = [...document.querySelectorAll('[data-e2e="player-container"]')].filter(player => !player.closest(privateArea)).flatMap(player => [...player.querySelectorAll('video')].filter(visible).map(video => { const r = video.getBoundingClientRect(); return { id: /(?:^|\s)video_(\d+)(?:\s|$)/.exec(player.className || '')?.[1] || null, area: Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) * Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) }; })).sort((a, b) => b.area - a.area);
    if (candidates.length && candidates[0].id && candidates[0].id !== input.expectedVideoId) return false;
    if (candidates.length > 1 && candidates[0].area === candidates[1].area && candidates[0].id !== candidates[1].id) return false;
    return routeId === input.expectedVideoId || candidates[0]?.id === input.expectedVideoId;
  };
  const iconMatches = () => {
    if (!input.icon) return true;
    const composer = element.closest('.comment-input-inner-container'), toolbar = element.closest('.commentInput-right-ct'), box = element.closest('.oWdMk9B9');
    if (!composer || !toolbar || !box) return false;
    if (toolbar.closest('.comment-input-inner-container') !== composer) return false;
    if (box.closest('.commentInput-right-ct') !== toolbar) return false;
    if (box.lastElementChild !== element) return false;
    if (box.querySelectorAll('span.wchsYBpK').length !== 1) return false;
    if (box.querySelectorAll('input[type="file"]').length !== 1) return false;
    if (composer.querySelectorAll('[contenteditable="true"],textarea').length !== 1) return false;
    if (!element.classList.contains('jfGCpJo0')) return false;
    const publicInners = [...document.querySelectorAll('.comment-input-inner-container')].filter(node => visible(node) && !node.closest(privateArea));
    if (publicInners.length !== 1 || publicInners[0] !== composer) return false;
    const svgs = element.querySelectorAll('svg'); if (svgs.length !== 1 || svgs[0].getAttribute('viewBox')?.trim().replace(/\s+/g, ' ') !== input.icon.viewBox) return false;
    const paths = [...svgs[0].querySelectorAll('path')], compact = value => String(value || '').replace(/[\s,]+/g, '');
    return paths.length === input.icon.paths.length && paths.every((path, index) => compact(path.getAttribute('d')) === compact(input.icon.paths[index].d) && path.getAttribute('fill')?.trim().toLowerCase() === input.icon.paths[index].fill);
  };
  entry.readPoint = (heldPoint = null) => {
    const marked = [...document.querySelectorAll('[data-deepseek-comment-pointer]')].filter(node => node.getAttribute('data-deepseek-comment-pointer') === input.token);
    const currentScopes = [...document.querySelectorAll('[data-deepseek-comment-pointer-scope]')].filter(node => node.getAttribute('data-deepseek-comment-pointer-scope') === input.token);
    // 命中与身份守卫：由原 12 项 OR 链按原顺序展开为逐关守卫，短路顺序与判定结果不变。
    if (marked.length !== 1 || marked[0] !== element) return null;
    if (currentScopes.length !== 1 || currentScopes[0] !== scope) return null;
    if (!scope.isConnected || !scope.contains(element)) return null;
    if (scope.closest(privateArea) || scope.querySelector(privateArea)) return null;
    if (!ownerMatches()) return null;
    if (!element.isConnected || element.closest(privateArea)) return null;
    if (!visible(element)) return null;
    if (element.closest('[disabled],[aria-disabled="true"],[data-disabled="true"],.disabled')) return null;
    if (!iconMatches()) return null;
    if (!videoMatches()) return null;
    const editors = editorsInScope();
    if (input.mode === 'lazy' ? editors.length > 1 : editors.length !== 1 || editors[0] !== draftElement) return null;
    if ([...scope.querySelectorAll('[data-e2e="comment-reply-target"],.PPsJmqBy')].some(visible) || /^回复\s*[@＠]/.test(draftElement?.getAttribute('aria-label') || '') || [...scope.querySelectorAll('input[type="file"]')].some(file => file.files?.length || file.value)) return null;
    if ([...document.querySelectorAll('[data-e2e="im-dialog"],#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"]')].some(visible)) return null;
    if ([...document.querySelectorAll('body *')].some(node => !node.childElementCount && visible(node) && !node.closest(privateArea) && /扫码登录|验证码登录|登录后即可|手机扫码登录|请完成下方验证|请完成验证|安全验证|拖动滑块/.test(node.textContent || ''))) return null;
    const self = readSelf(); if (!self.ready || self.ownProfileId !== input.ownProfileId) return null;
    if (draftElement && (!draftElement.isConnected || clean(draftElement instanceof HTMLInputElement || draftElement instanceof HTMLTextAreaElement ? draftElement.value : draftElement.innerText) !== input.expectedDraft || draftElement.querySelector('img,video,audio,a,[data-slate-void="true"]'))) return null;
    const r = element.getBoundingClientRect(), rawX = input.mode === 'submit' ? r.x + r.width / 2 : r.x + Math.min(16, r.width / 2), rawY = r.y + r.height / 2;
    const x = heldPoint && input.mode !== 'submit' ? heldPoint.clickX : Math.round(rawX), y = heldPoint && input.mode !== 'submit' ? heldPoint.clickY : Math.round(rawY);
    if (r.width < 2 || r.height < 2 || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < r.left || y < r.top || x >= r.right || y >= r.bottom || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit !== element && !element.contains(hit) || hit.closest(privateArea) || input.mode !== 'submit' && hit.closest('button,a,input,[role="button"]')) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height, clickX: x, clickY: y };
  };
  const types = ['pointerdown', 'mousedown', 'mouseup', 'click'];
  // 门禁窗口经 input 传参（页内抓不到模块作用域）；缺省时退回原来的 1500ms，不静默放宽。
  const gateMs = Number.isFinite(input.eventGateMs) ? input.eventGateMs : 1500;
  const witness = event => {
    if (!entry.armed || !event.isTrusted) return;
    const held = input.mode !== 'submit' && entry.pointerStarted === true;
    const target = event.target instanceof Element ? event.target : null, point = entry.readPoint(held ? entry.point : null);
    const same = point && entry.point && (held || ['x', 'y', 'width', 'height'].every(key => Math.abs(point[key] - entry.point[key]) <= 0.5));
    if (entry.blocked || Date.now() - entry.armedAt > gateMs || !target || target !== element && !element.contains(target) || !same || Math.abs(event.clientX - point.clickX) > 0.5 || Math.abs(event.clientY - point.clickY) > 0.5) { entry.blocked = true; event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (event.type === 'pointerdown') entry.pointerStarted = true;
    if (event.type === 'click') { entry.dispatched = true; entry.armed = false; }
  };
  const eventRoot = input.mode === 'submit' ? document : window;
  for (const type of types) eventRoot.addEventListener(type, witness, { capture: true, passive: false });
  entry.cleanup = () => { for (const type of types) eventRoot.removeEventListener(type, witness, true); if (element.getAttribute('data-deepseek-comment-pointer') === input.token) element.removeAttribute('data-deepseek-comment-pointer'); if (scope.getAttribute('data-deepseek-comment-pointer-scope') === input.token) scope.removeAttribute('data-deepseek-comment-pointer-scope'); };
  entries[input.token] = entry;
  element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  return true;
}

// 注入单一定义：可见性 / 私有区来自 comment/scope.mjs，身份判定用其唯一实现的源码。
// 导出是给真机验证脚本用的：它需要把同一个页内函数拿到真实页面里安装一次，
// 证明新增的 eventGateMs 载荷不会让安装路径退化（R4）。
export const installGeometryWitness = new Function('element', 'input', `${scopeSource({ area: 'pointer' })}const readSelf=(${readCommentSelfIdentity.toString()});return (${installInputWitness.toString()})(element,input,{visible,privateArea,readSelf});`);

// ---- 评论指针 / 发布见证的页内动作（R2 从 prepareCommentPointer 与 post 抽出）----
// 判定条件、调用顺序、错误文案与抽取前逐字一致；只是把几百字符的单行拆成可读单元。

// 页内清理：摘掉本次 token 的注册表条目与标记属性。清理失败不抛，避免掩盖原始错误。
function cleanupCommentPointer(token) {
  const entry = window.__deepseekCommentGeometryInputs?.[token];
  entry?.cleanup();
  if (window.__deepseekCommentGeometryInputs) delete window.__deepseekCommentGeometryInputs[token];
  for (const node of document.querySelectorAll('[data-deepseek-comment-pointer],[data-deepseek-comment-pointer-scope]')) {
    for (const attribute of ['data-deepseek-comment-pointer', 'data-deepseek-comment-pointer-scope']) {
      if (node.getAttribute(attribute) === token) node.removeAttribute(attribute);
    }
  }
}

async function releaseCommentPointer(page, token) {
  await page.evaluate(cleanupCommentPointer, token).catch(() => {});
}

function markCommentPointerScope(scope, token) {
  scope.setAttribute('data-deepseek-comment-pointer-scope', token);
}

async function readCommentPointerPoint(page, token) {
  return page.evaluate(witnessId => window.__deepseekCommentGeometryInputs?.[witnessId]?.readPoint() || null, token);
}

// 布防：最终点击前一刻重读一次点，并记录 armedAt（页内 1500ms 事件门禁要用）。
async function armCommentPointer(page, token, point) {
  return page.evaluate(({ witnessId, stablePoint }) => {
    const entry = window.__deepseekCommentGeometryInputs?.[witnessId];
    if (!entry || !entry.readPoint()) return false;
    entry.point = stablePoint; entry.armed = true; entry.armedAt = Date.now();
    return true;
  }, { witnessId: token, stablePoint: point });
}

async function readCommentPointerReceipt(page, token) {
  return page.evaluate(witnessId => {
    const entry = window.__deepseekCommentGeometryInputs?.[witnessId];
    return { dispatched: entry?.dispatched === true, blocked: entry?.blocked === true };
  }, token);
}

// 连续采样到几何与命中都稳定才算通过。默认 3 次一致、75ms 间隔、3s 上限（见 comment/timing.mjs）。
export async function awaitStableCommentPoint(readPoint, { check, signal, timeoutMs = COMMENT_TIMING.stableTimeoutMs, sampleMs = COMMENT_TIMING.stableSampleMs, requiredSamples = COMMENT_TIMING.stableSamples }) {
  let previous, stableSamples = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    stop(signal); await check();
    const point = await readPoint();
    stableSamples = sameCommentPoint(point, previous) ? stableSamples + 1 : point ? 1 : 0;
    previous = point;
    if (stableSamples >= requiredSamples) return point;
    await waitForCommentTick(sampleMs, undefined, { signal });
  }
  return null;
}

// 页内清理发布见证：删注册表条目，摘掉发布控件上的两枚标记属性。
function cleanupSubmitWitness(token) {
  const entry = window.__deepseekCommentInputs?.[token];
  entry?.cleanup();
  if (window.__deepseekCommentInputs) delete window.__deepseekCommentInputs[token];
  for (const element of document.querySelectorAll('[data-deepseek-comment-control]')) {
    if (element.getAttribute('data-deepseek-comment-control') !== token) continue;
    element.removeAttribute('data-deepseek-comment-control');
    if (element.getAttribute('data-deepseek-comment-native-publish') === token) element.removeAttribute('data-deepseek-comment-native-publish');
  }
}

async function releaseSubmitWitness(page, witnessId) {
  await page.evaluate(cleanupSubmitWitness, witnessId).catch(() => {});
}

async function prepareCommentPointer(page, locator, { check, signal, expectedVideoId, mode, expectedDraft, nativeIcon = false, scope: scopeLocator = locator }) {
  stop(signal); await check();
  if (await locator.count() !== 1) throw new Error('评论输入目标不唯一，未输入。');
  const currentSelf = await page.evaluate(readCommentSelfIdentity);
  if (!currentSelf.ready) throw new Error('评论输入前无法确认登录本人，未输入。');
  const token = `comment-pointer-${randomUUID()}`;
  let closed = false, attempted = false;
  const close = async () => { if (closed) return; closed = true; await releaseCommentPointer(page, token); };
  try {
    if (await scopeLocator.count() !== 1 || !await composerScopeValid(scopeLocator, expectedVideoId)) throw new Error('评论输入区域归属已经变化，未输入。');
    await scopeLocator.evaluate(markCommentPointerScope, token);
    const installed = await locator.evaluate(installGeometryWitness, { token, mode, expectedVideoId, expectedDraft, ownProfileId: currentSelf.ownProfileId, icon: nativeIcon ? NATIVE_PUBLISH_ICON : null, eventGateMs: COMMENT_TIMING.eventGateMs });
    if (!installed) throw new Error('评论输入几何见证未安装，未输入。');
    const stablePoint = await awaitStableCommentPoint(() => readCommentPointerPoint(page, token), { check, signal });
    if (!stablePoint) throw Object.assign(new Error('评论输入目标没有通过连续几何和命中核对，未点击。'), { needsUserAction: true });
    return { close, async click() {
      if (closed || attempted) throw new Error('本次评论输入已结束或已经尝试，未重复点击。');
      stop(signal); await check();
      if (!sameCommentPoint(await readCommentPointerPoint(page, token), stablePoint)) throw new Error('最终评论输入前几何、身份、草稿或遮挡已变化，未点击。');
      if (!await armCommentPointer(page, token, stablePoint)) throw new Error('评论输入事件门禁未就绪，未点击。');
      stop(signal); attempted = true; await page.mouse.click(stablePoint.clickX, stablePoint.clickY);
      const receipt = await readCommentPointerReceipt(page, token);
      if (!receipt.dispatched || receipt.blocked) throw new Error('评论输入没有可信事件见证或被最终门禁拦截，未重复点击。');
    } };
  } catch (error) { await close(); throw error; }
}


async function activateCommentEditor(page, expectedVideoId, check, signal) {
  let editors = page.locator(EDITORS).filter({ visible: true });
  if (await editors.count()) return editors;
  const lazy = page.locator('.comment-input-inner-container:not([data-e2e="im-dialog"] *):not([data-e2e="danmaku-container"] *)').filter({ visible: true });
  if (await lazy.count() !== 1 || !await composerScopeValid(lazy, expectedVideoId)) return editors;
  const canActivate = await lazy.evaluate(element => {
    if (element.querySelector('[data-e2e="comment-reply-target"],.PPsJmqBy,img,video,audio,a,button,[role="button"]')) return false;
    for (const input of element.querySelectorAll('input,textarea,[contenteditable]')) {
      if ((input.value ?? input.innerText ?? input.textContent ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').trim()) return false;
    }
    const text = (element.innerText || '').trim();
    const placeholder = element.getAttribute('data-placeholder') || element.getAttribute('aria-placeholder') || '';
    const currentPlaceholder = element.querySelector('span.RXtfhfhu');
    const knownEmpty = currentPlaceholder?.textContent.trim() === '留下你的精彩评论吧' && text === '留下你的精彩评论吧' && element.matches('.comment-input-inner-container') && element.querySelectorAll('span.RXtfhfhu').length === 1 && currentPlaceholder.closest('.comment-input-inner-container') === element;
    return !text || Boolean(placeholder && text === placeholder.trim()) || knownEmpty;
  });
  if (!canActivate) return editors;
  await check();
  const bounds = await lazy.boundingBox();
  if (!bounds || bounds.width < 8 || bounds.height < 8) return editors;
  // 只激活已核对的空评论输入区域，不点击发布或使用回车提交。
  const activation = await prepareCommentPointer(page, lazy, { check, signal, expectedVideoId, mode: 'lazy' });
  try { await activation.click(); } finally { await activation.close(); }
  await waitCommentState(() => page.evaluate(() => [...document.querySelectorAll('.comment-input-inner-container [contenteditable="true"],.comment-input-inner-container textarea')].some(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !element.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"],[data-e2e="comment-item"],[data-e2e="danmaku-container"]'); })), check, signal, COMMENT_TIMING.activationTimeoutMs);
  await check();
  editors = page.locator(EDITORS).filter({ visible: true });
  return editors;
}

// 发布控件判定的页内核心（第 5 份内联 visible 已在此合并）。
// 原先 nativeIcon() 里自己写了一遍几何链 + 私有区列表，与
// visiblePaintOnly、PRIVATE_AREA.pointer 逐条件相同（含"不查 opacity"这一既有语义）。
// 现在改为由 scopeSource({ area:'pointer', paint:true }) 注入，语义不变；
// tests/comment-submit-scope.test.mjs 用原内联实现做 oracle，在同一批假元素树上逐项比对。
function commentSubmitIndicesCore(elements, icon, visible, privateArea) {
  const nativeIcon = element => {
    if (!element.matches('span.wchsYBpK') || element.textContent.trim()) return false;
    const toolbar = element.closest('.commentInput-right-ct'), box = element.closest('.oWdMk9B9'), composer = element.closest('.comment-input-inner-container');
    if (!toolbar || !box || !composer) return false;
    if (toolbar.closest('.comment-input-inner-container') !== composer) return false;
    if (box.closest('.commentInput-right-ct') !== toolbar) return false;
    if (box.lastElementChild !== element) return false;
    if (box.querySelectorAll('span.wchsYBpK').length !== 1) return false;
    if (box.querySelectorAll('input[type="file"]').length !== 1) return false;
    if (composer.querySelectorAll('[contenteditable="true"],textarea').length !== 1) return false;
    const publicInners = [...document.querySelectorAll('.comment-input-inner-container')].filter(node => visible(node) && !node.closest(privateArea));
    if (publicInners.length !== 1 || publicInners[0] !== composer) return false;
    const svgs = element.querySelectorAll('svg');
    if (svgs.length !== 1 || svgs[0].getAttribute('viewBox')?.trim().replace(/\s+/g, ' ') !== icon.viewBox) return false;
    const paths = [...svgs[0].querySelectorAll('path')], compact = value => (value || '').replace(/[\s,]+/g, '');
    return paths.length === icon.paths.length && paths.every((node, index) => compact(node.getAttribute('d')) === compact(icon.paths[index].d) && node.getAttribute('fill')?.trim().toLowerCase() === icon.paths[index].fill);
  };
  const official = element => nativeIcon(element) || element.matches('[data-e2e="comment-post"],[data-e2e="comment-submit"],[data-e2e="comment-publish"],button,[role="button"],[aria-label="发布"],[aria-label="发送"],[aria-label="发表评论"],[aria-label="发布评论"],[title="发布"],[title="发表评论"],[title="发布评论"]');
  const eligible = elements.filter(element => {
    if (element.closest('[data-e2e="im-dialog"],[data-e2e="danmaku-container"],[data-e2e="comment-item"],[data-e2e="comment-list"],[contenteditable="true"]') || element.querySelector('[contenteditable],textarea,input')) return false;
    return official(element) || /^(?:发布|发送|发表评论|发布评论)$/.test((element.innerText || element.textContent || '').trim()) && (getComputedStyle(element).cursor === 'pointer' || element.tabIndex >= 0 || typeof element.onclick === 'function' || /(?:comment[-_].*(?:post|submit|publish|send)|(?:post|submit|publish|send)[-_].*comment)/i.test(element.className || ''));
  });
  // 嵌套的文字和按钮是同一控件；两个并列发布控件仍视为歧义。
  const independent = eligible.filter(element => official(element) || !eligible.some(other => other !== element && official(other) && other.contains(element)));
  const selected = independent.filter(element => !independent.some(other => other !== element && element.contains(other) && (official(other) || !official(element))));
  return selected.map(element => ({ index: elements.indexOf(element), nativeIcon: nativeIcon(element) }));
}

// 导出是给 oracle 测试用的：测试要在 vm 里用同一份组合器跑假元素树。
export const commentSubmitIndices = new Function('elements', 'icon', `${scopeSource({ area: 'pointer', paint: true })}return (${commentSubmitIndicesCore.toString()})(elements, icon, visible, privateArea);`);

async function findCommentSubmit(editor, expectedVideoId) {
  let root = editor.locator('xpath=ancestor-or-self::*[contains(concat(" ",normalize-space(@class)," ")," comment-input-container ") or contains(concat(" ",normalize-space(@class)," ")," comment-input-inner-container ") or @data-e2e="comment-input"][1]');
  let lastRoot = root;
  for (let level = 0; level < 5 && await root.count() === 1; level++) {
    if (!await composerScopeValid(root, expectedVideoId)) return { invalid: true };
    const bounded = await root.evaluate(element => !element.matches('body,html') && !element.querySelector('[data-e2e="comment-item"],[data-e2e="comment-list"],[data-e2e="im-dialog"],[data-e2e="danmaku-container"]') && element.querySelectorAll('[contenteditable="true"],textarea').length + Number(element.matches('[contenteditable="true"],textarea')) === 1);
    if (!bounded) break;
    lastRoot = root;
    const controls = root.locator(BUTTONS).filter({ hasText: PUBLISH_LABEL }).or(root.locator(LABELLED_BUTTONS)).or(root.locator(NATIVE_PUBLISH)).filter({ visible: true });
    const indices = await controls.evaluateAll(commentSubmitIndices, NATIVE_PUBLISH_ICON);
    if (indices.length > 1) return { ambiguous: true, root };
    if (indices.length === 1) return { root, send: controls.nth(indices[0].index), nativeIcon: indices[0].nativeIcon };
    root = root.locator('xpath=..');
  }
  return { missing: true, root: lastRoot };
}

export async function inspectCommentComposer(page, expectedVideoId) {
  const editors = page.locator(EDITORS).filter({ visible: true }), editorCount = await editors.count();
  if (editorCount !== 1) return { editorCount, inputReady: false, submitFound: false, needsUserAction: true };
  const selected = await findCommentSubmit(editors, expectedVideoId);
  if (!selected.send) return { editorCount, inputReady: !selected.invalid, submitFound: false, ambiguous: Boolean(selected.ambiguous), needsUserAction: true };
  const enabled = await selected.send.evaluate((element, nativeIcon) => !element.closest(':disabled,[aria-disabled="true"],[data-disabled="true"],.disabled') && (!nativeIcon || element.classList.contains('jfGCpJo0')), selected.nativeIcon);
  return { editorCount, inputReady: true, submitFound: true, nativeIcon: Boolean(selected.nativeIcon), enabled };
}

// 只读自检入口（F2）：给 diagnostics 用，判断"评论控件今天还认不认得"。
// 三条硬约束：
//   1. 不启动浏览器（launch:false）、不新建标签（create:false）——没有可用浏览器就跳过；
//   2. 不导航、不打开视频：只用当前已打开的作品页，避免自检把用户正在看的内容换掉；
//   3. 不输入、不点击、不按任何键：本函数只数元素、读属性（见 tests/diagnostics-comment.test.mjs S 系列守卫）。
// 页面不可用一律转成 targetOpen:false + reasonCode，让诊断报告给出人话，而不是 UNKNOWN 失败项。
export async function inspectCommentComposerForDiagnostics(controller, { signal } = {}) {
  if (!controller || typeof controller.withPage !== 'function') return { targetOpen: false, reasonCode: 'browser-unavailable' };
  try {
    return await controller.withPage(async page => {
      let videoId = null;
      try {
        const url = new URL(page.url());
        const fromPath = /^\/video\/(\d{1,64})\/?$/.exec(url.pathname)?.[1];
        const fromQuery = url.searchParams.get('modal_id') || url.searchParams.get('aweme_id');
        videoId = fromPath || (/^\d{1,64}$/.test(fromQuery || '') ? fromQuery : null);
      } catch { return { targetOpen: false, reasonCode: 'not-video-page' }; }
      if (!videoId) return { targetOpen: false, reasonCode: 'not-video-page' };
      return { targetOpen: true, videoId, ...(await inspectCommentComposer(page, videoId)) };
    }, { signal, launch: false, create: false });
  } catch (error) {
    return { targetOpen: false, reasonCode: error?.code === 'BROWSER_NOT_RUNNING' ? 'browser-not-running' : 'browser-unavailable' };
  }
}

// 只读公开评论的编号、正文和自身发出状态；不采集其他评论者的账号、昵称或头像。
function readCommentDomCore(input, visible, privateArea, budget) {
  const expectedVideoId = typeof input === 'string' ? input : input?.expectedVideoId;
  const trustedOwnProfileId = typeof input === 'object' && input !== null ? input.ownProfileId : null;
  if (typeof input !== 'string' && (!input || Object.keys(input).some(key => !['expectedVideoId', 'ownProfileId'].includes(key)) || typeof trustedOwnProfileId !== 'string' || !/^[A-Za-z0-9_-]{5,300}$/.test(trustedOwnProfileId))) return { rows: [] };
  const profileId = anchor => {
    try { const url = new URL(anchor.getAttribute('href'), 'https://www.douyin.com/'); return url.origin === 'https://www.douyin.com' && !url.username && !url.password ? /^\/user\/([A-Za-z0-9_-]{5,300})\/?$/.exec(url.pathname)?.[1] || null : null; } catch { return null; }
  };
  const ownNavigation = [...document.querySelectorAll('.tab-user_self a[href]')].filter(anchor => visible(anchor) && !anchor.closest(`${privateArea},[data-e2e="comment-item"]`) && anchor.textContent.trim() === '我的');
  const navigationProfile = ownNavigation.length === 1 ? profileId(ownNavigation[0]) : null;
  if (trustedOwnProfileId && (ownNavigation.length !== 1 || navigationProfile && navigationProfile !== trustedOwnProfileId)) return { rows: [] };
  const ownProfile = trustedOwnProfileId || navigationProfile;
  const pageVideoIds = new Set();
  try { const url = new URL(location.href), id = /^\/video\/(\d+)\/?$/.exec(url.pathname)?.[1] || url.searchParams.get('modal_id') || url.searchParams.get('aweme_id'); if (/^\d{1,64}$/.test(id || '')) pageVideoIds.add(id); } catch {}
  for (const player of document.querySelectorAll('[data-e2e="player-container"]')) {
    if (!visible(player) || player.closest(privateArea) || ![...player.querySelectorAll('video')].some(visible)) continue;
    const id = /(?:^|\s)video_(\d+)(?:\s|$)/.exec(player.className || '')?.[1]; if (id) pageVideoIds.add(id);
  }
  if (pageVideoIds.size && (pageVideoIds.size !== 1 || !pageVideoIds.has(expectedVideoId))) return { rows: [] };
  const readOwnedCommentText = (content, row) => {
    let visited = 0, images = 0, length = 0;
    const inlineTags = new Set(['SPAN','DIV','P','B','I','EM','STRONG','A','BR','IMG']);
    const append = value => { length += value.length; return length <= budget.textLength ? value : null; };
    const walk = node => {
      if (++visited > budget.nodes) return null;
      if (node.nodeType === 3) return append(node.nodeValue || '');
      if (node.nodeType !== 1 || node.closest(privateArea) || node.closest('[data-e2e="comment-item"]') !== row || !inlineTags.has(node.tagName)) return null;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return '';
      if (node.tagName === 'BR') return append('\n');
      if (node.tagName === 'IMG') {
        if (++images > budget.images || node.childNodes.length || node.closest('a[href]')) return null;
        const alt = node.getAttribute('alt'), source = node.getAttribute('src');
        if (typeof alt !== 'string' || !alt || alt.length > budget.altLength || /[\x00-\x1f\x7f]/.test(alt) || !/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(alt) && !/^\[[^\[\]\r\n]{1,20}\]$/.test(alt) || typeof source !== 'string' || !source) return null;
        try { const url = new URL(source, location.origin); if (url.protocol !== 'https:' || url.username || url.password) return null; } catch { return null; }
        return append(alt);
      }
      let value = '';
      for (const child of node.childNodes) { const part = walk(child); if (part === null) return null; value += part; }
      return value;
    };
    const value = walk(content);
    return value === null ? null : value.trim();
  };

  const result = [];
  for (const row of document.querySelectorAll('[data-e2e="comment-item"]')) {
    if (!visible(row) || row.closest(privateArea) || row.parentElement?.closest('[data-e2e="comment-item"]')) continue;
    const owned = selector => [...row.querySelectorAll(selector)].filter(element => element.closest('[data-e2e="comment-item"]') === row);
    const ancestorVideoId = row.closest('[data-aweme-id],[data-video-id]')?.getAttribute('data-aweme-id') || row.closest('[data-video-id]')?.getAttribute('data-video-id');
    if (ancestorVideoId && ancestorVideoId !== expectedVideoId) continue;
    const videoBound = ancestorVideoId === expectedVideoId || pageVideoIds.size === 1 && pageVideoIds.has(expectedVideoId);
    const ids = [row.getAttribute('data-comment-id'), /^comment_(\d+)$/.exec(row.id)?.[1], ...owned('[id^="tooltip_"]').map(element => /^tooltip_(\d+)$/.exec(element.id)?.[1])].filter(Boolean);
    const rawId = new Set(ids).size === 1 ? ids[0] : null;
    const content = owned('[data-e2e="comment-content"],.comment-item-content,.FduGc_lz > .Sh1Da424');
    const textNode = content.length === 1 ? content[0] : null;
    const reconstructed = textNode ? readOwnedCommentText(textNode, row) : null;
    const text = reconstructed === null ? '' : reconstructed;
    const authors = owned('.comment-item-avatar a[href]').filter(anchor => visible(anchor) && !anchor.closest('[data-e2e="comment-content"],.comment-item-content,.FduGc_lz > .Sh1Da424'));
    const authorProfile = authors.length === 1 ? profileId(authors[0]) : null;
    const selfMarker = row.getAttribute('data-is-self') === 'true' || row.getAttribute('data-author-is-self') === 'true' || owned('[data-e2e="comment-self"]').length === 1;
    const mine = videoBound && (!trustedOwnProfileId || !authorProfile || authorProfile === trustedOwnProfileId) && (selfMarker || Boolean(ownProfile && authorProfile && ownProfile === authorProfile));
    const status = row.getAttribute('data-send-status') || row.getAttribute('data-comment-status') || '';
    const labels = owned('[data-e2e="comment-status"],.comment-item-tag-text').map(element => element.textContent.trim());
    const pending = /^(?:sending|pending|reviewing)$/.test(status) || owned('[data-e2e="comment-pending"],[aria-busy="true"],[class*="sending" i]').length > 0 || labels.some(value => /^(?:待审核|审核中|评论审核中|发送中|发布中)$/.test(value));
    const failed = /^(?:failed|rejected|error)$/.test(status) || owned('[data-e2e="comment-failed"],[class*="sendFail"]').length > 0 || labels.some(value => /^(?:审核未通过|发布失败|评论未发布|发送失败)$/.test(value));
    const sent = /^(?:sent|published|success)$/.test(status) || mine && /^\d{1,64}$/.test(rawId || '') && !pending && !failed;
    result.push({ commentId: /^\d{1,64}$/.test(rawId || '') ? rawId : null, videoId: ancestorVideoId || expectedVideoId, text, mine, sent, pending, failed });
  }
  return { rows: result };
}

// 仍以 readCommentDom 名义导出，page.evaluate 用法不变；
// 绘制期可见性沿用原实现（visiblePaintOnly，不查 opacity），本次不收紧该行为。
// 扫描预算来自 comment/timing.mjs，在 Node 侧插值进模板（页内抓不到模块作用域）。
export const readCommentDom = new Function('input', `${scopeSource({ area: 'publicRows', paint: true })}const budget=${JSON.stringify(COMMENT_SCAN_BUDGET)};return (${readCommentDomCore.toString()})(input,visible,privateArea,budget);`);

function assertVideo(state, expectedVideoId) {
  if (state?.loginRequired || state?.verificationRequired || state?.unsupportedPage || state?.privateChatVisible || state?.blocked || state?.video?.id !== expectedVideoId || state.video.readyState < 2) throw new Error('当前作品、登录状态或页面遮挡无法核对，未发布评论。');
  const url = state.video.url || state.url;
  if (url) { let current; try { current = new URL(url); } catch {} if (!current || current.origin !== 'https://www.douyin.com' || /^\/video\/(\d+)\/?$/.exec(current.pathname)?.[1] !== expectedVideoId) throw new Error('当前作品链接与预期不一致，未发布评论。'); }
}

export class CommentBrowser {
  constructor({ source = 'api', controller, videoLimits, stateDir = resolveRuntimePaths().stateDir } = {}) {
    if (!['api', 'dsh'].includes(source)) throw new TypeError('评论入口只能是 api 或 dsh。');
    this.source = source; this.stateDir = stateDir;
    this.videoLimits = videoLimits ?? new VideoLimits({ stateDir });
    // 默认创建独立的同入口控制器，不能复用正在等待评论结果的父控制器队列。
    this.controller = controller ?? new BrowserController({ source, videoLimits: this.videoLimits }); this.ownsController = !controller;
    this.receiptsFile = path.join(stateDir, 'comment-browser-receipts.json'); this.guardFile = path.join(stateDir, 'comment-post.guard');
  }
  receipts() { try { const value = JSON.parse(fs.readFileSync(this.receiptsFile, 'utf8')); if (!value || value.version !== 1 || !Array.isArray(value.operations) || value.operations.some(item => !item || typeof item.operationId !== 'string' || !/^\d{1,64}$/.test(item.videoId) || !['clicking', 'confirmed', 'uncertain'].includes(item.status) || item.baseline && !checkReceiptBaseline(item, 'public-comment').available)) throw Error(); return value; } catch (error) { if (error.code === 'ENOENT') return { version: 1, operations: [] }; throw new Error('原评论发布收据无法核对，未自动重发。'); } }
  // 落盘前裁剪：writeDurableReceiptFile 在 >4MB 时直接抛错，不裁剪等于让评论功能在
  // 累积到一定条数后永久失败。未结案收据（clicking/uncertain）永不删除，见 comment/receipts.mjs。
  record(operation) { const value = this.receipts(), index = value.operations.findIndex(item => item.operationId === operation.operationId), stored = preserveReceiptBaseline(index < 0 ? null : value.operations[index], operation, 'public-comment'); if (index < 0) value.operations.push(stored); else value.operations[index] = stored; write(this.receiptsFile, trimCommentReceipts(value, { confirmedItems: COMMENT_RECEIPT_LIMIT.confirmedItems, budgetBytes: COMMENT_RECEIPT_LIMIT.budgetBytes })); }
  // 发布锁：崩溃后能否接管不看 pid，看收据——收据在点击之前写入，
  // 「有未终止收据」就等于「可能已经点过」，此时接管等于允许再发一条（判定见 comment/lock-policy.mjs）。
  acquire(operation) {
    const pending = () => { try { return this.receipts().operations; } catch { return null; } };
    const decide = state => commentPostLockDecision(state, pending());
    const lock = acquireStateLock(this.guardFile, {
      owner: { operationId: operation.operationId, videoId: operation.videoId },
      stale: state => decide(state).reclaim ? 'reclaim' : 'block',
      busyMessage: state => decide(state).reason,
      // 活进程在发只需稍后重试；锁损坏、或上次结果不明，才需要人工核对。
      onBusy: (message, state) => Object.assign(new Error(message), state.validOwner && state.alive ? {} : { needsUserAction: true }),
    });
    return lock.release;
  }
  async gate(signal) { stop(signal); const state = this.videoLimits.state(); if (!state.allowed) throw new Error(state.reason || '有限观看时段已结束，未发布评论。'); }
  async post({ expectedVideoId, text, ...extra } = {}, { signal: parentSignal, authorize, autonomousRunId } = {}) {
    if (typeof expectedVideoId !== 'string' || !/^\d{1,64}$/.test(expectedVideoId) || Object.keys(extra).length) throw new TypeError('评论只能指定当前作品编号与纯文字。');
    text = validateCommentText(text);
    if (typeof authorize !== 'function' || typeof authorize.beginDispatch !== 'function') return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '评论缺少可信本机许可与最终短输入控制，未发布。' };
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const authorized = async phase => { stop(signal); if (await authorize({ phase, videoId: expectedVideoId }) !== true) throw new Error('自主评论许可已撤回，未继续发布。'); stop(signal); };
    await authorized('prepare'); await this.gate(signal);
    const operation = { operationId: randomUUID(), videoId: expectedVideoId, startedAt: new Date().toISOString(), status: 'clicking' };
    const release = this.acquire(operation);
    let clicked = false, dispatched = false, receiptWritten = false;
    try {
      if (this.receipts().operations.some(item => item.videoId === expectedVideoId)) throw new Error('同一作品已有发布或待核对评论收据，未再次点击。');
      return await this.controller.withPage(async page => {
        let ownProfileId;
        const checkSelf = async () => {
          const current = await page.evaluate(readCommentSelfIdentity); stop(signal);
          if (!current.ready || ownProfileId !== undefined && current.ownProfileId !== ownProfileId) throw Object.assign(new Error('登录本人身份缺失、冲突或已变化，未继续发布或确认评论。'), { needsUserAction: true });
          ownProfileId ??= current.ownProfileId;
        };
        const checkPage = async () => { await authorized('monitor'); await this.gate(signal); assertVideo(await page.evaluate(readPageState), expectedVideoId); await checkSelf(); };
        await checkPage();
        const editors = await activateCommentEditor(page, expectedVideoId, checkPage, signal);
        if (await editors.count() !== 1) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '当前页面没有唯一可核对的评论输入框，需要先打开评论面板或等待适配。' };
        const editor = editors;
        const initial = await findCommentSubmit(editor, expectedVideoId);
        let root = initial.root, send = null;
        if (initial.invalid || !root || await root.count() !== 1) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '当前评论输入区域归属尚未支持，未发布。' };
        if (initial.ambiguous) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '当前评论区域存在多个发布控件，未填写或发布。' };
        const draft = () => editor.evaluate(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.innerText);
        const hasFile = () => root.locator('input[type="file"]').evaluateAll(inputs => inputs.some(input => input.files?.length || input.value));
        if (cleanDraft(await draft()) || await editor.locator('img,video,audio,a,[data-slate-void="true"]').count() || await hasFile()) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '评论输入框已有草稿或媒体内容，已保留原内容。' };
        if (await root.locator('[data-e2e="comment-reply-target"],.PPsJmqBy').filter({ visible: true }).count() || await editor.getAttribute('aria-label').then(value => /回复\s*[@＠]/.test(value || ''))) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '当前输入框处于回复他人的状态，未改发回复或@。' };
        const before = await page.evaluate(readCommentDom, { expectedVideoId, ownProfileId });
        operation.baseline = createCommentReceiptBaseline(operation, { rows: before.rows, ownProfileId, text });
        const knownIds = new Set(operation.baseline.knownIds);
        let monitoring = true, polling, prepared = false, releaseDispatch, submitPointer, ticks = 0;
        const witnessId = operation.operationId;
        const inputDispatched = () => page.evaluate(token => window.__deepseekCommentInputs?.[token]?.dispatched === true, witnessId);
        // full=true 才重跑 findCommentSubmit（单次约 5 个 CDP 往返）。
        // 定时器每 fullRecheckEvery 拍做一次全量重查，点击前的决策点显式传 full：
        // 判定条件一字未改，只是"多久查一次"变了（R4 降频）。
        const check = async ({ full = false } = {}) => {
          if (clicked && await inputDispatched()) return;
          await checkPage();
          if (await editors.count() !== 1 || !await composerScopeValid(root, expectedVideoId) || prepared && cleanDraft(await draft()) !== text || await hasFile() || await root.locator('[data-e2e="comment-reply-target"],.PPsJmqBy').filter({ visible: true }).count()) throw new Error('等待期间评论输入、发布目标或草稿发生变化，未发布。');
          if (send && (full || ++ticks % COMMENT_TIMING.fullRecheckEvery === 0)) {
            const latest = await findCommentSubmit(editor, expectedVideoId);
            if (await send.count() !== 1 || !latest.send || await latest.send.getAttribute('data-deepseek-comment-control') !== witnessId) throw new Error('等待期间评论发布控件发生变化或出现歧义，未发布。');
          }
          stop(signal);
        };
        const timer = setInterval(() => { if (!monitoring || polling) return; polling = check().catch(async error => { if (monitoring && !await inputDispatched().catch(() => false)) interrupt.abort(error); }).finally(() => { polling = null; }); }, COMMENT_TIMING.postPollMs);
        try {
          await check();
          const focus = await prepareCommentPointer(page, editor, { check, signal, expectedVideoId, mode: 'editor', expectedDraft: '', scope: root });
          try { await focus.click(); } finally { await focus.close(); }
          stop(signal);
          // 使用浏览器真实文字输入触发受控编辑器；填写与页面回读一致后才等待发布按钮。
          await editor.pressSequentially(text, { delay: COMMENT_TIMING.typeDelayMs }); stop(signal); prepared = true; await check({ full: true });
          const selected = await findCommentSubmit(editor, expectedVideoId);
          if (!selected.send) throw Object.assign(new Error(selected.ambiguous ? '当前评论区域存在多个发布控件，草稿已保留，未发布。' : '当前评论输入已激活，但没有唯一可核对的发布控件；草稿已保留，需要适配当前抖音页面。'), { needsUserAction: true });
          root = selected.root;
          await selected.send.evaluate((element, { token, nativeIcon }) => { element.setAttribute('data-deepseek-comment-control', token); if (nativeIcon) element.setAttribute('data-deepseek-comment-native-publish', token); }, { token: witnessId, nativeIcon: selected.nativeIcon });
          send = root.locator(`[data-deepseek-comment-control="${witnessId}"]`);
          await send.evaluate((button, token) => { const entries = window.__deepseekCommentInputs ??= Object.create(null), entry = { dispatched: false }; const witness = event => { if (event.isTrusted && (event.target === button || button.contains(event.target))) entry.dispatched = true; }; document.addEventListener('click', witness, true); entry.cleanup = () => document.removeEventListener('click', witness, true); entries[token] = entry; }, witnessId);
          await check({ full: true });
          const enabled = await waitCommentState(() => page.evaluate(token => { const element = [...document.querySelectorAll('[data-deepseek-comment-control]')].find(item => item.getAttribute('data-deepseek-comment-control') === token); return Boolean(element && !element.closest(':disabled,[aria-disabled="true"],[data-disabled="true"],.disabled') && (element.getAttribute('data-deepseek-comment-native-publish') !== token || element.classList.contains('jfGCpJo0'))); }, witnessId), check, signal, COMMENT_TIMING.enableTimeoutMs);
          if (!enabled) throw Object.assign(new Error('评论发布控件尚不可用，草稿已保留，未点击。'), { needsUserAction: true });
          submitPointer = await prepareCommentPointer(page, send, { check, signal, expectedVideoId, mode: 'submit', expectedDraft: text, nativeIcon: selected.nativeIcon, scope: root });
          stop(signal); await check({ full: true });
          if (await inputDispatched()) { dispatched = true; throw new Error('等待期间已发生发布输入，未再点击一次。'); }
          await authorized('before-click'); releaseDispatch = await authorize.beginDispatch(); if (typeof releaseDispatch !== 'function') throw new Error('最终评论输入未取得可释放的本机许可。');
          await checkSelf(); stop(signal); this.record(operation); receiptWritten = true; clicked = true;
          await submitPointer.click(); releaseDispatch?.(); releaseDispatch = null;
          dispatched = await inputDispatched(); if (!dispatched) throw new Error('没有核对到真实发布输入，评论结果需要核对。');
          monitoring = false; clearInterval(timer); let previousId;
          for (let attempt = 0; attempt < COMMENT_TIMING.readbackAttempts; attempt++) {
            stop(signal); assertVideo(await page.evaluate(readPageState), expectedVideoId);
            await checkSelf();
            const current = await page.evaluate(readCommentDom, { expectedVideoId, ownProfileId });
            await checkSelf();
            const matches = current.rows.filter(item => item.commentId && !knownIds.has(item.commentId) && item.videoId === expectedVideoId && item.text === text && item.mine && item.sent && !item.failed && !item.pending);
            if (matches.length > 1 || new Set(current.rows.map(item => item.commentId).filter(Boolean)).size !== current.rows.filter(item => item.commentId).length) break;
            if (matches.length === 1 && previousId === matches[0].commentId && !cleanDraft(await draft())) { const result = { confirmed: true, deliveryUncertain: false, operationId: operation.operationId, videoId: expectedVideoId, commentId: matches[0].commentId }; this.record({ ...operation, status: 'confirmed', completedAt: new Date().toISOString(), commentId: result.commentId }); return result; }
            previousId = matches.length === 1 ? matches[0].commentId : null;
            await page.waitForTimeout(COMMENT_TIMING.readbackMs);
          }
          this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() });
          return { confirmed: false, deliveryUncertain: true, operationId: operation.operationId, videoId: expectedVideoId, reason: '已尝试一次发布，但没有同作品的新本人评论编号与发出状态回读；请核对，未重试。' };
        } catch (error) { dispatched ||= await inputDispatched().catch(() => false); throw error; }
        finally { monitoring = false; clearInterval(timer); releaseDispatch?.(); await submitPointer?.close(); await releaseSubmitWitness(page, witnessId); }
      }, { signal, autonomousRunId });
    } catch (error) {
      if (clicked || dispatched) { try { this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() }); } catch { /* 保留原始发布收据，未自动重试。 */ } return { confirmed: false, deliveryUncertain: true, operationId: operation.operationId, videoId: expectedVideoId, reason: '发布输入后的结果不明，请人工核对，未再次点击。' }; }
      if (receiptWritten) this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() });
      return { confirmed: false, deliveryUncertain: false, operationId: operation.operationId, videoId: expectedVideoId, ...(error.needsUserAction ? { needsUserAction: true } : {}), reason: error.message || '评论发布前检查未通过，草稿已保留。' };
    } finally { release(); }
  }
  async close() { if (this.ownsController) await this.controller.close(); }
}
