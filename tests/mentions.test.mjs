// 群聊提及判定（迭代 18）。
// 判错的代价不对称：漏判只是少回一句，误判会在群里对无关发言插嘴。
// 所以这里只认"昵称确实出现在正文里"，不做任何模糊匹配。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMentionNames, groupMessageAddressesFish } from '../evidence/mentions.mjs';

test('M1 不传参数时用默认昵称', () => {
  assert.deepEqual(normalizeMentionNames(), ['大肥鱼']);
});

test('M2 NFKC 归一：全角字母与数字变成半角', () => {
  assert.deepEqual(normalizeMentionNames(['ＡＢＣ１２３']), ['ABC123']);
});

test('M3 去掉零宽字符（含 BOM 与方向控制符）', () => {
  assert.deepEqual(normalizeMentionNames(['大\u200B肥\u200E鱼\uFEFF']), ['大肥鱼']);
});

test('M4 去掉前缀 @ 与首尾空白，保留中间空格', () => {
  assert.deepEqual(normalizeMentionNames(['  @小鱼  ', '@@甲']), ['小鱼', '@甲'], '只去一层 @，剩下的由合法性检查兜住');
  assert.deepEqual(normalizeMentionNames(['大 肥 鱼']), ['大 肥 鱼']);
});

test('M5 归一后去重', () => {
  assert.deepEqual(normalizeMentionNames(['小鱼', '@小鱼', ' 小鱼 ']), ['小鱼']);
});

test('M6 数量与长度上限：1–10 个、每个不超过 40 字', () => {
  assert.throws(() => normalizeMentionNames([]), /群聊响应昵称须填写1至10个/);
  assert.throws(() => normalizeMentionNames('小鱼'), /群聊响应昵称须填写1至10个/);
  assert.throws(() => normalizeMentionNames(Array.from({ length: 11 }, (_, i) => `鱼${i}`)), /群聊响应昵称须填写1至10个/);
  assert.throws(() => normalizeMentionNames(['鱼'.repeat(41)]), /群聊响应昵称须填写1至10个/);
  assert.deepEqual(normalizeMentionNames(['鱼'.repeat(40)]), ['鱼'.repeat(40)], '正好 40 字通过');
  assert.throws(() => normalizeMentionNames([123]), /群聊响应昵称须填写1至10个/);
});

test('M7 控制字符与空白昵称被拒绝', () => {
  assert.throws(() => normalizeMentionNames(['小\n鱼']), /群聊响应昵称须填写1至10个/);
  assert.throws(() => normalizeMentionNames(['小\0鱼']), /群聊响应昵称须填写1至10个/);
  assert.throws(() => normalizeMentionNames(['   ']), /群聊响应昵称须填写1至10个/);
});

test('M8 只剩 @ 或归一后为空的昵称被拒绝', () => {
  assert.throws(() => normalizeMentionNames(['@']), /不能为空或只填 @/);
  assert.throws(() => normalizeMentionNames(['@@@']), /不能为空或只填 @/);
});

test('M9 页面已标 mentionedSelf 时直接算叫到我们', () => {
  assert.equal(groupMessageAddressesFish({ mentionedSelf: true, text: '随便说点什么' }), true);
});

test('M10 正文包含昵称就算叫到，大小写与全角不敏感', () => {
  assert.equal(groupMessageAddressesFish({ text: '大肥鱼今天在吗' }), true);
  assert.equal(groupMessageAddressesFish({ text: '今天大肥鱼来了吗' }), true);
  assert.equal(groupMessageAddressesFish({ text: '在吗' }, ['大肥鱼']), false);
  assert.equal(groupMessageAddressesFish({ text: 'ＦＩＳＨ 你好' }, ['Fish']), true, '全角正文 + 半角昵称也能命中');
  assert.equal(groupMessageAddressesFish({ text: 'FISH' }, ['fish']), true, '大小写不敏感');
});

test('M11 自定义昵称列表生效，且列表本身要合法', () => {
  assert.equal(groupMessageAddressesFish({ text: '小鱼小虾' }, ['小鱼', '小虾']), true);
  assert.equal(groupMessageAddressesFish({ text: '小鱼小虾' }, ['阿甲']), false);
  assert.throws(() => groupMessageAddressesFish({ text: '小鱼' }, []), /群聊响应昵称须填写1至10个/, '非法列表在判定时就会抛错，不会静默降级');
});

test('M12 空消息或缺失正文不崩，也不误判', () => {
  assert.equal(groupMessageAddressesFish({}), false);
  assert.equal(groupMessageAddressesFish(null), false);
  assert.equal(groupMessageAddressesFish({ text: null }), false);
  assert.equal(groupMessageAddressesFish({ text: '   ' }), false);
});
