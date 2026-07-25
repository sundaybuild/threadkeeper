'use strict';

const CHANNEL = 'THREADKEEPER';
const $account = document.getElementById('account');
const $last = document.getElementById('last');
const $go = document.getElementById('go');

const OPTS = {
  incremental: document.getElementById('opt-incremental'),
  replies: document.getElementById('opt-replies'),
  incoming: document.getElementById('opt-incoming'),
  media: document.getElementById('opt-media'),
  html: document.getElementById('opt-html'),
};

const $incomingHint = document.getElementById('incoming-hint');
let learnedReplyQuery = false;

/**
 * 勾上「别人给我的回复」时给出状态。
 * 两种状态都要说出来——只在没学会时提示的话，"没有提示"就分不清是
 * 已经就绪还是功能坏了。
 */
function refreshIncomingHint() {
  if (!OPTS.incoming.checked) { $incomingHint.hidden = true; return; }
  $incomingHint.hidden = false;
  if (learnedReplyQuery) {
    $incomingHint.className = 'hint ok';
    $incomingHint.textContent = '✓ 已经学会读回复区，直接跑就行';
  } else {
    $incomingHint.className = 'hint warn';
    $incomingHint.innerHTML = '还没学会怎么读回复区。请先打开自己<b>任意一条串文</b>、'
      + '等回复区显示出来，再回来存档——每个账号只需要这一次。';
  }
}

function fmt(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function showLastRun(handle) {
  const key = `archive:${handle}`;
  const data = await new Promise((r) => chrome.storage.local.get(key, (o) => r(o[key])));
  if (!data || !data.updated_at) {
    $last.textContent = '还没存过档，这次会全量抓一遍';
    OPTS.incremental.checked = false;
    return;
  }
  const n = (data.posts || []).length + (data.replies || []).length;
  $last.textContent = `已存 ${n} 条 · 上次 ${fmt(data.updated_at)}`;
}

async function detect() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return fail('当前标签页不是 Threads 网站');

  let u;
  try { u = new URL(tab.url); } catch (e) { return fail('当前标签页不是 Threads 网站'); }
  if (!/^www\.threads\.(com|net)$/.test(u.hostname)) return fail('当前标签页不是 Threads 网站');

  const m = u.pathname.match(/^\/@([^/]+)/);
  if (!m) return fail('请先打开一个 Threads 个人主页<br>（网址形如 threads.com/@用户名）');

  const handle = decodeURIComponent(m[1]);
  $account.innerHTML = `将存档：<b>@${handle}</b>`;
  $go.disabled = false;
  $go.dataset.tabId = String(tab.id);
  await showLastRun(handle);

  const tpl = await new Promise((r) => chrome.storage.local.get('tpl:postReplies', (o) => r(o['tpl:postReplies'])));
  learnedReplyQuery = !!(tpl && tpl.doc_id);
  refreshIncomingHint();
}

OPTS.incoming.addEventListener('change', refreshIncomingHint);

function fail(msg) {
  $account.innerHTML = `<span class="muted">${msg}</span>`;
  $go.disabled = true;
}

$go.addEventListener('click', async () => {
  const tabId = Number($go.dataset.tabId);
  if (!tabId) return;
  $go.disabled = true;
  $go.textContent = '已开始，看页面右下角…';
  try {
    const res = await chrome.tabs.sendMessage(tabId, {
      channel: CHANNEL,
      type: 'start',
      payload: {
        incremental: OPTS.incremental.checked,
        includeReplies: OPTS.replies.checked,
        includeIncoming: OPTS.incoming.checked,
        includeMedia: OPTS.media.checked,
        includeHtml: OPTS.html.checked,
      },
    });
    if (res && res.ok === false && res.reason === 'busy') {
      $go.textContent = '已经在跑了';
      return;
    }
    setTimeout(() => window.close(), 900);
  } catch (e) {
    $go.textContent = '启动失败，请刷新页面重试';
  }
});

detect();
