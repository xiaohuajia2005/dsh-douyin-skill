import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { composerGuard, MANUAL_COMPOSER_REASONS } from '../chat/composer-guard.mjs';
import { readChatComposerDom } from '../chat-browser.mjs';

const source = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

// 一份「干净的输入框」状态，各用例在此基础上改一个字段。
const clean = (patch = {}) => ({ dialogOpen: true, editorCount: 1, draft: '', focused: false, pageFocused: false, attachments: 0, fileModal: 0, ...patch });

test('C1 空输入框不算人工在写', () => {
  assert.deepEqual(composerGuard(clean()).manual, false);
  assert.equal(composerGuard(clean()).reason, null);
});

test('C2 有草稿就跳过补答，reason=draft', () => {
  const result = composerGuard(clean({ draft: '我先回一句' }));
  assert.equal(result.manual, true);
  assert.equal(result.reason, MANUAL_COMPOSER_REASONS.DRAFT);
  assert.equal(result.detail.draftLength, 5);
});

test('C3 只由零宽字符组成的草稿不算人工输入', () => {
  assert.equal(composerGuard(clean({ draft: '\u200B\u200C\uFEFF' })).manual, false);
  assert.equal(composerGuard(clean({ draft: '  \n ' })).manual, false);
});

test('C4 输入框里有附件/文件弹窗时优先按 attachment 跳过', () => {
  assert.equal(composerGuard(clean({ attachments: 1, draft: '带图' })).reason, MANUAL_COMPOSER_REASONS.ATTACHMENT);
  assert.equal(composerGuard(clean({ fileModal: 1 })).reason, MANUAL_COMPOSER_REASONS.ATTACHMENT);
});

test('C5 有焦点且页面本身有系统焦点，算人正停在输入框里', () => {
  const result = composerGuard(clean({ focused: true, pageFocused: true }));
  assert.equal(result.manual, true);
  assert.equal(result.reason, MANUAL_COMPOSER_REASONS.FOCUS);
});

test('C6 只是焦点残留（页面在后台）不算人工在写——否则补答会被永久跳过', () => {
  // 上一次自动化发送用 fill() 聚焦过输入框，窗口最小化后 activeElement 仍可能是它。
  // 只看 focused 会把「自己的残留」当成「人在写」，这个用例专门锁死这个反例。
  assert.equal(composerGuard(clean({ focused: true, pageFocused: false })).manual, false);
  assert.equal(composerGuard(clean({ focused: false, pageFocused: true })).manual, false);
});

test('C7 输入框定位不到（数量不是 1）时不下判断，交给发送前的既有守卫', () => {
  for (const editorCount of [0, 2]) {
    const result = composerGuard(clean({ editorCount, draft: '有草稿也不算' }));
    assert.equal(result.manual, false, `editorCount=${editorCount}`);
    assert.equal(result.detail.readable, false);
  }
});

test('C8 判定结果里不带草稿正文（日志只记长度）', () => {
  const secret = '这是一句不该进日志的私信草稿';
  const result = composerGuard(clean({ draft: secret }));
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.detail.draftLength, [...secret].length);
});

test('C9 脏输入不抛异常（字段类型不对时宁可多跳一次，也不能崩）', () => {
  for (const value of [null, undefined, {}, 'x']) {
    assert.doesNotThrow(() => composerGuard(value));
    assert.equal(composerGuard(value).manual, false);
  }
  // 类型不对但值能读：按「有草稿」处理（方向是多跳过，绝不抢发）。
  const odd = () => composerGuard({ editorCount: '1', draft: 42, attachments: null });
  assert.doesNotThrow(odd);
  assert.equal(odd().manual, true);
  assert.equal(odd().detail.editorCount, 1);
});

test('C10 页内读取函数自包含：在裸 vm 里也能跑出结构（不引用模块作用域）', () => {
  const editor = {
    innerText: '\u200B 你好 ',
    textContent: '',
    getBoundingClientRect: () => ({ width: 320, height: 40 }),
    querySelectorAll: () => [],
    contains: node => node === editor,
  };
  const dialog = { querySelectorAll: () => [editor] };
  const context = vm.createContext({
    document: {
      querySelector: selector => selector === '[data-e2e="im-dialog"]' ? dialog : null,
      querySelectorAll: () => [],
      activeElement: editor,
      hasFocus: () => true,
      visibilityState: 'visible',
    },
  });
  const value = vm.runInNewContext(`(${readChatComposerDom.toString()})()`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), { dialogOpen: true, editorCount: 1, draft: '你好', focused: true, pageFocused: true, attachments: 0, fileModal: 0 });
});

test('C11 零尺寸输入框不算「定位到了唯一输入框」', () => {
  const hidden = { innerText: '草稿', getBoundingClientRect: () => ({ width: 0, height: 0 }), querySelectorAll: () => [], contains: () => false };
  const dialog = { querySelectorAll: () => [hidden] };
  const context = vm.createContext({ document: { querySelector: () => dialog, querySelectorAll: () => [], activeElement: null, hasFocus: () => false, visibilityState: 'visible' } });
  const value = vm.runInNewContext(`(${readChatComposerDom.toString()})()`, context);
  assert.equal(value.editorCount, 0);
  assert.equal(value.draft, '');
  assert.equal(value.focused, false);
});

test('C12 只读入口里没有任何输入/点击/按键原语，且显式禁止启动浏览器', () => {
  const text = source('chat-browser.mjs');
  const start = text.indexOf('readComposerState(recipientId');
  assert.ok(start > 0, '找不到 readComposerState');
  const body = text.slice(start, start + 1200);
  for (const forbidden of ['.click(', 'pressSequentially', 'keyboard', '.fill(', '.press(', 'mouse.', 'insertText', '.type(']) {
    assert.equal(body.includes(forbidden), false, `只读入口出现 ${forbidden}`);
  }
  assert.ok(body.includes('launch: !backgroundOnly, create: !backgroundOnly'), '必须沿用既有页面获取口径，不额外启动浏览器');
  assert.ok(body.includes('page.evaluate(readChatComposerDom)'), '必须只做一次页内只读求值');
});

test('C13 补答链路：先只读判定再占次数，发送前再查一次', () => {
  const text = source('chat-service.mjs');
  const eligible = text.indexOf('const eligible = this.catchUpEligible(contact, mark, messages);');
  const commit = text.indexOf('catchUpItem = this.catchUpCandidate(contact, mark, messages);');
  const preSend = text.indexOf("phase: 'before-send'");
  const deliver = text.indexOf('const delivered = await this.deliverReply(contact, mark, reply, latest, signal, latestSnapshot);');
  const generate = text.indexOf("phase: 'before-generate'");
  assert.ok(eligible > 0 && commit > eligible, '判定必须先于占用次数');
  assert.ok(generate > 0 && generate < commit, '生成前只在没有人工证据时才占用次数');
  assert.ok(preSend > 0 && deliver > preSend, '发送前必须再做一次检查');
  assert.equal(text.match(/chat\.catch_up_skipped_manual/g).length, 2, '两个跳过点都记同一个事件名');
});

test('C14 catchUpEligible 是纯判定：不改水位、不写日志', () => {
  const text = source('chat-service.mjs');
  const start = text.indexOf('catchUpEligible(contact, mark, messages) {');
  const body = text.slice(start, text.indexOf('catchUpCandidate(contact, mark, messages) {', start));
  assert.ok(body.length > 100, '切不出方法体');
  for (const forbidden of ['this.log(', 'mark.catchUp =', 'this.persist(', 'save(']) {
    assert.equal(body.includes(forbidden), false, `纯判定里出现了副作用 ${forbidden}`);
  }
});
