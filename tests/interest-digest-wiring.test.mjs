// ============================================================
// 月度总结接线测试（真磁盘）
//
// 纯函数对了不代表功能成立：总结要真的落进 state.json、真的渲染进人格卡，
// 而且必须满足一个承诺 —— 生成过的月份不再被后续观察改写。
// 否则"长久保持"只是句文案。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PersonaMemory } from '../persona-memory.mjs';

const OCT = Date.parse('2026-10-15T04:00:00Z');
const NOV = Date.parse('2026-11-10T04:00:00Z');
const DEC = Date.parse('2026-12-10T04:00:00Z');
const JAN = Date.parse('2026-01-15T04:00:00Z');
const DEC2025 = Date.parse('2025-12-05T04:00:00Z');

const CARD = '# 小鲸的人格卡\n\n手编正文，不该被总结改动。\n';

function observation(videoId, at, title = '测试作品') {
  return {
    id: `video:${createHash('sha256').update(videoId).digest('hex')}`,
    videoId, url: `https://www.douyin.com/video/${videoId}`, title, author: '作者', kind: 'dom',
    visibility: 'account-visible-unverified', privacy: 'internal-reference',
    playback: { time: 3, duration: 10, paused: false }, frameCount: 0,
    source: 'dsh', sources: ['dsh'], observedAt: at,
  };
}

/** 作品编号用字符串拼，避免超出安全整数后 +1 得到同一个数、撞上"重复观察"校验。 */
function videoIdOf(index) { return `74000000000000${String(index).padStart(6, '0')}`; }

function stateFixture(at, count = 3) {
  return {
    version: 1, generation: 1, initializedAt: at, legacyImportAttempted: false, legacyImported: false,
    observations: Array.from({ length: count }, (_, index) => observation(videoIdOf(index), at)),
    interests: [], userPreferences: [], digests: [],
  };
}

