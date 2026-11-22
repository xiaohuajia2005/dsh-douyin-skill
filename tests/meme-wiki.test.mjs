import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_MEME_TERM_LENGTH, memeTermPattern, parseAliases, buildMemeIndex, matchMeme, MemeWiki,
} from '../meme-wiki.mjs';

const hit = (term, text) => { const pattern = memeTermPattern(term); return pattern ? pattern.test(text) : null; };

test('M1 短于 3 个字符的命中词不再参与匹配（「绝了」在「拒绝了解」里的误命中）', () => {
  assert.equal(MIN_MEME_TERM_LENGTH, 3);
  assert.equal(memeTermPattern('绝了'), null);
  assert.equal(hit('绝了', '拒绝了解'), null);
  assert.equal(hit('绝了', '太绝了吧'), null, '「绝了」本身不再命中：代价换精确，见 M10');
  const index = buildMemeIndex([{ title: '绝了', aliases: '["绝了"]' }]);
  assert.deepEqual(index, [], '只有短词、没有 3 字以上别名的词条会整条退出索引');
});

test('M2 中文词两侧紧邻汉字时不算命中（避免成为更长词的一部分）', () => {
  assert.equal(hit('你是我的神', '你是我的神明'), false);
  assert.equal(hit('你是我的神', '好家伙，你是我的神'), true);
  assert.equal(hit('显眼包', '超级显眼包子'), false);
  assert.equal(hit('显眼包', '纯纯显眼包！'), false, '前一个字是汉字就不命中，这是本轮定下的口径');
  assert.equal(hit('显眼包', '，显眼包'), true);
});

test('M3 英文与数字按词边界判定，不会命中更长的单词或数字串', () => {
  assert.equal(hit('emo', '这个emoji'), false);
  assert.equal(hit('emo', '我今天 emo 了'), true);
  assert.equal(hit('yyds', 'xyydsx'), false);
  assert.equal(hit('yyds', '这歌真的yyds'), true);
  assert.equal(hit('666', '6666'), false);
  assert.equal(hit('666', '打了把 666 的操作'), true);
});

test('M4 英文大小写不敏感（词库里常写成大写）', () => {
  assert.equal(hit('EMO', '我今天emo了'), true);
  assert.equal(hit('EMO', '我今天 emo 了'), true);
  assert.equal(hit('CP', '磕CP'), null, '2 个字符照样被长度门槛挡掉');
  assert.equal(hit('CPDD', 'cpdd 一下'), true);
});

test('M5 首尾字符类别不同的词按各自一侧卡边界', () => {
  assert.equal(hit('v我50', 'v我50块'), true, '词尾是数字，右侧只卡英数');
  assert.equal(hit('v我50', 'v我500'), false);
  assert.equal(hit('v我50', 'v我50'), true);
});

test('M6 正则特殊字符按字面量处理，不是通配', () => {
  assert.equal(hit('a.b', 'axb'), false);
  assert.equal(hit('a.b', '这是a.b'), true);
  assert.equal(hit('C++', '写C++的'), true);
  assert.equal(hit('C++', '写C#的'), false, '词尾是标点时右侧不卡边界，但字符本身仍然逐字比对');
});

test('M7 别名解析同时支持 JSON 数组与分隔符字符串', () => {
  assert.deepEqual(parseAliases('["显眼包","显眼包本包"]'), ['显眼包', '显眼包本包']);
  assert.deepEqual(parseAliases('显眼包、显眼包本包|小显眼包'), ['显眼包', '显眼包本包', '小显眼包']);
  assert.deepEqual(parseAliases(null), []);
  assert.deepEqual(parseAliases('   '), []);
  assert.deepEqual(parseAliases([' 显眼包 ', '']), ['显眼包']);
});

test('M8 索引去掉重复词与不可匹配词，保留仍能用长别名命中的短标题', () => {
  const index = buildMemeIndex([
    { title: '绝了', aliases: '["绝了","绝了绝了"]' },
    { title: 'emo', aliases: '["emo"]' },
    { title: '', aliases: '' },
  ]);
  assert.deepEqual(index.map(item => item.title), ['绝了', 'emo']);
  assert.deepEqual(index[0].matchers.map(item => item.term), ['绝了绝了'], '标题「绝了」太短被丢，长别名保留');
});

test('M9 命中按词长排序，长词优先，limit 生效', () => {
  const index = buildMemeIndex([
    { title: 'yyds', aliases: '[]' },
    { title: '显眼包本包', aliases: '[]' },
    { title: 'emo', aliases: '[]' },
  ]);
  const text = '显眼包本包！yyds，我emo了';
  assert.deepEqual(matchMeme(index, text).map(item => item.title), ['显眼包本包', 'yyds', 'emo']);
  assert.deepEqual(matchMeme(index, text, 2).map(item => item.title), ['显眼包本包', 'yyds']);
  assert.deepEqual(matchMeme(index, '一句都没有'), []);
  assert.deepEqual(matchMeme(index, ''), []);
  // 权重相同时按标题排序，保证同样的输入每次给出同样的顺序。
  const tied = buildMemeIndex([{ title: 'yyds', aliases: '[]' }, { title: '永远的神', aliases: '[]' }]);
  assert.deepEqual(matchMeme(tied, '永远的神！yyds').map(item => item.title), ['yyds', '永远的神']);
});

test('M10 词库里没有可匹配词条时 lookup 直接返回空，不碰数据库', () => {
  // 词库路径不存在 → failed，lookup 必须安静返回 []，不能抛。
  const wiki = new MemeWiki({ dbPath: 'Z:/definitely/not/here/memes.db' });
  assert.deepEqual(wiki.lookup('显眼包'), []);
  assert.deepEqual(wiki.lookup('绝了'), []);
  assert.equal(wiki.failed, true);
});
