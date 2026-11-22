// ============================================================
// R1 等价性 oracle —— comment/scope.mjs
//
// 目的不是测"新实现对不对"，而是证明"新实现与重构前逐例相同"：
//   R1–R2   基线实现（从重构前 comment-browser.mjs 原样抄来）与新实现逐例比对；
//   R3      三个私有区选择器与重构前字面量逐字节相同；
//   R4      scopeSource 注入的前缀能 eval 出同名同值绑定；
//   R5–R6   身份判定序列化后在裸上下文（只有 DOM 全局）可独立执行；
//   R7–R8   导出的 readCommentDom 同样自包含，且走的是绘制期变体；
//   R9      绘制期可见性**没有**被顺手收紧（漂移属于既有行为，不在 R1 范围）；
//   R10     comment-browser.mjs 里不得再出现内联实现（防复制回潮）。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PRIVATE_AREA, visibleWithOpacity, visiblePaintOnly, scopeSource, readCommentSelfIdentity } from '../comment/scope.mjs';

// ---- 重构前实现：原样抄自 baseline 提交的 comment-browser.mjs ----
const baselineVisible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden')) return false; for (let node = element; node; node = node.parentElement) if (Number(getComputedStyle(node).opacity) === 0) return false; return true; };
const baselineVisiblePaint = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden'; };

const VIEWPORT = { innerWidth: 400, innerHeight: 800 };

// 极简 DOM 世界：节点只带 getBoundingClientRect / parentElement，样式表挂在 WeakMap 上。
function makeWorld() {
  const styles = new WeakMap();
  const node = ({ box = {}, css = {}, parent = null } = {}) => {
    const rect = { width: 100, height: 50, top: 100, left: 10, bottom: 150, right: 110, ...box };
    const style = { display: 'block', visibility: 'visible', opacity: '1', ...css };
    const element = { getBoundingClientRect: () => rect, parentElement: parent };
    styles.set(element, style);
    return element;
  };
  const getComputedStyle = element => styles.get(element) || { display: 'block', visibility: 'visible', opacity: '1' };
  return { node, getComputedStyle };
}

function withGlobals(run) {
  const saved = { getComputedStyle: globalThis.getComputedStyle, innerHeight: globalThis.innerHeight, innerWidth: globalThis.innerWidth };
  try {
    const world = makeWorld();
    globalThis.getComputedStyle = world.getComputedStyle;
    globalThis.innerHeight = VIEWPORT.innerHeight;
    globalThis.innerWidth = VIEWPORT.innerWidth;
    return run(world);
  } finally {
    globalThis.getComputedStyle = saved.getComputedStyle;
    globalThis.innerHeight = saved.innerHeight;
    globalThis.innerWidth = saved.innerWidth;
  }
}

// 覆盖：完全可见 / 尺寸归零 / 四条出屏 / display / visibility / opacity 自身·父·祖父·字符串·半透明
const CASES = [
  ['完全可见', {}],
  ['宽度归零', { box: { width: 0 } }],
  ['高度归零', { box: { height: 0 } }],
  ['顶边在视口下方', { box: { top: 800, bottom: 850 } }],
  ['左边在视口右侧', { box: { left: 400, right: 500 } }],
  ['底边在视口上方', { box: { top: -60, bottom: 0 } }],
  ['右边在视口左侧', { box: { left: -100, right: 0 } }],
  ['display:none', { css: { display: 'none' } }],
  ['visibility:hidden', { css: { visibility: 'hidden' } }],
  ['自身 opacity 0（数字）', { css: { opacity: 0 } }],
  ['自身 opacity "0"（字符串）', { css: { opacity: '0' } }],
  ['父级 opacity 0', { parent: { opacity: 0 } }],
  ['祖父级 opacity 0', { grand: { opacity: 0 } }],
  ['半透明 0.5', { css: { opacity: '0.5' } }],
  ['贴边可见（top 749 / bottom 799）', { box: { top: 749, bottom: 799 } }],
];

const build = (world, spec) => {
  const grand = spec.grand ? world.node({ css: spec.grand }) : null;
  const parent = spec.parent ? world.node({ css: spec.parent, parent: grand }) : grand;
  return world.node({ box: spec.box, css: spec.css, parent });
};

