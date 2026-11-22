import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DailyReport } from '../daily-report.mjs';

function fixture(operations) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-'));
  const personaFolder = path.join(root, 'persona');
  fs.mkdirSync(personaFolder);
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, 'comments-ledger.json'), JSON.stringify({ version: 1, days: {}, sessions: {}, operations }));
  return { report: new DailyReport({
    personaMemory: { personaFolder, stateFile: path.join(personaFolder, 'shared-state.json') },
    stateDir,
    now: () => Date.parse('2026-11-22T12:00:00Z'),
  }), stateDir };
}

test('日报互动只收当天确认成功的公开评论', () => {
  const { report } = fixture([
    { day: '2026-11-22', videoId: '7000000000000000001', text: '这条画得好温柔', status: 'confirmed', commentId: 'c1', completedAt: '2026-11-22T07:30:00.000Z' },
    { day: '2026-11-22', videoId: '7000000000000000002', text: '没发出去的', status: 'not-sent', completedAt: '2026-11-22T07:40:00.000Z' },
    { day: '2026-11-21', videoId: '7000000000000000003', text: '昨天的', status: 'confirmed', completedAt: '2026-11-21T07:30:00.000Z' },
  ]);
  const interactions = report.interactions('2026-11-22');
  assert.equal(interactions.comments.length, 1);
  assert.deepEqual(interactions.comments[0], { videoId: '7000000000000000001', text: '这条画得好温柔', commentId: 'c1', at: '2026-11-22T07:30:00.000Z' });
});

test('日报互动把同一天多条成功评论按时间排好', () => {
  const { report } = fixture([
    { day: '2026-11-22', videoId: '7000000000000000001', text: '后发的', status: 'resolved-confirmed', completedAt: '2026-11-22T09:00:00.000Z' },
    { day: '2026-11-22', videoId: '7000000000000000002', text: '先发的', status: 'confirmed', completedAt: '2026-11-22T08:00:00.000Z' },
  ]);
  const interactions = report.interactions('2026-11-22');
  assert.deepEqual(interactions.comments.map(item => item.text), ['先发的', '后发的']);
});

test('没有评论记录时返回空列表，不影响其他互动计数', () => {
  const { report } = fixture([]);
  const interactions = report.interactions('2026-11-22');
  assert.deepEqual(interactions.comments, []);
  assert.equal(interactions.replies, 0);
  assert.equal(interactions.shares, 0);
});

test('日报互动统计当天评论跳过原因和改写次数', () => {
  const { report, stateDir } = fixture([]);
  fs.writeFileSync(path.join(stateDir, 'comment-events.jsonl'), [
    { at: '2026-11-22T07:00:00.000Z', rule: 'contact', message: 'x' },
    { at: '2026-11-22T08:00:00.000Z', rule: 'contact', message: 'x' },
    { at: '2026-11-22T09:00:00.000Z', rule: 'claim', message: 'x' },
    { at: '2026-11-22T10:00:00.000Z', rule: 'rewritten', message: 'x' },
    { at: '2026-11-21T10:00:00.000Z', rule: 'contact', message: 'x' },
  ].map(item => JSON.stringify(item)).join('\n') + '\n');
  const interactions = report.interactions('2026-11-22');
  assert.deepEqual(interactions.commentSkips, [{ rule: 'contact', count: 2 }, { rule: 'claim', count: 1 }]);
  assert.equal(interactions.rewrites, 1);
});