function seeded({ state, now = NOV, card = CARD } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'interest-digest-'));
  const persona = path.join(directory, 'persona');
  fs.mkdirSync(persona, { recursive: true });
  if (state) fs.writeFileSync(path.join(persona, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  if (card !== null) fs.writeFileSync(path.join(persona, 'role-card.md'), card);
  let clock = now;
  const memory = new PersonaMemory({ memoryDir: directory, clock: () => clock, lockTimeoutMs: 500 });
  return {
    memory, directory,
    cardFile: path.join(persona, 'role-card.md'),
    stateFile: path.join(persona, 'state.json'),
    card: () => fs.readFileSync(path.join(persona, 'role-card.md'), 'utf8'),
    state: () => JSON.parse(fs.readFileSync(path.join(persona, 'state.json'), 'utf8')),
    advance: at => { clock = at; },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function video(id) {
  return { id, url: `https://www.douyin.com/video/${id}`, title: '新作品', author: '作者', time: 3, duration: 10, paused: false, readyState: 4 };
}

/** recordObservation 只接受"确实在播、没登录墙、没私信"的页面状态。 */
function observe(memory, id) {
  const item = video(id);
  return memory.recordObservation({ url: item.url, loginRequired: false, verificationRequired: false, privateChatVisible: false, video: item }, { source: 'dsh', kind: 'dom' });
}

test('M1 上月有观看记录时，启动即生成总结并写进人格卡', () => {
  const fixture = seeded({ state: stateFixture(OCT) });
  try {
    const snapshot = fixture.memory.initialize();
    const state = fixture.state();
    assert.equal(state.digests.length, 1, '生成了一条月度总结');
    assert.equal(state.digests[0].key, '2026-10');
    assert.ok(state.digests[0].lines.length >= 2, '夹具前提：总结有概述行');
    // 关键：不是只在返回值里，而是真的进了人格卡文件。
    const card = fixture.card();
    assert.match(card, /## 按月的偏好总结/);
    assert.match(card, /### 2026-10/);
    assert.match(card, /看过 3 个作品/);
    assert.match(snapshot.personaText, /### 2026-10/, '快照与文件读的是同一份结果');
    assert.match(card, /手编正文，不该被总结改动。/, '手编正文原样保留');
  } finally { fixture.cleanup(); }
});

test('M2 同一个月不会重复生成，等于不变', () => {
  const fixture = seeded({ state: stateFixture(OCT) });
  try {
    fixture.memory.initialize();
    const first = fixture.state();
    const cardFirst = fixture.card();
    fixture.memory.initialize();
    fixture.memory.initialize();
    const again = fixture.state();
    assert.equal(again.digests.length, 1);
    assert.equal(again.digests[0].generatedAt, first.digests[0].generatedAt, '重复启动不改写已生成的月份');
    assert.equal(fixture.card(), cardFirst, '人格卡逐字节不变');
  } finally { fixture.cleanup(); }
});

test('M3 上月没有作品时不生成总结，也不写占位条目', () => {
  // 当月只有一条记录，上月为空。
  const fixture = seeded({ state: stateFixture(NOV, 1) });
  try {
    fixture.memory.initialize();
    assert.deepEqual(fixture.state().digests, [], '空月份不留下一条"本月无事发生"');
    assert.match(fixture.card(), /暂无月度总结/);
  } finally { fixture.cleanup(); }
});

test('M4 总结里不出现作品链接，人格卡不是观看清单', () => {
  const fixture = seeded({ state: stateFixture(OCT, 4) });
  try {
    fixture.memory.initialize();
    const digestText = fixture.state().digests[0].lines.join('\n');
    assert.doesNotMatch(digestText, /https?:\/\//);
    const card = fixture.card();
    const section = card.slice(card.indexOf('## 按月的偏好总结'));
    assert.doesNotMatch(section, /www\.douyin\.com\/video/, '月度总结区没有作品地址');
  } finally { fixture.cleanup(); }
});

test('M5 年初补的是去年十二月', () => {
  const fixture = seeded({ state: stateFixture(DEC2025), now: JAN });
  try {
    fixture.memory.initialize();
    assert.equal(fixture.state().digests[0].key, '2025-12');
    assert.match(fixture.card(), /### 2025-12/);
  } finally { fixture.cleanup(); }
});

test('M6 跨月不重启也能补上：新观察时顺手检查', () => {
  // 启动时还在十月，上月（九月）没有数据，所以没有总结。
  const fixture = seeded({ state: stateFixture(OCT, 1), now: OCT });
  try {
    fixture.memory.initialize();
    assert.deepEqual(fixture.state().digests, [], '夹具前提：启动时没生成');

    fixture.advance(NOV);
    observe(fixture.memory, '7400000000000000009');

    const digests = fixture.state().digests;
    assert.equal(digests.length, 1);
    assert.equal(digests[0].key, '2026-10', '十月已经过去，补的是十月');
  } finally { fixture.cleanup(); }
});

test('M7 生成后的月份不会被后续观察改写（长期保持）', () => {
  const fixture = seeded({ state: stateFixture(OCT) });
  try {
    fixture.memory.initialize();
    const frozen = JSON.stringify(fixture.state().digests[0]);

    fixture.advance(NOV);
    for (const suffix of ['1', '2', '3']) {
      observe(fixture.memory, `740000000000000010${suffix}`);
    }
    const state = fixture.state();
    assert.equal(JSON.stringify(state.digests[0]), frozen, '十月的结论逐字节不变');
    assert.equal(state.digests.length, 1, '还没到十二月，不会提前生成十一月');
  } finally { fixture.cleanup(); }
});

test('M8 人格卡只渲染最近三个月，更早的仍在数据里', () => {
  const base = stateFixture(OCT, 1);
  base.digests = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map((key, index) => ({ key, generatedAt: OCT + index, lines: [`${key}的归纳`] }));
  const fixture = seeded({ state: base });
  try {
    fixture.memory.initialize();
    const card = fixture.card();
    const headings = [...card.matchAll(/^### (\d{4}-\d{2})$/gm)].map(match => match[1]);
    assert.deepEqual(headings, ['2026-10', '2026-09', '2026-08'], '新的在上，只保留三个月');
    assert.equal(fixture.state().digests.length, 5, '数据文件不丢历史');
  } finally { fixture.cleanup(); }
});

test('M9 坏掉的月度总结不会被当成没有而覆盖，读就报错', () => {
  const base = stateFixture(OCT, 1);
  base.digests = [
    { key: '2026-09', generatedAt: OCT, lines: ['x'] },
    { key: '2026-09', generatedAt: OCT + 1, lines: ['重复月份'] },
  ];
  const fixture = seeded({ state: base });
  try {
    const before = fs.readFileSync(fixture.stateFile, 'utf8');
    assert.throws(() => fixture.memory.initialize(), /月度总结格式无效/);
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before, '坏数据没有被覆盖');
  } finally { fixture.cleanup(); }
});

test('M10 模型上下文里带上了月度总结', () => {
  const fixture = seeded({ state: stateFixture(OCT) });
  try {
    fixture.memory.initialize();
    const context = fixture.memory.context();
    assert.match(context, /按月的偏好总结/);
    assert.match(context, /2026-10/);
  } finally { fixture.cleanup(); }
});