test('R1 带 opacity 祖先检查的 visible：15 个用例与重构前实现逐例一致', () => {
  withGlobals(world => {
    for (const [name, spec] of CASES) {
      const element = build(world, spec);
      assert.equal(visibleWithOpacity(element), baselineVisible(element), `用例「${name}」判定不一致`);
    }
  });
});

test('R2 绘制期 visible：15 个用例与重构前 331 行实现逐例一致', () => {
  withGlobals(world => {
    for (const [name, spec] of CASES) {
      const element = build(world, spec);
      assert.equal(visiblePaintOnly(element), baselineVisiblePaint(element), `用例「${name}」判定不一致`);
    }
  });
});

test('R3 三个私有区选择器与重构前字面量逐字节相同', () => {
  assert.equal(PRIVATE_AREA.identity, '[data-e2e="im-dialog"],[data-e2e="conversation-item"],[data-e2e="comment-item"]');
  assert.equal(PRIVATE_AREA.pointer, '[data-e2e="im-dialog"],[data-e2e="conversation-item"],[data-e2e="comment-item"],[data-e2e="comment-list"],[data-e2e="danmaku-container"]');
  assert.equal(PRIVATE_AREA.publicRows, '[data-e2e="im-dialog"],[data-e2e="conversation-item"]');
});

test('R4 scopeSource 注入的前缀能 eval 出同名绑定，且值来自唯一实现', () => {
  const injected = new Function(`${scopeSource({ area: 'pointer' })}return { visible, privateArea };`)();
  assert.equal(typeof injected.visible, 'function');
  assert.equal(injected.visible.toString(), visibleWithOpacity.toString());
  assert.equal(injected.privateArea, PRIVATE_AREA.pointer);
  const paint = new Function(`${scopeSource({ area: 'publicRows', paint: true })}return { visible, privateArea };`)();
  assert.equal(paint.visible.toString(), visiblePaintOnly.toString());
  assert.equal(paint.privateArea, PRIVATE_AREA.publicRows);
});

// 裸上下文只给 DOM 全局：序列化后的函数若不满足"自包含"，这里立刻 ReferenceError。
const pageContext = ({ origin = 'https://www.douyin.com', anchors = [], comments = [], players = [] } = {}) => ({
  location: { origin, href: `${origin}/video/123`, pathname: '/video/123', searchParams: new URLSearchParams() },
  document: { querySelectorAll: selector => selector.startsWith('.tab-user_self') ? anchors : selector.includes('comment-item') ? comments : players },
  innerHeight: VIEWPORT.innerHeight,
  innerWidth: VIEWPORT.innerWidth,
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  URL,
  URLSearchParams,
});

test('R5 身份判定序列化后可在裸上下文执行：非抖音域直接拒绝', () => {
  const run = vm.runInNewContext(`(${readCommentSelfIdentity.toString()})`, pageContext({ origin: 'https://example.com' }));
  // vm 里创建的对象原型属于另一个 realm，deepStrictEqual 会判不等；这里比对序列化结果。
  assert.equal(JSON.stringify(run()), JSON.stringify({ ready: false, ownProfileId: null, reasonCode: 'self-origin-unavailable' }));
});

test('R6 身份判定序列化后可在裸上下文执行：无自身导航锚点即判歧义', () => {
  const run = vm.runInNewContext(`(${readCommentSelfIdentity.toString()})`, pageContext());
  assert.equal(JSON.stringify(run()), JSON.stringify({ ready: false, ownProfileId: null, reasonCode: 'self-navigation-ambiguous' }));
});

const anchorOf = ({ id = 'abcDEF12345', text = '我的', box = {} } = {}) => {
  const rect = { width: 100, height: 40, top: 10, left: 10, bottom: 50, right: 110, ...box };
  return { getBoundingClientRect: () => rect, parentElement: null, closest: () => null, getAttribute: () => `/user/${id}`, textContent: text };
};

