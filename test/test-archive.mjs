// 测 content.js 的合并/媒体规划逻辑，以及 archive-html.js 生成的离线存档页
import fs from 'node:fs';

const CS = new URL('../content.js', import.meta.url).pathname;
const HTML = new URL('../archive-html.js', import.meta.url).pathname;

// ---------- mock ----------
const listeners = {};
globalThis.window = {
  addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
  postMessage() {},
};
globalThis.document = {
  body: { appendChild() {}, contains: () => true },
  documentElement: { appendChild() {} },
  createElement: () => ({ style: {}, remove() {} }),
};
globalThis.location = { pathname: '/@example_user' };
globalThis.chrome = {
  storage: { local: { get(k, cb) { cb({}); }, set(o, cb) { cb && cb(); } } },
  runtime: { onMessage: { addListener() {} }, sendMessage() {} },
};
globalThis.__TK_TEST__ = true;

eval(fs.readFileSync(HTML, 'utf8') + '\n;globalThis.buildArchiveHtml = buildArchiveHtml;');
eval(fs.readFileSync(CS, 'utf8'));

const {
  planMedia, mergeById, extOf, toDataUrl, knownCountsFor, INCOMING_SCHEMA,
} = globalThis.__tk;

const checks = [];
const ck = (name, ok) => checks.push([name, ok]);

// ---------- mergeById ----------
{
  const oldList = [
    { id: '1', text: '旧的一', like_count: 5, posted_at_unix: 100 },
    { id: '2', text: '已删除的帖子', posted_at_unix: 90 },
  ];
  const newList = [
    { id: '1', text: '旧的一', like_count: 42, posted_at_unix: 100 },
    { id: '3', text: '新帖', posted_at_unix: 300 },
  ];
  const merged = mergeById(oldList, newList);
  ck('合并后条数正确', merged.length === 3);
  ck('同 id 用新数据(点赞数更新)', merged.find((p) => p.id === '1').like_count === 42);
  ck('历史独有条目保留(已删帖仍在存档里)', !!merged.find((p) => p.id === '2'));
  ck('合并后按时间倒序', merged[0].id === '3' && merged.at(-1).id === '2');
}

// ---------- extOf ----------
{
  ck('从带 query 的 CDN 链接取扩展名',
    extOf('https://scontent.cdninstagram.com/v/t51/123_n.jpg?stp=dst-jpg&_nc_ht=x&oe=68A', 'bin') === 'jpg');
  ck('取不到扩展名时用兜底', extOf('https://cdn.example/abc?x=1', 'mp4') === 'mp4');
  ck('视频扩展名', extOf('https://cdn/v/abc.mp4?a=1', 'jpg') === 'mp4');
}

// ---------- planMedia ----------
{
  const items = [
    {
      id: '1', code: 'AAA',
      media: [
        { type: 'image', url: 'https://cdn/a.jpg?sig=1' },
        { type: 'video', url: 'https://cdn/b.mp4?sig=2', poster: 'https://cdn/b.jpg?sig=3' },
      ],
      continuation: [
        { id: '1b', code: 'AAB', media: [{ type: 'image', url: 'https://cdn/c.webp?sig=4' }] },
      ],
    },
    { id: '2', code: 'BBB', media: [{ type: 'image', url: 'https://cdn/dup.jpg' }] },
    { id: '3', code: 'CCC', media: [{ type: 'image', url: 'https://cdn/old.jpg' }] },
  ];
  const done = { 'https://cdn/old.jpg': 'CCC-1.jpg' }; // 上次已经下过

  const todo = planMedia(items, done);
  const names = todo.map((t) => t.name);

  ck('图片本地路径已写入', items[0].media[0].local === 'media/AAA-1.jpg');
  ck('视频本地路径已写入', items[0].media[1].local === 'media/AAA-2.mp4');
  ck('视频封面单独命名', items[0].media[1].poster_local === 'media/AAA-2-poster.jpg');
  ck('接续楼层的媒体也规划了', items[0].continuation[0].media[0].local === 'media/AAB-1.webp');
  ck('已下载过的不重复排队', !names.some((n) => n === 'CCC-1.jpg'));
  ck('已下载过的仍写了本地路径', items[2].media[0].local === 'media/CCC-1.jpg');
  ck('待下载数量正确', todo.length === 5);
  ck('文件名无重复', new Set(names).size === names.length);
}

