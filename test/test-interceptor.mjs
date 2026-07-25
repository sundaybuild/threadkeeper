// 在 node 里模拟页面环境，跑通 interceptor.js 的「捕获 → 翻页 → 解析」全流程
// 覆盖：主贴、回复上下文、自动切标签、增量停止、失败重试
import fs from 'node:fs';

const SRC = new URL('../interceptor.js', import.meta.url).pathname;
const CH = 'THREADKEEPER';

// ---------- 最小 DOM/window mock ----------
const listeners = {};
const win = {
  scrollY: 0,
  scrollTo() {}, scrollBy() {},
  addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
  postMessage(data) {
    queueMicrotask(() => (listeners.message || []).forEach((fn) => fn({ source: win, data })));
  },
};

let repliesTabClicked = 0;
const repliesLink = {
  getAttribute: (k) => (k === 'href' ? '/@example_user/replies' : null),
  click() { repliesTabClicked += 1; firePageRequest('replies'); },
};
const postsLink = {
  getAttribute: (k) => (k === 'href' ? '/@example_user' : null),
  click() {},
};

const doc = {
  body: { scrollHeight: 5000, appendChild() {} },
  querySelectorAll: () => [postsLink, repliesLink],
  createElement: () => ({ style: {}, click() {}, remove() {} }),
};

globalThis.window = win;
globalThis.document = doc;
globalThis.location = { pathname: '/@example_user' };
globalThis.XMLHttpRequest = class { open() {} setRequestHeader() {} send() {} };
globalThis.Headers = class { forEach() {} };
for (const k of ['addEventListener', 'postMessage']) globalThis[k] = win[k].bind(win);

// ---------- 假数据 ----------
function mkPost({ pk, code, text, at, user = 'example_user', media = null, repostOf = null }) {
  return {
    pk, code, taken_at: at, like_count: 3,
    caption: { text },
    user: { username: user, pk: '111' },
    text_post_app_info: {
      direct_reply_count: 2, repost_count: 1, reshare_count: 0,
      share_info: repostOf ? { reposted_post: { pk: repostOf } } : {},
    },
    ...(media === 'image' ? {
      image_versions2: { candidates: [{ url: 'https://cdn/small.jpg', width: 320 }, { url: 'https://cdn/big.jpg', width: 1080 }] },
      accessibility_caption: '一张照片',
    } : {}),
    ...(media === 'carousel' ? {
      carousel_media: [
        { image_versions2: { candidates: [{ url: 'https://cdn/c1.jpg', width: 1080 }] } },
        { video_versions: [{ url: 'https://cdn/c2.mp4', width: 720 }], image_versions2: { candidates: [{ url: 'https://cdn/c2.jpg', width: 640 }] } },
      ],
    } : {}),
  };
}

const conn = (edges, hasNext, cursor) => ({
  data: { mediaData: { edges, page_info: { has_next_page: hasNext, end_cursor: cursor } } },
});

const POST_PAGES = [
  conn([
    { node: { thread_items: [
      { post: mkPost({ pk: '1', code: 'AAA', text: '第一条', at: 1750000000, media: 'image' }) },
      { post: mkPost({ pk: '1b', code: 'AAB', text: '接续楼层', at: 1750000060 }) },
    ] } },
    { node: { thread_items: [{ post: mkPost({ pk: '2', code: 'BBB', text: '第二条', at: 1749000000, media: 'carousel' }) }] } },
    { node: { thread_items: [{ post: mkPost({ pk: '3', code: 'CCC', text: '转发别人的', at: 1748000000, user: 'someone_else' }) }] } },
  ], true, 'C1'),
  conn([
    { node: { thread_items: [{ post: mkPost({ pk: '4', code: 'DDD', text: '第三条', at: 1747000000 }) }] } },
    { node: { thread_items: [{ post: mkPost({ pk: '1', code: 'AAA', text: '重复应去重', at: 1750000000 }) }] } },
    { node: { thread_items: [{ post: mkPost({ pk: '5', code: 'EEE', text: '自己转发', at: 1746000000, repostOf: '999' }) }] } },
  ], true, 'C2'),
  conn([
    { node: { thread_items: [{ post: mkPost({ pk: '6', code: 'FFF', text: '第四条', at: 1745000000 }) }] } },
  ], false, null),
];

