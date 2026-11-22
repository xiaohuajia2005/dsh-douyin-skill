import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCommentText, isCommentContentRejection, COMMENT_CONTENT_REJECTED } from '../autonomous-comments.mjs';

// 内容不合规必须是"可跳过"的拒绝，不是运行故障；否则一句措辞就会终止整场观看。
const rejection = text => { try { validateCommentText(text); return null; } catch (error) { return error; } };

test('C1 合规评论原样通过，去首尾空白后返回', () => {
  assert.equal(validateCommentText('  这条三格小剧场太可爱了，从认真到得意的表情很戳人 '), '这条三格小剧场太可爱了，从认真到得意的表情很戳人');
  assert.equal(validateCommentText('第2格最好笑'), '第2格最好笑');
});

test('C2 @、链接、域名、长数字、联系方式类词都归为 contact 拒绝', () => {
  for (const text of ['@作者 太可爱了', '看这个 https://a.com/x', '去 www.abc.com 看', '详情见 abc.cn', '电话 138 0013 8000', '这个账号更新好勤', '好友分享的']) {
    const error = rejection(text);
    assert.ok(error, `夹具前提：「${text}」应当被拒绝`);
    assert.equal(error.rule, 'contact', `「${text}」应归为联系方式类`);
  }
});

test('C3 编造现实经历或作现实承诺归为 claim 拒绝', () => {
  for (const text of ['我保证一定会到场', '我亲自去过']) {
    const error = rejection(text);
    assert.ok(error, `夹具前提：「${text}」应当被拒绝`);
    assert.equal(error.rule, 'claim');
  }
});

test('C4 空文本、超长、控制字符归为 format 拒绝', () => {
  for (const text of ['', '   ', 'a'.repeat(201), '带\n换行']) {
    const error = rejection(text);
    assert.ok(error, `夹具前提：「${JSON.stringify(text.slice(0, 8))}」应当被拒绝`);
    assert.equal(error.rule, 'format');
  }
});

test('C5 所有内容拒绝都带统一 code、具体 rule 与 400 状态', () => {
  for (const text of ['@某人', '我保证一定到场', '']) {
    const error = rejection(text);
    assert.equal(error.code, COMMENT_CONTENT_REJECTED);
    assert.equal(error.status, 400);
    assert.ok(['contact', 'claim', 'format'].includes(error.rule));
    assert.equal(isCommentContentRejection(error), true);
  }
});

test('C6 只有内容拒绝可跳过，预算、发送锁等运行故障仍走原错误路径', () => {
  assert.equal(isCommentContentRejection(null), false);
  assert.equal(isCommentContentRejection(undefined), false);
  assert.equal(isCommentContentRejection(new Error('普通错误')), false);
  assert.equal(isCommentContentRejection(Object.assign(new Error('自主评论的每日或单轮次数已用完。'), { status: 409 })), false);
  assert.equal(isCommentContentRejection(Object.assign(new Error('另一个入口正在评论，或上次评论发送锁需要核对。'), { status: 409 })), false);
  assert.equal(isCommentContentRejection(Object.assign(new Error('没有找到当前入口对同一作品的真实观察，未评论。'), { status: 409 })), false);
  assert.equal(isCommentContentRejection({ code: COMMENT_CONTENT_REJECTED }), true);
});

test('C7 观看主循环把评论失败全部吞掉，连续不合规只暂停评论不停播', () => {
  const source = readFileSync(new URL('../autonomous-watch.mjs', import.meta.url), 'utf8');
  assert.match(source, /isCommentContentRejection\(error\)/, '内容拒绝必须单独识别，不能混进运行故障');
  assert.match(source, /this\.commentRejectStreak = \(this\.commentRejectStreak \|\| 0\) \+ 1;/, '需要计数以便暂停评论');
  assert.match(source, /this\.commentSuspended = true;/, '连续不合规应暂停评论');
  assert.doesNotMatch(source, /this\.commentRejectStreak >= 3\) throw failure/, '不应再因连续不合规停止整场观看');
  assert.doesNotMatch(source, /评论发布结果未确认，请在抖音核对，已停止自主观看/, '发布未确认也不该停播');
  assert.match(source, /this\.skipComment\('delivery-uncertain'/, '发布未确认只作废这一条评论');
  assert.match(source, /this\.commentRejectStreak = 0;/, '评论成功或重新开始时计数要归零');
});
