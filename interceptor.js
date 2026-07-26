/**
 * ThreadKeeper 脆存档 —— 页面世界(MAIN)脚本
 *
 * 思路：不写死 doc_id（Meta 会随版本变动），而是先"偷听"页面自己发出的
 * 主页 GraphQL 请求，把它当成模板，再由我们带着 cursor 反复重放，
 * 一页一页把整个账号的内容拉完。
 *
 * 只负责抓取和解析，抓完把数据交给 content.js，由它去落盘。
 */
(() => {
  'use strict';

  const TAG = '[脆存档]';
  const CHANNEL = 'THREADKEEPER';

  function emit(type, payload) {
    window.postMessage({ __channel: CHANNEL, dir: 'page->cs', type, payload }, '*');
  }

  // ---------- 请求模板捕获 ----------
  const GQL_RE = /\/(graphql\/query|api\/graphql)/;
  const KIND_RE = {
    posts: /ProfileThreadsTab/i,   // BarcelonaProfileThreadsTabQuery
    replies: /ProfileRepliesTab/i, // BarcelonaProfileRepliesTabQuery
    // 单帖的回复区：BarcelonaPostPageQuery / …DirectRepliesQuery
    postReplies: /PostPage|DirectReplies/i,
  };

  /** @type {{posts: object|null, replies: object|null, postReplies: object|null}} */
  const templates = { posts: null, replies: null, postReplies: null };

  function normalizeHeaders(h) {
    const out = {};
    if (!h) return out;
    if (typeof Headers !== 'undefined' && h instanceof Headers) {
      h.forEach((v, k) => { out[k] = v; });
    } else if (Array.isArray(h)) {
      h.forEach(([k, v]) => { out[k] = v; });
    } else if (typeof h === 'object') {
      Object.keys(h).forEach((k) => { out[k] = h[k]; });
    }
    return out;
  }

  function bodyToString(body) {
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    return null;
  }

  function considerRequest(url, headers, body) {
    try {
      if (!GQL_RE.test(String(url))) return;
      const raw = bodyToString(body);
      if (!raw || raw.indexOf('doc_id=') === -1) return;

      const params = new URLSearchParams(raw);
      const name = params.get('fb_api_req_friendly_name') || '';
      const kind = Object.keys(KIND_RE).find((k) => KIND_RE[k].test(name));
      if (!kind) return;

      const varsRaw = params.get('variables');
      if (!varsRaw) return;
      const vars = JSON.parse(varsRaw);
      if (!vars) return;

      if (kind === 'postReplies') {
        // 单帖回复区：只留 doc_id 和 variables 形状。请求头和 token 到时候
        // 借主页模板的最新那份用，免得这里存下来的 token 放久了失效。
        templates.postReplies = { doc_id: params.get('doc_id'), name, variables: vars, at: Date.now() };
        emit('captured-postreplies', { doc_id: params.get('doc_id'), name, variables: vars });
        console.log(TAG, '已捕获单帖回复模板:', name);
        return;
      }

      // 主页时间线必须带 userID，借此排除单帖/推荐流
      if (vars.userID == null && vars.user_id == null && vars.userId == null) return;

      templates[kind] = {
        url: String(url),
        headers: normalizeHeaders(headers),
        body: raw,
        name,
        handle: currentHandle(),
        at: Date.now(),
      };
      emit('captured', { kind, name });
      console.log(TAG, `已捕获${kind === 'posts' ? '串文' : '回复'}模板:`, name);
    } catch (e) {
      /* 捕获失败不影响页面 */
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (init && init.body) {
        considerRequest(url, init.headers || (input && input.headers), init.body);
      }
    } catch (e) { /* noop */ }
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__tk_url = url;
    this.__tk_headers = {};
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (this.__tk_headers) this.__tk_headers[k] = v; } catch (e) { /* noop */ }
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try { considerRequest(this.__tk_url, this.__tk_headers, body); } catch (e) { /* noop */ }
    return origSend.apply(this, arguments);
  };

  // ---------- 响应解析 ----------
  function findConnections(root) {
    const found = [];
    const seen = new Set();
    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 14) return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node.edges)) {
        found.push({ edges: node.edges, pageInfo: node.page_info || node.pageInfo || null });
      }
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') walk(v, depth + 1);
      }
    })(root, 0);
    return found;
  }

  function pickMainConnection(json) {
    const conns = findConnections(json);
    if (!conns.length) return null;
    conns.sort((a, b) => (b.edges.length - a.edges.length) || ((b.pageInfo ? 1 : 0) - (a.pageInfo ? 1 : 0)));
    return conns[0];
  }

  function readPageInfo(pi) {
    if (!pi) return { hasNext: false, cursor: null };
    const hasNext = pi.has_next_page != null ? !!pi.has_next_page : !!pi.hasNextPage;
    const cursor = pi.end_cursor != null ? pi.end_cursor : (pi.endCursor != null ? pi.endCursor : null);
    return { hasNext, cursor };
  }

  // ---------- 帖子字段提取 ----------
  function bestUrl(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    const sorted = candidates.slice().sort((a, b) => (b.width || 0) - (a.width || 0));
    return sorted[0] && sorted[0].url ? sorted[0].url : null;
  }

  function collectMedia(post) {
    const media = [];
    const pushImage = (p) => {
      const u = bestUrl(p && p.image_versions2 && p.image_versions2.candidates);
      if (u) media.push({ type: 'image', url: u, alt: p.accessibility_caption || null });
    };
    const pushVideo = (p) => {
      const vs = p && p.video_versions;
      if (Array.isArray(vs) && vs.length) {
        const v = vs.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
        if (v && v.url) {
          media.push({
            type: 'video',
            url: v.url,
            poster: bestUrl(p.image_versions2 && p.image_versions2.candidates),
          });
        }
      }
    };

    if (Array.isArray(post.carousel_media) && post.carousel_media.length) {
      post.carousel_media.forEach((m) => {
        if (Array.isArray(m.video_versions) && m.video_versions.length) pushVideo(m);
        else pushImage(m);
      });
    } else if (Array.isArray(post.video_versions) && post.video_versions.length) {
      pushVideo(post);
    } else if (post.image_versions2) {
      pushImage(post);
    }
    return media;
  }

  function linkPreview(post) {
    const a = post.text_post_app_info && post.text_post_app_info.link_preview_attachment;
    if (!a) return null;
    return {
      url: a.url || null,
      title: a.title || null,
      site: a.display_url || null,
      image: a.image_url || null,
    };
  }

  function normalizePost(post) {
    if (!post) return null;
    const info = post.text_post_app_info || {};
    const user = post.user || {};
    const code = post.code || null;
    const username = user.username || null;
    return {
      id: String(post.pk || post.id || ''),
      code,
      url: code && username ? `https://www.threads.com/@${username}/post/${code}` : null,
      username,
      posted_at: post.taken_at ? new Date(post.taken_at * 1000).toISOString() : null,
      posted_at_unix: post.taken_at || null,
      text: (post.caption && post.caption.text) || '',
      like_count: post.like_count != null ? post.like_count : null,
      reply_count: info.direct_reply_count != null ? info.direct_reply_count : null,
      repost_count: info.repost_count != null ? info.repost_count : null,
      quote_count: info.reshare_count != null ? info.reshare_count : null,
      media: collectMedia(post),
      link_preview: linkPreview(post),
      is_paid_partnership: !!post.is_paid_partnership,
      has_audio: post.has_audio != null ? post.has_audio : null,
    };
  }

  function isRepostOfOthers(post, ownerUsername) {
    if (!post) return true;
    const share = (post.text_post_app_info || {}).share_info || {};
    if (share.reposted_post) return true;
    const u = post.user && post.user.username;
    return !!(ownerUsername && u && u.toLowerCase() !== ownerUsername.toLowerCase());
  }

  function isMine(post, handle) {
    const u = post && post.user && post.user.username;
    return !!(u && handle && u.toLowerCase() === handle.toLowerCase());
  }

  // ---------- 抓取 ----------
  let running = false;

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function currentHandle() {
    const m = location.pathname.match(/^\/@([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function templateUsable(kind) {
    const t = templates[kind];
    if (!t) return false;
    // 模板必须来自当前这个账号，避免把别人的时间线导出来
    return !!t.handle && t.handle === currentHandle();
  }

  /** 点一下主页上的标签，诱使页面自己发请求 */
  function clickTab(kind) {
    const handle = currentHandle();
    if (!handle) return false;
    const want = kind === 'replies'
      ? new RegExp(`^/@${handle}/replies/?$`)
      : new RegExp(`^/@${handle}/?$`);
    const links = Array.from(document.querySelectorAll('a[href]'));
    const hit = links.find((a) => want.test(a.getAttribute('href') || ''));
    if (hit) { hit.click(); return true; }
    return false;
  }

  /** 想办法让页面发出 kind 对应的请求：切标签 + 滚动 */
  async function ensureTemplate(kind, timeoutMs) {
    if (templateUsable(kind)) return true;

    clickTab(kind);
    const deadline = Date.now() + timeoutMs;
    const startY = window.scrollY;

    while (Date.now() < deadline) {
      if (templateUsable(kind)) { window.scrollTo(0, startY); return true; }
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(700);
      if (templateUsable(kind)) { window.scrollTo(0, startY); return true; }
      window.scrollBy(0, -400);
      await sleep(500);
    }
    window.scrollTo(0, startY);
    return templateUsable(kind);
  }

  function buildBody(kind, cursor) {
    const params = new URLSearchParams(templates[kind].body);
    const vars = JSON.parse(params.get('variables'));

    if ('before' in vars) vars.before = null;
    if ('last' in vars) vars.last = null;
    vars.first = vars.first || 25;

    if ('cursor' in vars && !('after' in vars)) vars.cursor = cursor;
    else vars.after = cursor;

    params.set('variables', JSON.stringify(vars));
    return params.toString();
  }

  async function fetchPage(kind, cursor) {
    const headers = Object.assign({}, templates[kind].headers);
    headers['content-type'] = 'application/x-www-form-urlencoded';
    delete headers['content-length'];

    const res = await origFetch.call(window, templates[kind].url, {
      method: 'POST',
      headers,
      body: buildBody(kind, cursor),
      credentials: 'include',
      mode: 'cors',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.errors && json.errors.length) {
      throw new Error(json.errors[0].message || 'GraphQL 返回错误');
    }
    return json;
  }

  const MAX_PAGES = 600;

  /**
   * 逐页抓取。
   * @param {'posts'|'replies'} kind
   * @param {(edges:Array, out:Array)=>number} harvestPage 处理一页，返回本页新增条数
   */
  async function paginate(kind, harvestPage, out, label) {
    let cursor = null;
    let page = 0;

    while (page < MAX_PAGES) {
      page += 1;

      let json = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          json = await fetchPage(kind, cursor);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          emit('status', { text: `${label}第 ${page} 页失败(${e.message})，重试中…` });
          await sleep(attempt * 1500);
        }
      }
      if (lastErr) throw new Error(`${label}第 ${page} 页反复失败：${lastErr.message}`);

      const conn = pickMainConnection(json);
      if (!conn) break;

      const added = harvestPage(conn.edges, out);
      emit('progress', { label, page, count: out.length });

      // 增量模式：整页都是已经存过的，说明追上了，收工
      if (added === 0 && page > 1) break;

      const { hasNext, cursor: next } = readPageInfo(conn.pageInfo);
      if (!hasNext || !next || next === cursor) break;
      cursor = next;
      await sleep(650);
    }
    return out;
  }

  // ---------- 单帖回复区 ----------
  const MAX_REPLY_PAGES = 5;

  /**
   * 这里刻意不预置任何 doc_id。
   *
   * 内置一份能让扩展开箱即用，代价是把 Meta 的内部查询 ID 明文写进仓库；
   * 而且它会随 Meta 发版失效，反倒变成一个需要不断跟着改的东西。
   * 所以查询格式一律现学：用户点开一条自己的串文时顺手学会，
   * 存进 storage，一个账号只需要这一次。
   *
   * 优先级：本次偷听到的 > 上次学会存下来的。
   */

  /** 连续这么多条帖子都抓失败，就认为查询已经失效，别再空转 */
  const FAIL_STREAK_LIMIT = 3;

  /**
   * 连续这么多条都拿到空回复就收手。
   *
   * 退让是给偶发限流用的；真被持续限流时，等多久都还是空，
   * 而退让又让每条越等越久，跑完几百条要十几分钟且颗粒无收。
   * 所以宁可早停让用户过会儿再来，也别在这儿耗着。
   *
   * 但阈值不能太小：回复被作者删光的串文本来就会返回空，若恰好有几条
   * 挨在一起，小阈值会把它们误判成限流，白白放弃后面几百条。
   * 取 10 条，并把退让上限压低，免得判定期本身就要等很久。
   */
  const EMPTY_STREAK_LIMIT = 10;

  /**
   * 把模板 variables 里的帖子标识换成目标帖子的。
   * 字段名各版本不一样，所以既按常见名替换，也按值的长相（纯数字长串=pk，
   * 混合短串=shortcode）兜底。
   */
  function substituteIds(vars, post) {
    const clone = JSON.parse(JSON.stringify(vars));
    const isPk = (v) => typeof v === 'string' && /^\d{15,}$/.test(v);
    const isCode = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,20}$/.test(v) && !/^\d+$/.test(v);

    for (const k of Object.keys(clone)) {
      if (isPk(clone[k])) clone[k] = String(post.id);
      else if (isCode(clone[k]) && post.code) clone[k] = post.code;
    }
    ['postID', 'post_id', 'postId', 'mediaID', 'media_id'].forEach((k) => {
      if (k in clone) clone[k] = String(post.id);
    });
    ['code', 'shortcode', 'postCode'].forEach((k) => {
      if (k in clone && post.code) clone[k] = post.code;
    });
    return clone;
  }

  async function fetchPostReplies(post, cursor) {
    const base = templates.posts; // 借主页模板的 url / 请求头 / token
    const params = new URLSearchParams(base.body);
    params.set('doc_id', templates.postReplies.doc_id);
    params.set('fb_api_req_friendly_name', templates.postReplies.name);

    const vars = substituteIds(templates.postReplies.variables, post);
    vars.first = vars.first || 25;
    if ('cursor' in vars && !('after' in vars)) vars.cursor = cursor;
    else vars.after = cursor;
    params.set('variables', JSON.stringify(vars));

    const headers = Object.assign({}, base.headers);
    headers['content-type'] = 'application/x-www-form-urlencoded';
    delete headers['content-length'];

    const res = await origFetch.call(window, base.url, {
      method: 'POST', headers, body: params.toString(),
      credentials: 'include', mode: 'cors',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.errors && json.errors.length) {
      throw new Error(json.errors[0].message || 'GraphQL 返回错误');
    }
    return json;
  }

  /**
   * 逐条抓帖子的回复区。
   * @param {Array<{id:string, code:string, reply_count:number}>} targets
   * @param {Object<string,number>|null} knownCounts 上次抓时各帖的回复数
   * @returns {{map:Object, stats:Object}}
   */
  async function harvestIncoming(targets, knownCounts) {
    const map = {};
    const emptyIds = [];
    const stats = {
      targets: targets.length, fetched: 0, skipped: 0, failed: 0, replies: 0,
      empty: 0, aborted: false, abortReason: null,
    };
    let failStreak = 0;
    let emptyStreak = 0;

    for (let i = 0; i < targets.length; i += 1) {
      const post = targets[i];

      // 回复数跟上次一样，说明没人新回复，不用再拉一遍
      if (knownCounts && knownCounts[post.id] === post.reply_count) {
        stats.skipped += 1;
        continue;
      }

      const got = [];
      const seen = new Set();
      let cursor = null;

      try {
        for (let page = 0; page < MAX_REPLY_PAGES; page += 1) {
          const json = await fetchPostReplies(post, cursor);
          const conn = pickMainConnection(json);
          if (!conn) break;

          let added = 0;
          for (const edge of conn.edges) {
            const node = (edge && edge.node) || edge;
            if (!node) continue;
            // 一个 edge 是一整条对话分支：thread_items 里除了顶层回复，
            // 还挂着它下面的子回复，全都要收。
            const items = Array.isArray(node.thread_items) && node.thread_items.length
              ? node.thread_items
              : (node.post ? [{ post: node.post }] : []);

            for (const it of items) {
              const rp = it && it.post;
              if (!rp) continue;
              const rec = normalizePost(rp);
              if (!rec || !rec.id || rec.id === post.id || seen.has(rec.id)) continue;
              seen.add(rec.id);
              delete rec.continuation;
              got.push(rec);
              added += 1;
            }
          }

          const { hasNext, cursor: next } = readPageInfo(conn.pageInfo);
          if (!hasNext || !next || next === cursor || added === 0) break;
          cursor = next;
          await sleep(650);
        }

        if (got.length) {
          got.sort((a, b) => (a.posted_at_unix || 0) - (b.posted_at_unix || 0));
          map[post.id] = got;
          stats.fetched += 1;
          stats.replies += got.length;
          emptyStreak = 0;
        } else {
          // 抓到 0 条：可能真的没有回复，也可能是被限流了，两者分不出来。
          // 所以干脆不写进 map —— 既不会覆盖上次辛苦抓到的，
          // 也不会更新回复数快照，下次还会再来一遍。
          stats.empty += 1;
          emptyIds.push(post.id);
          emptyStreak += 1;
          if (emptyStreak === 3) {
            // 这轮抓成功过、然后突然连着空，才像是被限流；
            // 一上来就全是空的，更可能是这些串文的回复本来就取不到（已删除等）
            emit('status', {
              text: stats.fetched > 0
                ? '连着几条没拿到回复，像是被限流了，正在自动放慢…'
                : '这几条串文的回复区返回是空的（回复可能已被删除），继续…',
            });
          }
          // 一直空下去就别耗着了：退让会越等越久，再跑几百条也是白跑
          if (emptyStreak >= EMPTY_STREAK_LIMIT) {
            stats.aborted = true;
            stats.throttled = true;
            stats.abortReason = `连续 ${emptyStreak} 条都没拿到回复`;
            break;
          }
        }
        failStreak = 0;
      } catch (e) {
        stats.failed += 1;
        failStreak += 1;
        // 一连几条都失败，多半是查询本身过期了，别再白跑几百次
        if (failStreak >= FAIL_STREAK_LIMIT) {
          stats.aborted = true;
          stats.abortReason = e && e.message ? e.message : String(e);
          break;
        }
      }

      emit('progress', {
        label: '帖子回复', page: i + 1, total: targets.length, count: stats.replies,
      });
      // 这一项要连着发几百个请求，间隔给得比时间线宽一点
      await sleep(900);
    }
    return { map, stats, emptyIds };
  }

  async function run(opts) {
    if (running) return;
    running = true;

    const options = opts || {};
    const known = new Set(options.knownIds || []);
    const handle = currentHandle();

    try {
      if (!handle) {
        throw new Error('请先打开某个账号的主页（网址形如 threads.com/@用户名）再导出。');
      }

      const stats = { skipped_reposts: 0, already_known: 0 };

      // ===== 主贴 =====
      emit('status', { text: '正在等待页面发出数据请求…' });
      if (!await ensureTemplate('posts', 20000)) {
        throw new Error('没能捕获到串文数据请求。请在主页上点一下「回复」标签、再点回「串文」，然后重新导出。');
      }

      const posts = [];
      const postIds = new Set();

      await paginate('posts', (edges, out) => {
        let added = 0;
        for (const edge of edges) {
          const node = (edge && edge.node) || edge;
          if (!node) continue;
          const items = Array.isArray(node.thread_items) ? node.thread_items : [];
          const rootPost = items.length ? items[0].post : node.post;
          if (!rootPost) continue;

          if (isRepostOfOthers(rootPost, handle)) { stats.skipped_reposts += 1; continue; }

          const rec = normalizePost(rootPost);
          if (!rec || !rec.id || postIds.has(rec.id)) continue;
          postIds.add(rec.id);

          if (known.has(rec.id)) { stats.already_known += 1; continue; }

          if (items.length > 1) {
            const cont = items.slice(1)
              .map((it) => normalizePost(it && it.post))
              .filter((p) => p && p.username && p.username.toLowerCase() === handle.toLowerCase());
            if (cont.length) rec.continuation = cont;
          }
          rec.kind = 'post';
          out.push(rec);
          added += 1;
        }
        return added;
      }, posts, '串文');

      // ===== 回复 =====
      const replies = [];
      if (options.includeReplies) {
        emit('status', { text: '正在切到「回复」标签…' });
        if (!await ensureTemplate('replies', 20000)) {
          emit('warn', { message: '没能捕获到回复数据请求，本次跳过回复。请手动点一下「回复」标签后重试。' });
        } else {
          const replyIds = new Set();
          await paginate('replies', (edges, out) => {
            let added = 0;
            for (const edge of edges) {
              const node = (edge && edge.node) || edge;
              if (!node) continue;
              const items = Array.isArray(node.thread_items) ? node.thread_items : [];
              if (!items.length) continue;

              // 一个 edge 是一整串对话，挑出其中属于自己的楼层
              for (let i = 0; i < items.length; i += 1) {
                const p = items[i] && items[i].post;
                if (!p || !isMine(p, handle)) continue;

                const rec = normalizePost(p);
                if (!rec || !rec.id) continue;
                if (postIds.has(rec.id) || replyIds.has(rec.id)) continue;
                replyIds.add(rec.id);
                if (known.has(rec.id)) { stats.already_known += 1; continue; }

                // 往前找最近的一条别人的楼层，作为"回复给谁"
                let ctx = null;
                for (let j = i - 1; j >= 0; j -= 1) {
                  const prev = items[j] && items[j].post;
                  if (prev && !isMine(prev, handle)) {
                    const pu = prev.user && prev.user.username;
                    ctx = {
                      username: pu || null,
                      text: ((prev.caption && prev.caption.text) || '').slice(0, 280),
                      url: prev.code && pu ? `https://www.threads.com/@${pu}/post/${prev.code}` : null,
                    };
                    break;
                  }
                }
                rec.kind = 'reply';
                rec.in_reply_to = ctx;
                out.push(rec);
                added += 1;
              }
            }
            return added;
          }, replies, '回复');
        }
      }

      // ===== 别人在我串文下的回复 =====
      let incoming = null;
      if (options.includeIncoming) {
        // 优先用这次偷听到的，其次是上次学会存下来的
        let source = 'live';
        if (!templates.postReplies && options.postRepliesTemplate) {
          templates.postReplies = options.postRepliesTemplate;
          source = 'saved';
        }
        if (!templates.postReplies) {
          emit('warn', {
            message: '还没学会「帖子回复区」的查询格式，这次先跳过。请随便点开自己的一条串文（让回复区加载一次），再回主页重新存档。',
          });
        } else {
          // 历史帖子也要一起刷，因为老帖同样会有新回复
          const byId = new Map();
          posts.forEach((p) => byId.set(p.id, { id: p.id, code: p.code, reply_count: p.reply_count }));
          (options.allPosts || []).forEach((p) => { if (!byId.has(p.id)) byId.set(p.id, p); });
          const targets = Array.from(byId.values()).filter((p) => (p.reply_count || 0) > 0);

          emit('status', { text: `准备抓 ${targets.length} 条串文的回复区…` });
          incoming = await harvestIncoming(targets, options.knownReplyCounts || null);
          incoming.stats.source = source;

          if (incoming.stats.throttled && source === 'saved') {
            // 全空 + 用的是上次存下来的查询 —— 比起限流，更像是这份查询过期了。
            // 过期不一定报错，Meta 换了 doc_id 后也可能照样返回 200 加一个空列表，
            // 跟被限流长得一模一样。清掉让用户重学一次，比干等着强。
            emit('stale-postreplies', {});
            emit('warn', {
              message: '回复区一条都没抓到。记住的那份查询多半已经失效（Meta 改版了），'
                + '已经清掉。请点开自己任意一条串文让它重新学一次，再回来存档。',
            });
          } else if (incoming.stats.throttled) {
            emit('warn', {
              message: `${incoming.stats.abortReason}，八成是被限流了，这一项先停下。`
                + '已经抓到的都保住了，过十几分钟再跑一次就会接着补。',
            });
          } else if (incoming.stats.aborted) {
            // 上次存下来的那份已经不管用了，清掉，让下次重新学
            if (source === 'saved') emit('stale-postreplies', {});
            emit('warn', {
              message: source === 'saved'
                ? '上次记住的回复区查询已经失效（Meta 改版了），已经清掉。请点开自己的一条串文让它重新学一次，再回来存档。'
                : `回复区连续抓取失败（${incoming.stats.abortReason}），已中止这一项。`,
            });
          }
        }
      }

      posts.sort((a, b) => (b.posted_at_unix || 0) - (a.posted_at_unix || 0));
      replies.sort((a, b) => (b.posted_at_unix || 0) - (a.posted_at_unix || 0));

      emit('result', {
        handle, posts, replies, stats,
        incoming: incoming ? incoming.map : null,
        incomingStats: incoming ? incoming.stats : null,
        emptyIds: incoming ? incoming.emptyIds : null,
      });
    } catch (err) {
      console.error(TAG, err);
      emit('error', { message: err && err.message ? err.message : String(err) });
    } finally {
      running = false;
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__channel !== CHANNEL || d.dir !== 'cs->page') return;
    if (d.type === 'start') run(d.payload || {});
  });

  // 给回归测试留的口子：正常运行时 __TK_TEST__ 未定义，这段不会执行
  if (typeof globalThis !== 'undefined' && globalThis.__TK_TEST__) {
    globalThis.__tkPage = {
      substituteIds,
      normalizePost,
      forgetPostReplies() { templates.postReplies = null; },
    };
  }

  console.log(TAG, '已就绪');
})();
