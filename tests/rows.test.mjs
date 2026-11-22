// ============================================================
// 采集层特征测试 —— 迭代 5
//
// 锁的是重构前 publicMessages() 里那段行内 map 的输出：字段、键序、哈希算法。
// 期望值在测试内用 node:crypto 独立重算，不复用被测模块的私有 hash，
// 所以"模块里换个写法导致哈希漂移"会被抓出来。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mediaResourceRef, normalizePublicRow } from '../evidence/rows.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const recipientId = 'conv:' + 'a'.repeat(64);

test('R1 无 media / 无 clientId / 无 member：原样透传，不夹带新字段', () => {
  const row = { id: 'dom-0', nativeId: 'n0', sender: 'incoming', kind: 'text', text: '在吗', order: 0, orderMode: 'relative', latestEndVerified: true };
  const { message, refs } = normalizePublicRow(recipientId, row);
  assert.deepEqual(message, row);
  assert.deepEqual(Object.keys(message), Object.keys(row), '键序与入参一致');
  assert.deepEqual(refs, []);
});

test('R2 clientId 折叠成稳定哈希，原始 clientId 不外泄', () => {
  const row = { id: 'dom-1', sender: 'outgoing', kind: 'text', text: '嗯', order: 1, clientId: 'client-abc' };
  const { message } = normalizePublicRow(recipientId, row);
  assert.equal(message.clientMessageKey, sha(`${recipientId}\0client-abc`));
  assert.equal('clientId' in message, false);
  assert.equal(message.text, '嗯', '其余字段保留');
  // 同一 clientId 在不同会话里必须算出不同的键，否则跨会话串身份。
  const other = normalizePublicRow('conv:' + 'b'.repeat(64), row).message;
  assert.notEqual(other.clientMessageKey, message.clientMessageKey);
});

test('R3 member 折叠成 memberId；缺 nativeId 时为 null；提及标记只认严格 true', () => {
  const withId = normalizePublicRow(recipientId, { id: 'dom-2', order: 2, member: { nativeId: 'u9', name: '@小鱼' }, mentionedSelf: true }).message;
  assert.equal(withId.memberId, `member:${sha(`${recipientId}\0u9`)}`);
  assert.equal(withId.memberName, '@小鱼');
  assert.equal(withId.mentionedSelf, true);
  assert.equal('member' in withId, false);

  const noId = normalizePublicRow(recipientId, { id: 'dom-3', order: 3, member: { name: '' }, mentionedSelf: 'yes' }).message;
  assert.equal(noId.memberId, null);
  assert.equal(noId.memberName, null, '空字符串名字归一成 null');
  assert.equal(noId.mentionedSelf, false, '非布尔真值不算提及');
});

test('R4 无 media 时不产生 media 键（键序锁定）', () => {
  const { message } = normalizePublicRow(recipientId, { id: 'dom-4', order: 4, text: 'x' });
  assert.deepEqual(Object.keys(message), ['id', 'order', 'text']);
});

test('R5 分享卡片：媒体字段保留、原图数组不外泄、计数与 resources 对齐', () => {
  const row = {
    id: 'dom-5', order: 5, kind: 'shared-work',
    media: {
      type: 'shared-work', videoId: 'v123', title: '小猫',
      images: [{ src: 'https://p3.douyinpic.com/a/b.jpg?sign=expired', label: '封面' }, { label: '没src' }],
      audioSources: [],
    },
  };
  const { message, refs } = normalizePublicRow(recipientId, row);
  assert.equal(message.media.type, 'shared-work');
  assert.equal(message.media.videoId, 'v123', '分享卡片的身份字段必须保留');
  assert.equal('images' in message.media, false);
  assert.equal('audioSources' in message.media, false);
  assert.equal(message.media.imageCount, 1);
  assert.deepEqual(message.media.resources, [{ resourceRef: `media:${sha('/a/b.jpg')}`, label: '封面' }]);
  assert.equal(refs.length, 1, 'refs 与 resources 等长，顺序一致');
});

test('R6 语音：sourceCount 计 images+audioSources 合并数，refs 带 src 供登记', () => {
  const row = {
    id: 'dom-6', order: 6, kind: 'voice',
    media: { type: 'voice', duration: 3, images: [{ src: 'https://x/cover.png' }], audioSources: [{ src: 'https://x/a.mp3', label: '语音' }] },
  };
  const { message, refs } = normalizePublicRow(recipientId, row);
  assert.equal(message.media.sourceCount, 2);
  assert.equal('imageCount' in message.media, false);
  assert.deepEqual(refs.map(item => item.ref), [`media:${sha('/cover.png')}`, `media:${sha('/a.mp3')}`]);
  assert.deepEqual(refs.map(item => item.label), [null, '语音']);
  assert.deepEqual(refs.map(item => item.src), ['https://x/cover.png', 'https://x/a.mp3']);
  assert.deepEqual(message.media.resources, refs.map(item => ({ resourceRef: item.ref, label: item.label })));
});

