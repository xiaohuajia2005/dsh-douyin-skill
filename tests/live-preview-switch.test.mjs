import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readPageState } from '../core.mjs';
import { AutonomousWatch, isLivePreview } from '../autonomous-watch.mjs';

// inspectSwitchInput 是 switchVideo 的页面内函数。直接提取真实源码执行，
// 既不用为它增加生产 API，也避免在测试里复制一份可能漂移的实现。
const coreSource = readFileSync(new URL('../core.mjs', import.meta.url), 'utf8');
const inspectStart = coreSource.indexOf('const inspectSwitchInput=');
const inspectEnd = coreSource.indexOf('    const identity=state=>', inspectStart);
assert.ok(inspectStart >= 0 && inspectEnd > inspectStart, '夹具前提：找到真实换片身份函数');
const inspectSwitchInput = new Function(`${coreSource.slice(inspectStart, inspectEnd)};return inspectSwitchInput;`)();

const RECT = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
const HIDDEN = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
const descendants = (root, includeRoot = false) => [
  ...(includeRoot ? [root] : []),
  ...root.children.flatMap(child => descendants(child, true)),
];

class FakeElement {
  constructor(tagName, attributes = {}, { text = '', rect = RECT } = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this.children = [];
    this.parentElement = null;
    this.innerText = text;
    this.textContent = text;
    this.rect = { ...rect };
    this.style = { display: 'block', visibility: 'visible', opacity: '1' };
    this.href = attributes.href ? new URL(attributes.href, 'https://www.douyin.com/').href : '';
  }
  get childElementCount() { return this.children.length; }
  get className() { return this.getAttribute('class') || ''; }
  get id() { return this.getAttribute('id') || ''; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } return this; }
  getBoundingClientRect() { return this.rect; }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? String(this.attributes[name]) : null; }
  matches(selector) { return selector.split(',').some(part => this.matchesOne(part.trim())); }
  matchesOne(selector) {
    if (selector === 'a[href]') return this.tagName === 'A' && Object.hasOwn(this.attributes, 'href');
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    let match = /^\[data-e2e="([^"]+)"\]$/.exec(selector);
    if (match) return this.getAttribute('data-e2e') === match[1];
    match = /^\[id\^="([^"]+)"\]$/.exec(selector);
    if (match) return this.id.startsWith(match[1]);
    match = /^\[class\*="([^"]+)"\]$/.exec(selector);
    if (match) return this.className.includes(match[1]);
    if (/^[a-z]+$/.test(selector)) return this.tagName === selector.toUpperCase();
    return false;
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return descendants(this).filter(element => element.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeDocument {
  constructor(body) { this.body = body; this.title = '抖音'; this.readyState = 'complete'; }
  querySelectorAll(selector) {
    if (selector === 'body *') return descendants(this.body);
    return descendants(this.body, true).filter(element => element.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function feedFixture({ e2e = 'feed-live', videoId = null, roomIds = [], hiddenLiveCard = false } = {}) {
  const body = new FakeElement('body');
  const card = new FakeElement('div', { 'data-e2e': e2e, ...(videoId ? { class: `video_${videoId}` } : {}) });
  const player = new FakeElement('div', { class: e2e === 'feed-live' ? 'LivePlayer_Preview' : 'player' });
  const video = new FakeElement('video');
  Object.assign(video, { currentTime: 4, duration: 20, paused: false, muted: false, readyState: 4, ended: false, loop: false, videoWidth: 1080, videoHeight: 1920 });
  player.append(video); card.append(player);
  card.append(new FakeElement('a', { href: 'https://www.douyin.com/user/author' }, { text: '作者' }));
  for (const roomId of roomIds) card.append(new FakeElement('a', { href: `https://live.douyin.com/${roomId}` }));
  body.append(card);
  if (hiddenLiveCard) body.append(new FakeElement('div', { 'data-e2e': 'feed-live' }, { rect: HIDDEN }));
  return { body, document: new FakeDocument(body), card, video };
}

async function withDom(fixture, action, sharedWindow = {}) {
  const names = ['location', 'window', 'document', 'innerWidth', 'innerHeight', 'getComputedStyle'];
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, {
    location: new URL('https://www.douyin.com/?recommend=1'),
    window: sharedWindow,
    document: fixture.document,
    innerWidth: 1000,
    innerHeight: 700,
    getComputedStyle: element => element.style,
  });
  try { return await action(); }
  finally {
    for (const name of names) {
      const descriptor = saved.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

const readIdentity = () => inspectSwitchInput({ action: 'read', expectedIdentity: null });
const liveState = (source = 'active-feed-live-card') => ({
  pageKind: 'live-preview',
  livePreview: { recognized: true, source, scope: 'recommend-feed', roomId: source === 'active-feed-live-link' ? '12345' : null },
});
const videoState = { pageKind: 'video', video: { id: '7400000000000000001', readyState: 4, paused: false }, livePreview: null };

test('L1 有房间链接的直播预览保持原有识别与身份语义', () => withDom(feedFixture({ roomIds: ['12345'] }), () => {
  const state = readPageState();
  assert.equal(state.pageKind, 'live-preview');
  assert.equal(state.livePreview.source, 'active-feed-live-link');
  assert.equal(state.livePreview.roomId, '12345');
  assert.equal(readIdentity(), 'live:12345');
  assert.equal(isLivePreview(state), true);
}));

test('L2 本次故障形态：无房间链接的 feed-live 也识别为直播，不冒充普通作品', () => withDom(feedFixture({ hiddenLiveCard: true }), () => {
  const state = readPageState();
  assert.equal(state.video.id, null, '夹具前提：确实没有作品或房间 ID');
  assert.equal(state.video.readyState, 4, '夹具前提：视频已经就绪，排除加载慢');
  assert.equal(state.pageKind, 'live-preview');
  assert.deepEqual(state.livePreview, {
    recognized: true, source: 'active-feed-live-card', scope: 'recommend-feed', roomId: null,
    viewport: { x: 0, y: 0, width: 800, height: 600 },
  });
  assert.equal(isLivePreview(state), true);
}));

test('L3 匿名直播身份在同一 DOM 卡上稳定，不同卡不会混同', async () => {
  const sharedWindow = {};
  const first = await withDom(feedFixture(), () => {
    const one = readIdentity(), two = readIdentity();
    assert.match(one, /^live-dom:[a-f0-9-]{36}$/);
    assert.equal(two, one, '连续回读必须稳定，否则换片永远不会被确认');
    return one;
  }, sharedWindow);
  const second = await withDom(feedFixture(), readIdentity, sharedWindow);
  assert.match(second, /^live-dom:[a-f0-9-]{36}$/);
  assert.notEqual(second, first, '新 DOM 卡必须得到新身份，不能连续跳过同一直播');
});

test('L4 普通作品仍使用数字 ID，不被直播 DOM 身份替代', () => withDom(feedFixture({ e2e: 'feed-active-video', videoId: '7400000000000000001' }), () => {
  const state = readPageState();
  assert.equal(state.pageKind, 'video');
  assert.equal(state.video.id, '7400000000000000001');
  assert.equal(state.livePreview, null);
  assert.equal(isLivePreview(state), false);
  assert.equal(inspectSwitchInput({ action: 'read', expectedIdentity: 'video:7400000000000000001' }), 'video:7400000000000000001');
}));

test('L5 无 ID 的普通活动视频卡不会被猜成匿名直播', () => withDom(feedFixture({ e2e: 'feed-active-video' }), () => {
  const state = readPageState();
  assert.equal(state.video.id, null, '夹具前提：没有可核对 ID');
  assert.equal(state.livePreview, null);
  assert.equal(state.pageKind, 'unknown');
  assert.equal(readIdentity(), null);
}));

test('L6 多个房间链接是身份冲突，不能降级成匿名直播放行', () => withDom(feedFixture({ roomIds: ['12345', '67890'] }), () => {
  const state = readPageState();
  assert.equal(state.livePreview, null);
  assert.equal(readIdentity(), null);
  assert.equal(isLivePreview(state), false);
}));

test('L7 自主观看只接受两种严格直播凭证，伪造 source 或 roomId 不放行', () => {
  assert.equal(isLivePreview(liveState('active-feed-live-link')), true);
  assert.equal(isLivePreview(liveState('active-feed-live-card')), true);
  assert.equal(isLivePreview({ ...liveState(), livePreview: { ...liveState().livePreview, roomId: '12345' } }), false);
  assert.equal(isLivePreview({ ...liveState(), livePreview: { ...liveState().livePreview, source: 'anything-with-video' } }), false);
  assert.equal(isLivePreview({ ...liveState(), pageKind: 'unknown' }), false);
  assert.equal(isLivePreview({ ...liveState(), livePreview: { ...liveState().livePreview, scope: 'search' } }), false);
});

test('L8 直播换片未确认时只输入一次，且错误可被主循环跳过', async () => {
  let calls = 0;
  const watcher = {
    async execute() { calls++; return { changed: false, state: liveState() }; },
    onEvent() { throw new Error('未确认换片不应记录成功事件'); },
  };
  const error = await AutonomousWatch.prototype.skipLivePreviews.call(watcher, liveState()).then(() => null, reason => reason);
  assert.ok(error, '应当抛出错误交给主循环处理');
  assert.match(error.message, /直播预览换片未确认/);
  assert.equal(error.recoverable, true, '换片未确认是可跳过的，不能终止整场观看');
  assert.equal(calls, 1, '未确认时只输入一次，不在外层循环重复点击');
});

test('L9 匿名直播确认切到普通作品后返回就绪状态并记录一次成功', async () => {
  const events = [];
  const watcher = {
    async execute(name) { assert.equal(name, 'douyin_next'); return { changed: true, state: videoState }; },
    onEvent(event) { events.push(event); },
  };
  const result = await AutonomousWatch.prototype.skipLivePreviews.call(watcher, liveState());
  assert.equal(result.changed, true);
  assert.equal(result.state.video.id, '7400000000000000001');
  assert.deepEqual(events, [{ type: 'watch.live_skip', attempt: 1, changed: true }]);
});

// 实战故障：直播卡上 wheel 被换片核对层按“只认普通视频容器”拦掉，同时可见的
// video-switch 箭头属于直播播放器、点了不换片，于是回读 12 秒仍 changed=false。
// 这三条把两处白名单和箭头分支钉住。
test('L10 换片输入核对与落点核对都接受直播卡，且没有丢掉原有的三种容器', () => {
  const lines = coreSource.split('\n');
  const targetLine = lines.find(line => line.includes('targetMatches='));
  const pointLine = lines.find(line => line.includes('!hit.closest(') && line.includes('feed-active-video'));
  assert.ok(targetLine, '夹具前提：找到 wheel 目标核对行');
  assert.ok(pointLine, '夹具前提：找到 wheel 落点核对行');
  const required = ['feed-active-video', 'video-detail', 'player-container', 'feed-live', 'feed-live-card'];
  for (const [label, line] of [['输入核对', targetLine], ['落点核对', pointLine]]) {
    const selectors = [...line.matchAll(/\[data-e2e="([^"]+)"\]/g)].map(match => match[1]);
    const missing = required.filter(name => !selectors.includes(name));
    assert.deepEqual(missing, [], `${label}缺少这些容器的白名单：${missing.join('、')}`);
  }
});

test('L11 直播页不使用直播播放器的箭头，普通页仍按真实箭头数判定歧义', async () => {
  const line = coreSource.split('\n').find(item => item.includes('const arrowCount='));
  assert.ok(line, '夹具前提：找到 arrowCount 赋值');
  const expression = /const arrowCount=(.+);\s*$/.exec(line.trim())?.[1];
  assert.ok(expression, `无法从该行解析箭头计数表达式：${line.trim()}`);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const count = new AsyncFunction('before', 'arrow', `return (${expression});`);

  assert.equal(await count(liveState(), { count: async () => 1 }), 0, '直播页即使箭头可见也不能点，它不触发换片');
  assert.equal(await count({ pageKind: 'video' }, { count: async () => 1 }), 1, '普通页仍用真实箭头数');
  assert.equal(await count({ pageKind: 'video' }, { count: async () => 2 }), 2, '多箭头仍要能被判为控件歧义');
});
