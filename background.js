/**
 * ThreadKeeper 脆存档 —— 后台 Service Worker
 *
 * 只干一件事：把 content.js 备好的文件落盘。
 * 内容脚本没有 chrome.downloads 权限，媒体又是跨域的 CDN 直链，
 * 交给 downloads API 下载既不受 CORS 限制，也不用把二进制搬来搬去。
 */
'use strict';

const CHANNEL = 'THREADKEEPER';
const CONCURRENCY = 4;

/** 文件名里不能出现的字符 */
function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function download(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });
}

/** 等这个下载真正结束，才好统计成功/失败 */
function waitFor(id) {
  return new Promise((resolve) => {
    const onChanged = (delta) => {
      if (delta.id !== id) return;
      if (delta.state && delta.state.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(true);
      } else if (delta.state && delta.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(false);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    // 兜底：30 秒还没动静就不等了，避免卡死整个队列
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(true);
    }, 30000);
  });
}

function notify(tabId, type, payload) {
  chrome.tabs.sendMessage(tabId, { channel: CHANNEL, type, payload }).catch(() => {});
}

async function archive(payload, tabId) {
  const { folder, files, media } = payload;
  const base = `ThreadKeeper/${safeName(folder)}`;
  const result = { files: 0, mediaOk: 0, mediaFail: 0 };

  // 1) JSON / HTML 这类小文件，用 data: URL 直接写盘
  for (const f of files) {
    try {
      await download({
        url: f.dataUrl,
        filename: `${base}/${safeName(f.name)}`,
        conflictAction: 'overwrite',
        saveAs: false,
      });
      result.files += 1;
    } catch (e) {
      notify(tabId, 'archive-error', { message: `写入 ${f.name} 失败：${e.message}` });
    }
  }

  // 2) 媒体，限并发跑
  if (media && media.length) {
    let cursor = 0;
    const total = media.length;

    const worker = async () => {
      while (cursor < total) {
        const i = cursor;
        cursor += 1;
        const m = media[i];
        try {
          const id = await download({
            url: m.url,
            filename: `${base}/media/${safeName(m.name)}`,
            conflictAction: 'overwrite',
            saveAs: false,
          });
          const ok = await waitFor(id);
          if (ok) result.mediaOk += 1; else result.mediaFail += 1;
        } catch (e) {
          result.mediaFail += 1;
        }
        if ((result.mediaOk + result.mediaFail) % 5 === 0 || cursor >= total) {
          notify(tabId, 'archive-progress', {
            done: result.mediaOk + result.mediaFail,
            total,
            failed: result.mediaFail,
          });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  }

  notify(tabId, 'archive-done', { ...result, folder: base });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.channel !== CHANNEL) return;
  if (msg.type === 'archive') {
    const tabId = sender.tab && sender.tab.id;
    archive(msg.payload, tabId).catch((e) => {
      notify(tabId, 'archive-error', { message: e.message });
    });
    sendResponse({ ok: true });
  }
  return true;
});
