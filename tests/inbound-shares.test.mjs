import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AutonomousShare } from '../autonomous-share.mjs';
import { InboundShareLog, inboundVideoId, readInboundShares, inboundShareOf, inboundReceipts, INBOUND_SHARE_WINDOW_MS } from '../inbound-shares.mjs';

// 一条入站分享卡片最少需要的字段：作品编号可核实、身份不冲突。
const hex = n => createHash('sha256').update(String(n)).digest('hex');
const contact = (n, { isGroup = false } = {}) => { const own = hex(`conv-${n}`); return { id: `conv:${own}`, name: `好友${n}`, isGroup, identityVerified: true, identityVersion: 2, identityKind: isGroup ? 'rendered-group' : 'rendered-user', identityHash: own, identityBinding: `binding:${hex(`binding-${n}`)}`, authorizationKind: isGroup ? 'existing-group' : 'existing-conversation', relationshipStatus: 'unavailable', followed: null, verifiedAt: '2026-11-01T00:00:00.000Z' }; };
const card = (id, videoId, extra = {}) => ({ id, sender: 'incoming', text: '', media: { type: 'shared-work', videoId, url: videoId ? `https://www.douyin.com/video/${videoId}` : null }, ...extra });
const messageId = n => `msg:${hex(`msg-${n}`)}`;
const evidenceId = `video:${hex('evidence')}`;
const BASE = Date.parse('2026-11-22T09:00:00.000Z');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inbound-'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

function fixture({ inbound = [], shareable = [1, 2], now = BASE } = {}) {
  const dir = tempDir();
  writeJson(path.join(dir, 'share-policy.json'), { version: 1, enabled: true, dailyLimit: null });
  writeJson(path.join(dir, 'share-ledger.json'), { version: 1, days: {}, operations: [] });
  writeJson(path.join(dir, 'friend-interactions-policy.json'), { version: 1, enabled: true });
  writeJson(path.join(dir, 'chat-policy.json'), { version: 1, enabled: true, allowlist: shareable.map(n => contact(n)), dailyReplyLimit: null });
  if (inbound.length) writeJson(path.join(dir, 'chat-inbound-shares.json'), { version: 1, items: inbound });
  const observations = [{ id: evidenceId, videoId: '7000000000000000001', url: 'https://www.douyin.com/video/7000000000000000001', sources: ['api'], privacy: 'internal-reference', visibility: 'account-visible-unverified' }];
  const share = new AutonomousShare({
    personaMemory: { snapshot: () => ({ recentObservations: observations }) },
    videoLimits: { state: () => ({ allowed: true, session: { id: 'session-1', status: 'active' } }) },
    stateDir: dir, source: 'api', now: () => now,
  });
  return { dir, share, observations };
}

test('入站卡片只从可核实字段取作品编号', () => {
  assert.equal(inboundVideoId({ type: 'shared-work', videoId: '7000000000000000001', url: 'https://www.douyin.com/video/7000000000000000001' }), '7000000000000000001');
  // 只有公开链接时也从链接取。
  assert.equal(inboundVideoId({ type: 'shared-work', videoId: null, url: 'https://www.douyin.com/video/7000000000000000002' }), '7000000000000000002');
  // 编号与链接互相矛盾，或明确标了身份冲突：宁可不判重复。
  assert.equal(inboundVideoId({ type: 'shared-work', videoId: '7000000000000000001', url: 'https://www.douyin.com/video/7000000000000000003' }), null);
  assert.equal(inboundVideoId({ type: 'shared-work', videoId: '7000000000000000001', identityConflict: true }), null);
  assert.equal(inboundVideoId({ type: 'image' }), null);
});

test('只记对方发来的作品卡片', () => {
  const dir = tempDir(), log = new InboundShareLog({ stateDir: dir, now: () => BASE }), friend = contact(1);
  const disabled = new InboundShareLog({ stateDir: dir, now: () => BASE });
  assert.equal(disabled.record(friend, [
    card(messageId(1), '7000000000000000001'),
    { ...card(messageId(2), '7000000000000000002'), sender: 'outgoing' },
    { ...card(messageId(3), '7000000000000000003'), kind: 'recalled' },
    { id: messageId(4), sender: 'incoming', text: '', media: { type: 'image' } },
    card(messageId(5), '7000000000000000004', { media: { type: 'shared-work', videoId: '7000000000000000004', identityConflict: true } }),
  ]), 1);
  const data = readInboundShares(dir);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].videoId, '7000000000000000001');
  assert.equal(data.items[0].recipientId, friend.id);
  assert.equal(data.items[0].messageId, messageId(1));
  // 同一个对象同一条作品重复出现不再新增，也不会把时间往后挪。
  assert.equal(log.record(friend, [card(messageId(6), '7000000000000000001')]), 0);
  assert.equal(readInboundShares(dir).items[0].messageId, messageId(1));
});