test('R7 资源 ref 的取值口径：data: 用整串，普通 URL 只取 pathname，非法 URL 退回整串', () => {
  assert.equal(mediaResourceRef('data:image/png;base64,AAA'), `media:${sha('data:image/png;base64,AAA')}`);
  assert.equal(mediaResourceRef('https://host/p/q.jpg?a=1#h'), `media:${sha('/p/q.jpg')}`, '查询串与锚点不参与身份');
  assert.equal(mediaResourceRef('not a url'), `media:${sha('not a url')}`);
});

test('R8 全部资源都没有 src 时计数为 0，resources 为空数组而不是缺字段', () => {
  const { message, refs } = normalizePublicRow(recipientId, { id: 'dom-8', order: 8, media: { type: 'image', images: [{ label: 'a' }, { src: '' }] } });
  assert.equal(message.media.imageCount, 0);
  assert.deepEqual(message.media.resources, []);
  assert.deepEqual(refs, []);
});

// ------------------------------------------------------------
// R9 等价性 oracle：把重构前 publicMessages() 里那段行内 map 原样抄一份，
// 对同一批行分别跑"旧代码"和"新模块"，断言 JSON 序列化后逐字节相等。
// 这是"行为零变更"的硬证据 —— 指纹输入（id/signature 之外的每个字段）任何漂移都会失败。
// ------------------------------------------------------------
const legacyNormalize = (recipientId, row) => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const { member, clientId, ...rest } = row;
  const identified = clientId ? { ...rest, clientMessageKey: hash(`${recipientId}\0${clientId}`) } : rest;
  const base = member ? { ...identified, memberId: member.nativeId ? `member:${hash(`${recipientId}\0${member.nativeId}`)}` : null, memberName: member.name || null, mentionedSelf: row.mentionedSelf === true } : identified;
  if (!row.media) return base;
  const { images = [], audioSources = [], ...media } = row.media;
  const resources = [...images, ...audioSources].filter(image => image.src).map(image => {
    const ref = `media:${hash(image.src.startsWith('data:') ? image.src : (() => { try { return new URL(image.src).pathname; } catch { return image.src; } })())}`;
    return { resourceRef: ref, label: image.label ?? null };
  });
  return { ...base, media: { ...media, ...(media.type === 'voice' ? { sourceCount: resources.length } : { imageCount: resources.length }), resources } };
};

const corpus = [
  { id: 'dom-0', nativeId: 'n0', sender: 'incoming', kind: 'text', text: '在吗', order: 0, orderMode: 'relative', latestEndVerified: true },
  { id: 'dom-1', sender: 'outgoing', kind: 'text', text: '嗯嗯', order: 1, clientId: 'c-1' },
  { id: 'dom-2', order: 2, kind: 'text', text: '群里的', member: { nativeId: 'u1', name: '@阿甲' }, mentionedSelf: true },
  { id: 'dom-3', order: 3, kind: 'text', text: '匿名成员', member: { name: '无名' } },
  { id: 'dom-4', order: 4, kind: 'recalled', text: '撤回了一条消息' },
  { id: 'dom-5', order: 5, kind: 'shared-work', media: { type: 'shared-work', videoId: 'v9', title: '猫', images: [{ src: 'https://p3.douyinpic.com/a/b.jpg?sign=x', label: '封面' }], audioSources: [] } },
  { id: 'dom-6', order: 6, kind: 'voice', media: { type: 'voice', duration: 2, images: [{ src: 'https://h/cover.png' }], audioSources: [{ src: 'https://h/a.mp3' }, { src: 'https://h/b.mp3', label: '第二段' }] } },
  { id: 'dom-7', order: 7, kind: 'image', media: { type: 'image', images: [{ src: 'data:image/png;base64,AA==' }, { label: '无 src' }] } },
  { id: 'dom-8', order: 8, kind: 'emoji', media: { type: 'emoji', images: [] } },
  { id: 'dom-9', order: 9, kind: 'text', text: '带尾巴', member: { nativeId: 'u2', name: '' }, clientId: 'c-9', mentionedSelf: false, media: { type: 'image', images: [{ src: 'not a url' }] } },
];

test('R9 与重构前行内实现逐字节等价（10 组真实形态）', () => {
  for (const row of corpus) {
    const expected = legacyNormalize(recipientId, row);
    const actual = normalizePublicRow(recipientId, row).message;
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), `行 ${row.id} 与旧实现不一致`);
    assert.deepEqual(Object.keys(actual), Object.keys(expected), `行 ${row.id} 键序不一致`);
  }
});

test('R10 旧实现里 null/undefined 字段不会被新模块"补默认值"', () => {
  const row = { id: 'dom-x', order: 0, kind: 'text', text: null, sender: undefined };
  const actual = normalizePublicRow(recipientId, row).message;
  assert.equal(JSON.stringify(actual), JSON.stringify(legacyNormalize(recipientId, row)));
  assert.equal('text' in actual, true, '键存在但值为 null，与旧实现一致');
});