// 回复页：一整串对话，中间夹着自己的两条回复
const REPLY_PAGES = [
  conn([
    { node: { thread_items: [
      { post: mkPost({ pk: '90', code: 'XXX', text: '别人的原帖', at: 1749500000, user: 'someone_else' }) },
      { post: mkPost({ pk: '91', code: 'YYY', text: '我的回复一', at: 1749500100 }) },
      { post: mkPost({ pk: '92', code: 'ZZZ', text: '我的回复二', at: 1749500200 }) },
    ] } },
    { node: { thread_items: [
      { post: mkPost({ pk: '2', code: 'BBB', text: '这是我自己的主贴，不该重复算成回复', at: 1749000000 }) },
      { post: mkPost({ pk: '93', code: 'WWW', text: '我在自己贴下的回复', at: 1749000100 }) },
    ] } },
  ], false, null),
];

// ---------- fetch mock ----------
let postIdx = 0;
let replyIdx = 0;
const calls = { posts: 0, replies: 0 };
let failNext = false;

function whichKind(body) {
  const name = new URLSearchParams(body).get('fb_api_req_friendly_name') || '';
  if (/PostPage|DirectReplies/i.test(name)) return 'postReplies';
  return /RepliesTab/i.test(name) ? 'replies' : 'posts';
}

// 单帖回复区：记下每次请求的 variables，好断言 postID 有没有被正确替换
const SEED_PK = '9999999999999999999';
const SEED_CODE = 'SEEDCODE01';
const postReplyCalls = [];
let postRepliesFail = false;
let postRepliesEmpty = false;
// 回复区的一个 edge 是一整条对话分支：顶层回复下面还挂着子回复
const INCOMING_PAGE = conn([
  { node: { thread_items: [
    { post: mkPost({ pk: '500', code: 'R1', text: '别人的回复一', at: 1750001000, user: 'fan_a' }) },
    { post: mkPost({ pk: '502', code: 'R3', text: '回复的回复', at: 1750001500, user: 'fan_c' }) },
    { post: mkPost({ pk: '503', code: 'R4', text: '我在回复区的答复', at: 1750001800 }) },
  ] } },
  { node: { thread_items: [{ post: mkPost({ pk: '501', code: 'R2', text: '别人的回复二', at: 1750002000, user: 'fan_b' }) }] } },
  { node: { post: mkPost({ pk: '504', code: 'R5', text: '没有 thread_items 包装的', at: 1750002500, user: 'fan_d' }) } },
], false, null);

globalThis.fetch = async (url, init) => {
  const kind = whichKind(init.body);
  calls[kind] += 1;
  // 页面自己发的那次（after 还是模板里的原始值），不消耗测试数据页
  const vars = JSON.parse(new URLSearchParams(init.body).get('variables'));
  // 种子请求的标志：占位 ID 还没被 substituteIds 换掉
  if (vars.after === 'X' || vars.postID === SEED_PK) return { ok: true, json: async () => ({}) };
  if (failNext) { failNext = false; throw new Error('模拟网络抖动'); }
  if (kind === 'postReplies') {
    postReplyCalls.push(vars);
    if (postRepliesFail) throw new Error('查询已过期');
    // 被限流时的典型表现：HTTP 200、没有 errors，但回复列表是空的
    if (postRepliesEmpty) return { ok: true, json: async () => conn([], false, null) };
    return { ok: true, json: async () => INCOMING_PAGE };
  }
  const json = kind === 'replies'
    ? (REPLY_PAGES[replyIdx++] ?? REPLY_PAGES.at(-1))
    : (POST_PAGES[postIdx++] ?? POST_PAGES.at(-1));
  return { ok: true, json: async () => json };
};
win.fetch = globalThis.fetch;

// ---------- 加载被测脚本 ----------
eval(fs.readFileSync(SRC, 'utf8'));

/** 模拟页面自己发一次 GraphQL 请求，好让拦截器捕到模板 */
function firePageRequest(kind) {
  const NAMES = {
    posts: 'BarcelonaProfileThreadsTabRefetchableQuery',
    replies: 'BarcelonaProfileRepliesTabRefetchableQuery',
    postReplies: 'BarcelonaPostPageRefetchableDirectRepliesQuery',
  };
  const DOCS = { posts: '111', replies: '222', postReplies: '333' };
  // 单帖查询的 variables 里没有 userID，帖子标识可能是长数字 pk 也可能是 shortcode
  const vars = kind === 'postReplies'
    ? { postID: SEED_PK, shortcode: SEED_CODE, first: 10, after: null }
    : { after: 'X', before: null, first: 10, last: null, userID: '111' };
  const body = new URLSearchParams({
    fb_dtsg: 'DTSG', lsd: 'LSD', doc_id: DOCS[kind],
    fb_api_req_friendly_name: NAMES[kind],
    variables: JSON.stringify(vars),
  }).toString();
  window.fetch('https://www.threads.com/graphql/query', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fb-lsd': 'LSD' },
    body,
  }).catch(() => {});
}