// ---------- toDataUrl ----------
{
  const url = toDataUrl('中文测试 hello', 'application/json');
  ck('data URL 前缀正确', url.startsWith('data:application/json;base64,'));
  const decoded = Buffer.from(url.split(',')[1], 'base64').toString('utf8');
  ck('中文往返无损', decoded === '中文测试 hello');
  // 大字符串不能爆栈
  const big = '啊'.repeat(300000);
  const bigUrl = toDataUrl(big, 'text/plain');
  ck('大文本编码不爆栈',
    Buffer.from(bigUrl.split(',')[1], 'base64').toString('utf8').length === big.length);
}

// ---------- buildArchiveHtml ----------
{
  const data = {
    account: '@example_user',
    exported_at: '2026-07-26T02:00:00.000Z',
    posts: [
      {
        id: '1', code: 'AAA', kind: 'post', posted_at: '2026-07-20T10:00:00.000Z',
        posted_at_unix: 1753005600,
        text: '正常一条 https://example.com 带链接',
        like_count: 10, reply_count: 2, repost_count: 1,
        media: [{ type: 'image', url: 'https://cdn/a.jpg', local: 'media/AAA-1.jpg', alt: '图' }],
        url: 'https://www.threads.com/@example_user/post/AAA',
        incoming_replies: [
          { id: '900', username: 'fan_a', text: '第一个回复我的人', posted_at: '2026-07-20T11:00:00.000Z', posted_at_unix: 1753009200, media: [] },
          { id: '901', username: 'fan_b', text: '独有关键词蜂蜜柚子', posted_at: '2026-07-20T12:00:00.000Z', posted_at_unix: 1753012800, media: [] },
        ],
        incoming_replies_at: '2026-07-26T02:00:00.000Z',
      },
      {
        id: '2', code: 'BBB', kind: 'post', posted_at: '2026-07-19T10:00:00.000Z',
        posted_at_unix: 1752919200,
        text: '危险内容 </script><img src=x onerror=alert(1)> 结束',
        media: [],
      },
    ],
    replies: [
      {
        id: '3', code: 'CCC', kind: 'reply', posted_at: '2026-07-18T10:00:00.000Z',
        posted_at_unix: 1752832800,
        text: '我的回复',
        in_reply_to: { username: 'someone_else', text: '别人说的话', url: 'https://x/y' },
        media: [],
      },
    ],
  };

  const html = buildArchiveHtml(data);

  ck('产出完整 HTML 文档', html.startsWith('<!DOCTYPE html>') && html.trim().endsWith('</html>'));
  ck('标题含账号', html.includes('@example_user'));
  ck('没有外部资源引用(自包含)',
    !/(src|href)\s*=\s*["']https?:\/\/(?!www\.threads\.com)/.test(
      html.replace(/<script id="data"[\s\S]*?<\/script>/, '')));

  // 取出内嵌数据，模拟浏览器里的 JSON.parse
  const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
  ck('内嵌数据块存在且未被正文截断', !!m);

  let parsed = null;
  try { parsed = JSON.parse(m[1]); } catch (e) { /* 留空 */ }
  ck('内嵌 JSON 可正常解析', !!parsed);
  ck('串文和回复都进了存档页', parsed && parsed.items.length === 3);
  ck('按时间倒序合并', parsed && parsed.items[0].id === '1' && parsed.items[2].id === '3');
  ck('危险正文原样保留(数据无损)',
    parsed && parsed.items.find((p) => p.id === '2').text.includes('</script>'));
  ck('危险正文在源码里被转义(没有裸的 </script>)',
    !m[1].includes('</script>') && m[1].includes('\\u003c/script'));
  ck('媒体走本地相对路径', parsed && parsed.items[0].media[0].local === 'media/AAA-1.jpg');
  ck('回复上下文带过去了',
    parsed && parsed.items.find((p) => p.id === '3').in_reply_to.username === 'someone_else');
  ck('普通空格没被破坏', parsed && parsed.items[0].text.includes('正常一条 https://example.com 带链接'));

  // 别人给我的回复
  const withReplies = parsed && parsed.items.find((p) => p.id === '1');
  ck('收到的回复进了存档页', withReplies && withReplies.incoming_replies.length === 2);
  ck('回复者用户名保留', withReplies && withReplies.incoming_replies[0].username === 'fan_a');
  ck('回复按对话顺序',
    withReplies && withReplies.incoming_replies[0].posted_at_unix
      < withReplies.incoming_replies[1].posted_at_unix);
  ck('页面有折叠回复的结构', html.includes('details class="replies"'));
  ck('搜索逻辑覆盖了收到的回复', html.includes('incoming_replies||[]'));
}

