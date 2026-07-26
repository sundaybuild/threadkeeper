/**
 * ThreadKeeper 脆存档 —— 内容脚本(ISOLATED)
 * 编排整件事：读历史 → 让页面脚本去抓 → 合并存档 → 生成文件 → 交给后台落盘。
 */
(() => {
  'use strict';

  const CHANNEL = 'THREADKEEPER';

  /**
   * 「收到的回复」这部分数据的版本。抓法改进（比如开始收嵌套回复）后要 +1：
   * 版本对不上时忽略回复数快照，强制把回复区整个重抓一遍，
   * 否则旧存档里那些不完整的记录会因为"回复数没变"被永远跳过。
   */
  const INCOMING_SCHEMA = 3;

  let panel = null;
  let hideTimer = null;
  let busy = false;

  function toPage(type, payload) {
    window.postMessage({ __channel: CHANNEL, dir: 'cs->page', type, payload }, '*');
  }

  // ---------- 浮层 ----------
  function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement('div');
    panel.id = 'threadkeeper-panel';
    Object.assign(panel.style, {
      position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483647',
      minWidth: '230px', maxWidth: '330px', padding: '14px 16px', borderRadius: '14px',
      background: 'rgba(20,20,22,0.94)', color: '#f5f5f5',
      font: '13px/1.5 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif',
      boxShadow: '0 8px 30px rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)',
      backdropFilter: 'blur(8px)', whiteSpace: 'pre-wrap', transition: 'opacity .25s',
    });
    (document.body || document.documentElement).appendChild(panel);
    return panel;
  }

  function show(html, opts) {
    const p = ensurePanel();
    p.innerHTML = html;
    p.style.opacity = '1';
    clearTimeout(hideTimer);
    if (opts && opts.autoHide) {
      hideTimer = setTimeout(() => {
        p.style.opacity = '0';
        setTimeout(() => p.remove(), 400);
      }, opts.autoHide);
    }
  }

  const title = (t) => `<div style="font-weight:600;margin-bottom:4px">${t}</div>`;

  // ---------- 工具 ----------
  function handleOf() {
    const m = location.pathname.match(/^\/@([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** 大字符串转 data URL：分块 btoa，避免参数过多爆栈 */
  function toDataUrl(str, mime) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return `data:${mime};base64,${btoa(bin)}`;
  }

  function extOf(url, fallback) {
    try {
      const p = new URL(url).pathname;
      const m = p.match(/\.([a-z0-9]{2,5})$/i);
      if (m) return m[1].toLowerCase();
    } catch (e) { /* noop */ }
    return fallback;
  }

  const store = {
    get(key) {
      return new Promise((r) => chrome.storage.local.get(key, (o) => r(o[key])));
    },
    set(key, val) {
      return new Promise((r) => chrome.storage.local.set({ [key]: val }, r));
    },
  };

  /** 合并新旧记录：同 id 用新的（互动数更新），旧的独有条目保留（可能已被删除，存档价值所在） */
  function mergeById(oldList, newList) {
    const map = new Map();
    (oldList || []).forEach((p) => map.set(p.id, p));
    (newList || []).forEach((p) => {
      const prev = map.get(p.id);
      // 这一轮没重抓回复区的帖子，把上次存下来的回复带过来，别弄丢
      if (prev && prev.incoming_replies && !p.incoming_replies) {
        map.set(p.id, Object.assign({}, p, {
          incoming_replies: prev.incoming_replies,
          incoming_replies_at: prev.incoming_replies_at,
        }));
      } else {
        map.set(p.id, p);
      }
    });
    return Array.from(map.values())
      .sort((a, b) => (b.posted_at_unix || 0) - (a.posted_at_unix || 0));
  }

  /**
   * 给每条媒体分配本地文件名，写进 local 字段；
   * 返回这次需要下载的清单（已经下过的跳过）。
   */
  function planMedia(items, alreadyDone) {
    const todo = [];
    const seen = new Set();

    for (const p of items) {
      const groups = [p].concat(p.continuation || []);
      for (const g of groups) {
        if (!g || !Array.isArray(g.media)) continue;
        g.media.forEach((m, idx) => {
          if (!m.url) return;
          const stem = `${g.code || g.id}-${idx + 1}`;
          const name = `${stem}.${extOf(m.url, m.type === 'video' ? 'mp4' : 'jpg')}`;
          m.local = `media/${name}`;
          if (!alreadyDone[m.url] && !seen.has(m.url)) {
            seen.add(m.url);
            todo.push({ url: m.url, name });
          }
          if (m.type === 'video' && m.poster) {
            const pname = `${stem}-poster.${extOf(m.poster, 'jpg')}`;
            m.poster_local = `media/${pname}`;
            if (!alreadyDone[m.poster] && !seen.has(m.poster)) {
              seen.add(m.poster);
              todo.push({ url: m.poster, name: pname });
            }
          }
        });
      }
    }
    return todo;
  }

  // ---------- 页面脚本回传 ----------
  let pending = null; // 本次导出的选项

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__channel !== CHANNEL || d.dir !== 'page->cs') return;

    switch (d.type) {
      case 'status':
        show(title('脆存档') + d.payload.text);
        break;
      case 'progress': {
        const p = d.payload;
        const where = p.total ? `（第 ${p.page} / ${p.total} 条）` : `（第 ${p.page} 页）`;
        const pace = p.pace > 1.2 ? `\n被限流了，已自动放慢到 ${p.pace.toFixed(1)} 倍` : '';
        show(title(`正在抓取${p.label}…`) + `已拿到 <b>${p.count}</b> 条${where}${pace}`);
        break;
      }
      case 'captured-postreplies':
        // 学会了「帖子回复区」怎么查，记下来，下次不用再让用户点开帖子
        store.set('tpl:postReplies', d.payload);
        break;
      case 'stale-postreplies':
        // 存下来的那份已经失效，清掉，免得下次继续拿它空跑
        chrome.storage.local.remove('tpl:postReplies');
        break;
      case 'warn':
        show(title('提醒') + d.payload.message);
        break;
      case 'error':
        busy = false;
        show(title('⚠️ 导出失败') + d.payload.message, { autoHide: 15000 });
        break;
      case 'result':
        await finish(d.payload);
        break;
      default:
        break;
    }
  });

  async function finish(res) {
    try {
      show(title('正在整理存档…') + '合并历史记录');

      const key = `archive:${res.handle}`;
      const prev = (await store.get(key)) || { posts: [], replies: [], media_done: {} };

      const posts = mergeById(prev.posts, res.posts);
      const replies = mergeById(prev.replies, res.replies);
      const mediaDone = prev.media_done || {};
      const replyCounts = prev.reply_counts || {};

      // 把这轮抓到的「别人的回复」贴回对应的帖子上
      if (res.incoming) {
        const byId = new Map(posts.map((p) => [p.id, p]));
        Object.keys(res.incoming).forEach((pid) => {
          const target = byId.get(pid);
          if (!target) return;
          target.incoming_replies = res.incoming[pid];
          target.incoming_replies_at = new Date().toISOString();
          replyCounts[pid] = target.reply_count; // 快照，下次靠它判断要不要重抓
        });
      }

      const all = posts.concat(replies);
      const todo = pending.includeMedia ? planMedia(all, mediaDone) : [];

      const payload = {
        account: `@${res.handle}`,
        profile_url: `https://www.threads.com/@${res.handle}`,
        exported_at: new Date().toISOString(),
        exported_by: 'ThreadKeeper 脆存档 v2.1.0',
        scope: [
          '原创主贴（已排除转发）',
          pending.includeReplies ? '自己的回复' : null,
          pending.includeIncoming ? '别人在我串文下的回复' : null,
        ].filter(Boolean).join(' + '),
        counts: {
          posts: posts.length,
          replies: replies.length,
          incoming_replies: posts.reduce((n, p) => n + ((p.incoming_replies || []).length), 0),
          new_this_run: (res.posts || []).length + (res.replies || []).length,
        },
        skipped_reposts: res.stats.skipped_reposts,
        posts,
        replies,
      };

      const files = [
        { name: 'posts.json', dataUrl: toDataUrl(JSON.stringify(payload, null, 2), 'application/json') },
      ];
      if (pending.includeHtml) {
        const html = buildArchiveHtml(payload); // 来自 archive-html.js
        files.push({ name: 'index.html', dataUrl: toDataUrl(html, 'text/html') });
      }

      // 先把这次的媒体登记进已下载表（失败的下次会重来一遍，代价只是重下）
      todo.forEach((m) => { mediaDone[m.url] = m.name; });
      await store.set(key, {
        posts, replies, media_done: mediaDone, reply_counts: replyCounts,
        // 只有这轮真抓过回复区，才算按新版本存过
        incoming_schema: res.incoming ? INCOMING_SCHEMA : (prev.incoming_schema || 0),
        updated_at: new Date().toISOString(),
      });

      show(title('正在写入文件…') +
        (todo.length ? `${todo.length} 个媒体文件排队中` : '生成存档文件'));

      chrome.runtime.sendMessage({
        channel: CHANNEL,
        type: 'archive',
        payload: { folder: res.handle, files, media: todo },
      });

      pending.summary = {
        posts: posts.length,
        replies: replies.length,
        incoming: payload.counts.incoming_replies,
        incomingStats: res.incomingStats,
        fresh: payload.counts.new_this_run,
        media: todo.length,
      };
    } catch (e) {
      busy = false;
      show(title('⚠️ 整理存档失败') + (e.message || String(e)), { autoHide: 15000 });
    }
  }

  // ---------- 后台回报 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.channel !== CHANNEL) return;

    if (msg.type === 'start') {
      if (busy) { sendResponse({ ok: false, reason: 'busy' }); return true; }
      begin(msg.payload || {});
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'archive-progress') {
      show(title('正在下载媒体…') +
        `${msg.payload.done} / ${msg.payload.total}` +
        (msg.payload.failed ? `（${msg.payload.failed} 个失败）` : ''));
    }

    if (msg.type === 'archive-done') {
      busy = false;
      const s = (pending && pending.summary) || {};
      let text = `共 ${s.posts || 0} 条串文`;
      if (s.replies) text += ` · ${s.replies} 条我的回复`;
      if (s.incoming) text += `\n收到的回复 ${s.incoming} 条`;
      if (s.incomingStats && s.incomingStats.failed) {
        text += `（${s.incomingStats.failed} 条帖子抓取失败）`;
      }
      if (s.incomingStats && s.incomingStats.empty) {
        text += `\n${s.incomingStats.empty} 条没拿到回复，多半是被限流`
          + `\n过一会儿再跑一次就能补上`;
      }
      text += `\n本次新增 ${s.fresh || 0} 条`;
      if (msg.payload.mediaOk) text += `\n媒体 ${msg.payload.mediaOk} 个`;
      if (msg.payload.mediaFail) text += `（${msg.payload.mediaFail} 个失败）`;
      text += `\n存到「下载/${msg.payload.folder}」`;
      show(title('✅ 存档完成') + text, { autoHide: 12000 });
    }

    if (msg.type === 'archive-error') {
      busy = false;
      show(title('⚠️ 写入失败') + msg.payload.message, { autoHide: 15000 });
    }
    return true;
  });

  // 给回归测试留的口子：正常运行时 __TK_TEST__ 未定义，这段不会执行
  if (typeof globalThis !== 'undefined' && globalThis.__TK_TEST__) {
    globalThis.__tk = { planMedia, mergeById, toDataUrl, extOf };
  }

  async function begin(opts) {
    busy = true;
    pending = Object.assign({
      includeReplies: false, includeIncoming: false,
      includeMedia: true, includeHtml: true, incremental: true,
    }, opts);

    const handle = handleOf();
    show(title('脆存档') + '准备中…');

    const prev = handle ? await store.get(`archive:${handle}`) : null;

    let knownIds = [];
    if (pending.incremental && prev) {
      knownIds = [].concat(
        (prev.posts || []).map((p) => p.id),
        (prev.replies || []).map((p) => p.id),
      );
    }

    const extra = {};
    if (pending.includeIncoming) {
      // 老帖也可能收到新回复，所以把历史帖子一起交上去
      extra.allPosts = (prev && prev.posts ? prev.posts : [])
        .map((p) => ({ id: p.id, code: p.code, reply_count: p.reply_count }));
      // 抓法升级过就别信旧快照，让它整个重抓一遍
      const schemaOk = prev && prev.incoming_schema === INCOMING_SCHEMA;
      extra.knownReplyCounts = (schemaOk && prev.reply_counts) || {};
      extra.postRepliesTemplate = await store.get('tpl:postReplies');
    }

    toPage('start', {
      includeReplies: pending.includeReplies,
      includeIncoming: pending.includeIncoming,
      knownIds,
      ...extra,
    });
  }
})();