test('查得到时返回入站凭据，查不到或过期返回 null', () => {
  const dir = tempDir(), friend = contact(2);
  const log = new InboundShareLog({ stateDir: dir, now: () => BASE });
  log.record(friend, [card(messageId(1), '7000000000000000009')]);
  assert.deepEqual(inboundShareOf(dir, { recipientId: friend.id, videoId: '7000000000000000009', now: BASE }), { recipientId: friend.id, videoId: '7000000000000000009', messageId: messageId(1), at: new Date(BASE).toISOString() });
  assert.equal(inboundShareOf(dir, { recipientId: friend.id, videoId: '7000000000000000010', now: BASE }), null);
  assert.equal(inboundShareOf(dir, { recipientId: contact(3).id, videoId: '7000000000000000009', now: BASE }), null);
  // 三十天以外的不再算「刚发过来的」，不能永久禁止回发。
  assert.equal(inboundShareOf(dir, { recipientId: friend.id, videoId: '7000000000000000009', now: BASE + INBOUND_SHARE_WINDOW_MS + 1 }), null);
  assert.equal(inboundReceipts(dir, { videoId: '7000000000000000009', now: BASE }).length, 1);
  assert.deepEqual(inboundReceipts(dir, { videoId: '7000000000000000009', now: BASE + INBOUND_SHARE_WINDOW_MS + 1 }), []);
});

test('记录损坏只当作没有记录，不影响分享与观看', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'chat-inbound-shares.json'), '{不是 JSON');
  assert.deepEqual(readInboundShares(dir), { version: 1, items: [] });
  assert.equal(inboundShareOf(dir, { recipientId: contact(1).id, videoId: '7000000000000000001', now: BASE }), null);
  assert.deepEqual(inboundReceipts(dir, { videoId: '7000000000000000001', now: BASE }), []);
});

test('分享上下文把「谁发过这条」限定在许可对象内', () => {
  const friend = contact(1), other = contact(2);
  const { share } = fixture({ inbound: [
    { recipientId: friend.id, isGroup: false, videoId: '7000000000000000001', messageId: messageId(1), at: new Date(BASE - 3600_000).toISOString() },
    { recipientId: other.id, isGroup: false, videoId: '7000000000000000001', messageId: messageId(2), at: new Date(BASE - INBOUND_SHARE_WINDOW_MS - 3600_000).toISOString() },
  ] });
  const context = share.context({ videoId: '7000000000000000001' });
  assert.deepEqual(context.receivedRecipients, [{ recipientId: friend.id, at: new Date(BASE - 3600_000).toISOString() }]);
  // 没有作品编号时不给任何入站线索。
  assert.deepEqual(share.context({}).receivedRecipients, []);
});

test('对方发来的作品不再回发，也不写账本', async () => {
  const friend = contact(1);
  const { dir, share } = fixture({ inbound: [{ recipientId: friend.id, isGroup: false, videoId: '7000000000000000001', messageId: messageId(1), at: new Date(BASE - 60_000).toISOString() }] });
  let sent = 0;
  share.send = async () => { sent++; return { confirmed: true, deliveryType: 'native-card', videoId: '7000000000000000001', messageId: 'msg-out', operationId: 'op-1' }; };
  const receipt = await share.share({ evidenceId, videoId: '7000000000000000001', recipientId: friend.id });
  assert.equal(sent, 0, '入站过的对象不应该再发送');
  assert.equal(receipt.status, 'skipped');
  assert.equal(receipt.code, 'SHARE_ALREADY_RECEIVED');
  assert.equal(receipt.skipped, true);
  assert.equal(receipt.confirmed, false);
  assert.equal(receipt.deliveryUncertain, false);
  assert.equal(receipt.videoId, '7000000000000000001');
  assert.equal(receipt.recipientId, friend.id);
  assert.equal(receipt.inbound.messageId, messageId(1));
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'share-ledger.json'), 'utf8'));
  assert.deepEqual(ledger.operations, []);
  assert.deepEqual(ledger.days, {});
});

