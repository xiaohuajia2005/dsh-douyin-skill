// ============================================================
// 发布控件判定：第 5 份内联 visible 合并后的等价性 oracle（收尾项 1）
//
// 被测对象：commentSubmitIndices（由 commentSubmitIndicesCore + scopeSource 组合而成）
// 基准对象：重构前 controls.evaluateAll 里那段内联回调，整段抄在下面（OLD_CALLBACK）。
//
// 两段代码在同一个 vm 上下文、同一批假元素树上求值，逐项比对返回的
// [{index, nativeIcon}] —— 这比"读源码看有没有抄错"可靠，因为几何链、
// 私有区列表、嵌套去重三个地方都可能悄悄漂移。
//
// 关键语义锁定（测的就是"没有误用另一份 visible"）：
//   visiblePaintOnly 不查 opacity 祖先 —— 祖先 opacity:0 的评论输入区仍算可见；
//   若有人把它换成 visibleWithOpacity，S2 会立刻红。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { commentSubmitIndices } from '../comment-browser.mjs';
import { scopeSource } from '../comment/scope.mjs';

// 重构前（cf56140）的原样回调，仅用于 oracle；不要"顺手优化"它。
const OLD_CALLBACK = String.raw`(elements, icon) => {
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
        const publicInners = [...document.querySelectorAll('.comment-input-inner-container')].filter(node => { const r = node.getBoundingClientRect(), s = getComputedStyle(node); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden' && !node.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"],[data-e2e="comment-item"],[data-e2e="comment-list"],[data-e2e="danmaku-container"]'); });
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
      const independent = eligible.filter(element => official(element) || !eligible.some(other => other !== element && official(other) && other.contains(element)));
      const selected = independent.filter(element => !independent.some(other => other !== element && element.contains(other) && (official(other) || !official(element))));
      return selected.map(element => ({ index: elements.indexOf(element), nativeIcon: nativeIcon(element) }));
    }`;

// ---------- 极简假 DOM：够跑这段判定即可，不求通用 ----------
// 与 NATIVE_PUBLISH_ICON 保持一致：真实常量里的 fill 是小写十六进制，
// 而判定只对元素属性做 toLowerCase（右侧原样比较），夹具必须照这个不对称来写。
const ICON = { viewBox: '0 0 24 24', paths: [{ d: 'M1 1 L2 2', fill: '#fe2c55' }] };

const node = (spec = {}) => {
  const el = {
    tag: (spec.tag || 'div').toUpperCase(),
    classList: (spec.cls || '').split(/\s+/).filter(Boolean),
    attrs: { ...spec.attrs },
    text: spec.text || '',
    style: spec.style || {},
    children: [],
    parent: null,
    tabIndex: spec.tabIndex ?? 0,
    onclick: spec.onclick,
    get className() { return this.classList.join(' '); },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); },
    get innerText() { return this.textContent; },
    matches(selector) { return anyMatch(selector, this); },
    closest(selector) { for (let current = this; current; current = current.parent) if (anyMatch(selector, current)) return current; return null; },
    querySelectorAll(selector) { const found = []; walk(this, item => { if (item !== this && anyMatch(selector, item)) found.push(item); }); return found; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    contains(other) { for (let current = other; current; current = current.parent) if (current === this) return true; return false; },
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; },
    getBoundingClientRect() { return this.style.rect || { width: 10, height: 10, top: 1, left: 1, right: 11, bottom: 11 }; },
  };
  for (const child of spec.children || []) { child.parent = el; el.children.push(child); }
  return el;
};
const walk = (root, visit) => { for (const child of root.children) { visit(child); walk(child, visit); } };