test('R7 导出的 readCommentDom 只接受一个参数、走绘制期变体，且序列化后自包含', async () => {
  const module = await import('../comment-browser.mjs');
  assert.equal(module.readCommentDom.length, 1, 'readCommentDom 必须只接受 input 一个参数');
  const source = module.readCommentDom.toString();
  assert.ok(source.includes('visiblePaintOnly'), '绘制期路径必须使用不查 opacity 的变体');
  // 若注入的 visible / privateArea 没解析到，filter 里会立即抛错；返回 { rows: [] } 即证明注入生效。
  const visibleAnchor = vm.runInNewContext(`(${source})`, pageContext({ anchors: [anchorOf()] }));
  assert.equal(JSON.stringify(visibleAnchor({ expectedVideoId: '123', ownProfileId: 'abcDEF12345' })), '{"rows":[]}');
  const hiddenAnchor = vm.runInNewContext(`(${source})`, pageContext({ anchors: [anchorOf({ box: { width: 0 } })] }));
  assert.equal(JSON.stringify(hiddenAnchor({ expectedVideoId: '123', ownProfileId: 'abcDEF12345' })), '{"rows":[]}');
});

test('R8 opacity 漂移被如实保留：两版 visible 的差异恰好只在 opacity 祖先检查', () => {
  withGlobals(world => {
    const opaqueParent = build(world, { parent: { opacity: 0 } });
    assert.equal(visibleWithOpacity(opaqueParent), false, '带 opacity 检查的版本应拒绝透明父级');
    assert.equal(visiblePaintOnly(opaqueParent), true, '绘制期版本不查 opacity，行为应与重构前一致');
    assert.equal(baselineVisiblePaint(opaqueParent), true);
  });
});

test('R9 comment-browser.mjs 不再内联作用域实现（防复制回潮）', () => {
  const source = readFileSync(new URL('../comment-browser.mjs', import.meta.url), 'utf8');
  assert.equal(/const visible\s*=/.test(source), false, 'comment-browser 不应再定义 visible');
  assert.equal(/const privateArea\s*=/.test(source), false, 'comment-browser 不应再定义 privateArea');
  assert.equal(/function readCommentSelfIdentity\s*\(/.test(source), false, '身份判定不得再复制一份');
  assert.ok(source.includes('installGeometryWitness'), '几何见证应走注入组合');
});

// 组合器只在真实浏览器里跑，Node 测试碰不到；这里按源码把两段拼回去，
// 在页内上下文里真正调用一次，确认注入的可见性/私有区/身份判定都能解析到。
test('R10 几何见证组合器能在页内上下文装起来（codegen 接线自检）', () => {
  const source = readFileSync(new URL('../comment-browser.mjs', import.meta.url), 'utf8');
  const bodyStart = source.indexOf('function installInputWitness(');
  assert.ok(bodyStart > 0, '未找到 installInputWitness');
  const bodyEnd = source.indexOf('\n}\n', bodyStart) + 3;
  const witnessSource = source.slice(bodyStart, bodyEnd);
  const composeLine = source.split('\n').find(line => /^(?:export )?const installGeometryWitness = new Function\(/.test(line));
  assert.ok(composeLine, '未找到 installGeometryWitness 组合器');

  const context = {
    ...pageContext(),
    window: {},
    Element: class {},
    Object,
    Math,
    Date,
    Number,
    String,
    Set,
    console,
    scopeSource,
    readCommentSelfIdentity,
  };
  // 让 scope 标记存在，把执行推进到 `!visible(element)` 那一关：
  // 若注入的绑定名写错，这里会抛 TypeError 而不是返回 false。
  const scope = { getAttribute: () => 't1', matches: () => false, isConnected: true, contains: () => true, closest: () => null, querySelector: () => null, querySelectorAll: () => [], setAttribute: () => {} };
  context.document = { querySelectorAll: selector => selector.includes('data-deepseek-comment-pointer-scope') ? [scope] : [] };
  // 导出是为真机验证脚本准备的；vm 里不能有 export，拼回去时剥掉。
  const installed = vm.runInNewContext(`(() => { ${witnessSource}\n${composeLine.replace(/^export /, '')}\nreturn installGeometryWitness; })()`, context);
  const element = { isConnected: true, getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }), scrollIntoView: () => {}, closest: () => null, setAttribute: () => {}, removeAttribute: () => {} };
  assert.equal(installed(element, { token: 't1', mode: 'editor', expectedVideoId: '123' }), false, '零尺寸目标应在 visible 判定处被拒');
});