// ---------- 跑一次导出 ----------
function runExport(payload) {
  return new Promise((resolve, reject) => {
    const evts = [];
    const onMsg = (ev) => {
      const d = ev.data;
      if (!d || d.__channel !== CH || d.dir !== 'page->cs') return;
      evts.push(d);
      if (d.type === 'result') resolve({ ...d.payload, events: evts });
      if (d.type === 'error') reject(new Error(d.payload.message));
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ __channel: CH, dir: 'cs->page', type: 'start', payload });
    setTimeout(() => reject(new Error('超时。事件流: ' + evts.map((e) => e.type).join(','))), 25000);
  });
}

const checks = [];
const ck = (name, ok) => checks.push([name, ok]);

// === 场景一：全量 + 回复 ===
firePageRequest('posts');          // 页面首屏请求，捕获主贴模板
await new Promise((r) => setTimeout(r, 50));
failNext = true;                   // 第一次翻页故意失败，验证重试

const r1 = await runExport({ includeReplies: true, knownIds: [] });
const byId = Object.fromEntries(r1.posts.map((p) => [p.id, p]));

ck('主贴 4 条(去重+去转发)', r1.posts.length === 4);
ck('跳过转发计数 2', r1.stats.skipped_reposts === 2);
ck('按时间倒序', r1.posts[0].id === '1' && r1.posts.at(-1).id === '6');
ck('正文', byId['1'].text === '第一条');
ck('帖子链接', byId['1'].url === 'https://www.threads.com/@example_user/post/AAA');
ck('图片取最大尺寸', byId['1'].media[0].url === 'https://cdn/big.jpg');
ck('接续楼层', byId['1'].continuation?.length === 1);
ck('轮播图+视频', byId['2'].media.length === 2 && byId['2'].media[1].type === 'video');
ck('主贴标记 kind=post', r1.posts.every((p) => p.kind === 'post'));
ck('失败自动重试', calls.posts === 5); // 1次捕获 + 1次失败 + 3页

ck('自动点了「回复」标签', repliesTabClicked === 1);
ck('抓到 3 条自己的回复', r1.replies.length === 3);
const rep = Object.fromEntries(r1.replies.map((p) => [p.id, p]));
ck('回复标记 kind=reply', r1.replies.every((p) => p.kind === 'reply'));
ck('回复带上下文(回复给谁)', rep['91'].in_reply_to?.username === 'someone_else');
ck('上下文含原文', rep['91'].in_reply_to?.text === '别人的原帖');
ck('同串第二条回复也归到同一上下文', rep['92'].in_reply_to?.username === 'someone_else');
ck('自己主贴不被重复算成回复', !rep['2'] && r1.replies.some((p) => p.id === '93'));
ck('自己贴下的回复无他人上下文', rep['93'].in_reply_to === null);

// === 场景二：增量 ===
postIdx = 0; replyIdx = 0;
const before = calls.posts;
const known = r1.posts.map((p) => p.id).concat(r1.replies.map((p) => p.id));
const r2 = await runExport({ includeReplies: false, knownIds: known });

ck('增量下没有新条目', r2.posts.length === 0);
ck('增量提前停止(没翻完 3 页)', calls.posts - before === 2);

// === 场景三：抓别人在我串文下的回复 ===
postIdx = 0; replyIdx = 0;
firePageRequest('postReplies');   // 模拟用户点开自己一条串文，加载了回复区
await new Promise((r) => setTimeout(r, 50));

const r3 = await runExport({
  includeReplies: false,
  includeIncoming: true,
  knownIds: [],
  // 帖子 1 上次抓时就是 2 条回复，没变过，应该跳过
  knownReplyCounts: { 1: 2 },
  // 历史里还有一条这次时间线上没出现的老帖，也该一并刷新
  allPosts: [{ id: '99', code: 'OLD', reply_count: 5 }],
});