// 支持 tag / .class / tag.class / [attr] / [attr="v"] 及其逗号组合。
const matchOne = (selector, el) => {
  const text = selector.trim();
  if (!text) return false;
  const parsed = /^([a-zA-Z0-9]*)((?:\.[\w-]+)*)((?:\[[^\]]*\])*)$/.exec(text);
  if (!parsed) return false;
  const [, tag, classes, attrs] = parsed;
  if (tag && el.tag !== tag.toUpperCase()) return false;
  for (const name of classes.split('.').filter(Boolean)) if (!el.classList.includes(name)) return false;
  let matched = 0;
  for (const [, name, , value] of attrs.matchAll(/\[([\w-]+)(?:=(["'])(.*?)\2)?\]/g)) {
    matched++;
    if (!Object.hasOwn(el.attrs, name)) return false;
    if (value !== undefined && el.attrs[name] !== value) return false;
  }
  return Boolean(tag || classes || matched);
};
const anyMatch = (selector, el) => String(selector).split(',').some(part => matchOne(part, el));

const context = roots => {
  const all = [];
  for (const root of roots) { all.push(root); walk(root, item => all.push(item)); }
  return vm.createContext({
    document: { querySelectorAll: selector => all.filter(item => anyMatch(selector, item)) },
    getComputedStyle: el => ({ display: el.style.display || 'block', visibility: el.style.visibility || 'visible', opacity: el.style.opacity ?? '1', cursor: el.style.cursor || 'auto' }),
    innerHeight: 800, innerWidth: 1200, Object, Math, Number, String, Set, Array, Boolean,
  });
};

const run = (fn, { elements, roots }) => {
  const sandbox = context(roots);
  const serialized = vm.runInContext(`(${fn.toString()})`, sandbox);
  return JSON.parse(JSON.stringify(serialized(elements, ICON)));
};

const compare = (label, scenario) => {
  const before = run(vm.runInNewContext(OLD_CALLBACK, vm.createContext({})), scenario);
  const after = run(commentSubmitIndices, scenario);
  assert.deepEqual(after, before, `${label}：新组合器与重构前内联实现的选中结果不一致`);
  return after;
};

// ---------- 场景构造 ----------
// 原生发布图标的完整结构：composer > toolbar > box(last child = span.wchsYBpK) + input[type=file]
const nativeComposer = ({ composerStyle = {}, wrap = children => children } = {}) => {
  const path = node({ tag: 'path', attrs: { d: 'M1 1L2 2', fill: '#FE2C55' } });
  const svg = node({ tag: 'svg', attrs: { viewBox: '0 0 24 24' }, children: [path] });
  const span = node({ tag: 'span', cls: 'wchsYBpK', children: [svg] });
  const file = node({ tag: 'input', attrs: { type: 'file' } });
  const box = node({ tag: 'div', cls: 'oWdMk9B9', children: [file, span] });
  const editable = node({ tag: 'div', attrs: { contenteditable: 'true' } });
  const toolbar = node({ tag: 'div', cls: 'commentInput-right-ct', children: [box] });
  const composer = node({ tag: 'div', cls: 'comment-input-inner-container', style: composerStyle, children: [editable, toolbar] });
  return { composer, span, roots: wrap([composer]) };
};

test('S1 原生图标结构正常 → 旧新一致，且选中唯一控件并标记 nativeIcon', () => {
  const { composer, span } = nativeComposer();
  const result = compare('S1', { elements: [span], roots: [composer] });
  assert.deepEqual(result, [{ index: 0, nativeIcon: true }]);
});

test('S2 祖先 opacity:0 不影响判定（证明用的是 paint 变体，不是可见性更严的那一份）', () => {
  const { composer, span } = nativeComposer({ wrap: children => [node({ tag: 'div', style: { opacity: '0' }, children })] });
  const result = compare('S2', { elements: [span], roots: [composer] });
  assert.deepEqual(result, [{ index: 0, nativeIcon: true }], '祖先透明度为 0 时评论输入区仍应按既有语义视为可见');
});

test('S3 评论输入区零尺寸 → 两个实现都不认', () => {
  const { composer, span } = nativeComposer({ composerStyle: { rect: { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 } } });
  assert.deepEqual(compare('S3', { elements: [span], roots: [composer] }), []);
});

test('S4 评论输入区在私信弹窗内 → 两个实现都不认', () => {
  const { composer, span } = nativeComposer({ wrap: children => [node({ tag: 'div', attrs: { 'data-e2e': 'im-dialog' }, children })] });
  assert.deepEqual(compare('S4', { elements: [span], roots: [composer] }), []);
});

test('S5 评论输入区在评论列表内 → 两个实现都不认（私有区用的是 pointer 那一份）', () => {
  const { composer, span } = nativeComposer({ wrap: children => [node({ tag: 'div', attrs: { 'data-e2e': 'comment-list' }, children })] });
  assert.deepEqual(compare('S5', { elements: [span], roots: [composer] }), []);
});

test('S6 页面上有两个可见评论输入区 → 两个实现都不认（不猜）', () => {
  const first = nativeComposer();
  const second = nativeComposer();
  assert.deepEqual(compare('S6', { elements: [first.span], roots: [first.composer, second.composer] }), []);
});

test('S7 display:none 的评论输入区 → 两个实现都不认', () => {
  const { composer, span } = nativeComposer({ composerStyle: { display: 'none' } });
  assert.deepEqual(compare('S7', { elements: [span], roots: [composer] }), []);
});

test('S8 普通发布按钮（非原生图标）→ 旧新一致，nativeIcon=false', () => {
  const composer = node({ tag: 'div', cls: 'comment-input-inner-container', children: [node({ tag: 'div', attrs: { contenteditable: 'true' } })] });
  const button = node({ tag: 'button', attrs: { 'data-e2e': 'comment-post' }, text: '发布' });
  composer.children.push(button); button.parent = composer;
  assert.deepEqual(compare('S8', { elements: [button], roots: [composer] }), [{ index: 0, nativeIcon: false }]);
});

test('S9 纯文字"发布"控件按光标/类名判定 → 旧新一致', () => {
  const label = node({ tag: 'div', text: '发布', style: { cursor: 'pointer' } });
  const wrapper = node({ tag: 'div', cls: 'comment-input-inner-container', children: [node({ tag: 'div', attrs: { contenteditable: 'true' } }), label] });
  assert.deepEqual(compare('S9', { elements: [label], roots: [wrapper] }), [{ index: 0, nativeIcon: false }]);
});

test('S10 嵌套文字与按钮视为同一控件（去重逻辑未被破坏）', () => {
  const inner = node({ tag: 'span', text: '发布' });
  const outer = node({ tag: 'button', attrs: { 'data-e2e': 'comment-post' }, children: [inner] });
  const composer = node({ tag: 'div', cls: 'comment-input-inner-container', children: [node({ tag: 'div', attrs: { contenteditable: 'true' } })] });
  composer.children.push(outer); outer.parent = composer;
  const result = compare('S10', { elements: [inner, outer], roots: [composer] });
  assert.deepEqual(result, [{ index: 1, nativeIcon: false }], '应只保留外层控件');
});

test('S11 模块源码里不再有第五份内联几何链', () => {
  const source = readFileSync(new URL('../comment-browser.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/r\.width > 0 && r\.height > 0 && r\.bottom > 0/g) || []).length, 0, 'comment-browser.mjs 仍残留内联可见性条件');
  const composed = commentSubmitIndices.toString();
  assert.equal((composed.match(/r\.width > 0 && r\.height > 0 && r\.bottom > 0/g) || []).length, 1, '组合器里应只有 scope 注入的那一份');
  assert.ok(composed.includes(scopeSource({ area: 'pointer', paint: true }).trim()), '组合器没有用 scopeSource(pointer, paint) 注入');
});