test('别的对象发来的不影响这条分享', async () => {
  const friend = contact(1);
  const { dir, share } = fixture({ inbound: [{ recipientId: contact(2).id, isGroup: false, videoId: '7000000000000000001', messageId: messageId(1), at: new Date(BASE - 60_000).toISOString() }] });
  share.send = async (input, { authorize }) => {
    const proof = { videoId: input.expectedVideoId, recipientId: input.recipientId };
    authorize({ phase: 'prepare', ...proof });
    authorize({ phase: 'before-click', ...proof });
    // 真实转发器在点击前后各调用一次，输入结束后必须释放共同锁，宿主才能写回执。
    const release = authorize.beginDispatch(); release();
    return { confirmed: true, deliveryType: 'native-card', videoId: input.expectedVideoId, messageId: 'msg-out', operationId: 'op-stub' };
  };
  const receipt = await share.share({ evidenceId, videoId: '7000000000000000001', recipientId: friend.id });
  assert.equal(receipt.confirmed, true);
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'share-ledger.json'), 'utf8'));
  assert.equal(ledger.operations.length, 1);
  assert.equal(ledger.operations[0].status, 'confirmed');
});

test('入站记录超过窗口后允许再分享', async () => {
  const friend = contact(1);
  const { share } = fixture({ now: BASE + INBOUND_SHARE_WINDOW_MS + 86400_000, inbound: [{ recipientId: friend.id, isGroup: false, videoId: '7000000000000000001', messageId: messageId(1), at: new Date(BASE).toISOString() }] });
  let sent = 0;
  share.send = async (input, { authorize }) => {
    sent++; const proof = { videoId: input.expectedVideoId, recipientId: input.recipientId };
    authorize({ phase: 'prepare', ...proof }); authorize({ phase: 'before-click', ...proof });
    const release = authorize.beginDispatch(); release();
    return { confirmed: true, deliveryType: 'native-card', videoId: input.expectedVideoId, messageId: 'msg-out', operationId: 'op-stub' };
  };
  const receipt = await share.share({ evidenceId, videoId: '7000000000000000001', recipientId: friend.id });
  assert.equal(sent, 1);
  assert.equal(receipt.confirmed, true);
});

test('群聊里别人发过的作品也不回发', async () => {
  const group = contact(9, { isGroup: true });
  const { share } = fixture({ shareable: [], inbound: [{ recipientId: group.id, isGroup: true, videoId: '7000000000000000001', messageId: messageId(1), at: new Date(BASE - 60_000).toISOString() }] });
  // 群也要进许可名单才能被选为收件人。
  writeJson(path.join(share.stateDir, 'chat-policy.json'), { version: 1, enabled: true, allowlist: [group], dailyReplyLimit: null });
  let sent = 0;
  share.send = async () => { sent++; return { confirmed: true, deliveryType: 'native-card', videoId: '7000000000000000001', messageId: 'msg-out', operationId: 'op-1' }; };
  const receipt = await share.share({ evidenceId, videoId: '7000000000000000001', recipientId: group.id });
  assert.equal(sent, 0);
  assert.equal(receipt.code, 'SHARE_ALREADY_RECEIVED');
});

test('补记历史卡片沿用消息自身时间，不从补记时刻重算窗口', () => {
  const dir = tempDir(), friend = contact(4), log = new InboundShareLog({ stateDir: dir, now: () => BASE });
  // 一个月内收到的历史卡片：按它当时的时间记录，仍能挡住回发。
  log.record(friend, [{ ...card(messageId(1), '7000000000000000021'), sentAt: '2026-11-10T00:00:00.000Z' }]);
  assert.equal(readInboundShares(dir).items[0].at, '2026-11-10T00:00:00.000Z');
  assert.ok(inboundShareOf(dir, { recipientId: friend.id, videoId: '7000000000000000021', now: BASE }));
  // 超过三十天才补记到的旧卡片：写入真实时间，读取时按窗口过滤，不会因为补记而多锁一个月。
  log.record(friend, [{ ...card(messageId(2), '7000000000000000022'), sentAt: '2026-10-01T00:00:00.000Z' }]);
  assert.equal(readInboundShares(dir).items[1].at, '2026-10-01T00:00:00.000Z');
  assert.equal(inboundShareOf(dir, { recipientId: friend.id, videoId: '7000000000000000022', now: BASE }), null);
});