ck('学会了单帖回复查询', r3.incomingStats != null);
ck('历史老帖也纳入抓取范围', r3.incomingStats.targets === 5);
ck('回复数没变的帖子被跳过', r3.incomingStats.skipped === 1);
ck('其余帖子都抓了', r3.incomingStats.fetched === 4 && r3.incomingStats.failed === 0);
ck('跳过的帖子没有发请求', !postReplyCalls.some((v) => v.postID === '1'));
ck('抓到的回复挂在对应帖子下', (r3.incoming['2'] || []).length === 5);
ck('老帖的回复也抓到了', !!r3.incoming['99']);
ck('回复内容正确', r3.incoming['2'][0].text === '别人的回复一');
ck('回复者是别人', r3.incoming['2'][0].username === 'fan_a');
ck('回复按时间正序(对话顺序)',
  r3.incoming['2'][0].posted_at_unix < r3.incoming['2'][1].posted_at_unix);

// 一个 edge 里的整条对话分支都要收，只取第一条会丢掉一大半
const texts2 = r3.incoming['2'].map((x) => x.text);
ck('嵌套的子回复没被丢掉', texts2.includes('回复的回复'));
ck('我在自己回复区的答复也收了', texts2.includes('我在回复区的答复'));
ck('没有 thread_items 包装的也能收', texts2.includes('没有 thread_items 包装的'));

// 模板里的占位 pk / shortcode 必须被换成目标帖子的
const call2 = postReplyCalls.find((v) => v.postID === '2');
ck('模板里的 postID 被替换', !!call2);
ck('模板里的 shortcode 也被替换', call2 && call2.shortcode === 'BBB');
ck('没有残留模板里的占位 ID',
  !postReplyCalls.some((v) => v.postID === SEED_PK || v.shortcode === SEED_CODE));
ck('回复区请求数 = 实际抓取的帖子数', postReplyCalls.length === 4);

// === 场景四：回复区查询失效时要熔断，不能空跑几百次 ===
postIdx = 0; replyIdx = 0;
postReplyCalls.length = 0;
postRepliesFail = true;

const r4 = await runExport({
  includeIncoming: true,
  knownIds: [],
  allPosts: [
    { id: '80', code: 'H1', reply_count: 1 }, { id: '81', code: 'H2', reply_count: 1 },
    { id: '82', code: 'H3', reply_count: 1 }, { id: '83', code: 'H4', reply_count: 1 },
  ],
});

ck('目标远多于失败上限', r4.incomingStats.targets >= 8);
ck('连续失败后中止', r4.incomingStats.aborted === true);
ck('恰好失败 3 次就停手', r4.incomingStats.failed === 3);
ck('熔断后不再发请求', postReplyCalls.length === 3);
ck('记下了中止原因', r4.incomingStats.abortReason === '查询已过期');
ck('标记了模板来源', r4.incomingStats.source === 'live');
ck('中止时给了提醒', r4.events.some((e) => e.type === 'warn'));
ck('偷听来的模板失效不清缓存', !r4.events.some((e) => e.type === 'stale-postreplies'));
ck('回复区挂了不影响主贴照常导出', r4.posts.length === 4);

postRepliesFail = false;

// === 场景五：被限流时返回空列表，绝不能覆盖上次抓到的数据 ===
postIdx = 0; replyIdx = 0;
postReplyCalls.length = 0;
postRepliesEmpty = true;

const r5 = await runExport({
  includeIncoming: true,
  knownIds: [],
  // 只留一条帖子当目标，其余用回复数快照跳过，省得测试空等退避
  knownReplyCounts: { 1: 2, 4: 2, 6: 2 },
});

ck('空列表计入 empty', r5.incomingStats.empty === 1);
ck('空列表不算抓取成功', r5.incomingStats.fetched === 0);
ck('空列表不算失败，也不熔断',
  r5.incomingStats.failed === 0 && r5.incomingStats.aborted === false);
ck('空结果不写进结果集(不会覆盖上次抓到的回复)',
  Object.keys(r5.incoming).length === 0);
ck('确实发过请求(不是被跳过)', postReplyCalls.length === 1);

postRepliesEmpty = false;

// ---------- 汇总 ----------
let bad = 0;
for (const [name, ok] of checks) { console.log(ok ? `✅ ${name}` : `❌ ${name}`); if (!ok) bad += 1; }
console.log(`\n${bad === 0 ? `全部通过（${checks.length} 项）` : `${bad} 项失败`}`);
process.exit(bad ? 1 : 0);
