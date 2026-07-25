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
  return /RepliesTab/i.test(name) ? 'replies' : 'posts';
}

globalThis.fetch = async (url, init) => {
  const kind = whichKind(init.body);
  calls[kind] += 1;
  // 页面自己发的那次（after 还是模板里的原始值），不消耗测试数据页
  const vars = JSON.parse(new URLSearchParams(init.body).get('variables'));
  if (vars.after === 'X') return { ok: true, json: async () => ({}) };
  if (failNext) { failNext = false; throw new Error('模拟网络抖动'); }
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
  const body = new URLSearchParams({
    fb_dtsg: 'DTSG', lsd: 'LSD', doc_id: kind === 'replies' ? '222' : '111',
    fb_api_req_friendly_name: kind === 'replies'
      ? 'BarcelonaProfileRepliesTabRefetchableQuery'
      : 'BarcelonaProfileThreadsTabRefetchableQuery',
    variables: JSON.stringify({ after: 'X', before: null, first: 10, last: null, userID: '111' }),
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

// ---------- 汇总 ----------
let bad = 0;
for (const [name, ok] of checks) { console.log(ok ? `✅ ${name}` : `❌ ${name}`); if (!ok) bad += 1; }
console.log(`\n${bad === 0 ? `全部通过（${checks.length} 项）` : `${bad} 项失败`}`);
process.exit(bad ? 1 : 0);