// ---------- mergeById 不能弄丢已抓的回复 ----------
{
  const oldList = [{ id: '1', posted_at_unix: 100, incoming_replies: [{ id: 'r1', text: '旧回复' }], incoming_replies_at: '2026-07-01T00:00:00.000Z' }];
  const newList = [{ id: '1', posted_at_unix: 100, like_count: 99 }]; // 这轮没重抓回复区
  const merged = mergeById(oldList, newList);
  ck('没重抓回复区时保留上次的回复', merged[0].incoming_replies?.length === 1);
  ck('同时仍采用新的互动数据', merged[0].like_count === 99);
  ck('保留上次抓取时间', merged[0].incoming_replies_at === '2026-07-01T00:00:00.000Z');

  const fresh = mergeById(oldList, [{ id: '1', posted_at_unix: 100, incoming_replies: [{ id: 'r1' }, { id: 'r2' }] }]);
  ck('这轮抓到新回复时以新的为准', fresh[0].incoming_replies.length === 2);
}

// ---------- 该跳过哪些串文的回复区 ----------
{
  ck('没有历史时不跳过任何串文', Object.keys(knownCountsFor(null)).length === 0);

  const cur = {
    incoming_schema: INCOMING_SCHEMA,
    reply_counts: { 1: 5, 2: 3 },
    posts: [{ id: '1', reply_count: 5 }, { id: '2', reply_count: 3 }],
  };
  ck('版本一致时沿用回复数快照',
    JSON.stringify(knownCountsFor(cur)) === JSON.stringify({ 1: 5, 2: 3 }));

  // 抓法升级过：只该补还没拿到回复的，已经抓到的别再抓一遍
  const old = {
    incoming_schema: 0,
    reply_counts: { 1: 5, 2: 3, 3: 7 },
    posts: [
      { id: '1', reply_count: 5, incoming_replies: [{ id: 'a' }, { id: 'b' }] }, // 有数据
      { id: '2', reply_count: 3, incoming_replies: [] },                          // 上次被限流清空
      { id: '3', reply_count: 7 },                                                // 从没抓过
    ],
  };
  const got = knownCountsFor(old);
  ck('升级后已抓到内容的仍跳过', got['1'] === 5);
  ck('升级后空数组的要重抓', !('2' in got));
  ck('升级后没抓过的要重抓', !('3' in got));
  ck('升级后不会无差别全部重抓', Object.keys(got).length === 1);
}

// ---------- 汇总 ----------
let bad = 0;
for (const [name, ok] of checks) { console.log(ok ? `✅ ${name}` : `❌ ${name}`); if (!ok) bad += 1; }
console.log(`\n${bad === 0 ? `全部通过（${checks.length} 项）` : `${bad} 项失败`}`);
process.exit(bad ? 1 : 0);
