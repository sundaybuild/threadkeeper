/**
 * ThreadKeeper 脆存档 —— 离线存档页生成
 * 产出一个自包含的 index.html：数据内嵌，媒体走同目录的 media/，双击即可浏览。
 */
'use strict';

function tkEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 内嵌 JSON 时把 < 转义掉，免得正文里的 </script> 把页面截断 */
function tkEmbedJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildArchiveHtml(data) {
  const title = `${data.account} 的 Threads 存档`;
  const payload = tkEmbedJson({
    account: data.account,
    exported_at: data.exported_at,
    items: [].concat(data.posts || [], data.replies || [])
      .sort((a, b) => (b.posted_at_unix || 0) - (a.posted_at_unix || 0)),
  });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${tkEscape(title)}</title>
<style>
  :root{
    --bg:#fff; --fg:#0a0a0a; --muted:#6b6b70; --line:#e6e6e9;
    --card:#fff; --chip:#f2f2f5; --accent:#0095f6;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#0f0f10; --fg:#f2f2f3; --muted:#8e8e93; --line:#232326;
           --card:#161618; --chip:#232326; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;}
  .wrap{max-width:680px;margin:0 auto;padding:24px 16px 80px}
  header{position:sticky;top:0;background:var(--bg);padding:16px 0 12px;
    border-bottom:1px solid var(--line);z-index:10}
  h1{font-size:20px;margin:0 0 6px}
  .meta{color:var(--muted);font-size:13px}
  .tools{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
  input[type=search]{flex:1;min-width:180px;padding:8px 12px;border:1px solid var(--line);
    border-radius:10px;background:var(--card);color:var(--fg);font-size:14px}
  button.filter{padding:8px 14px;border:1px solid var(--line);border-radius:10px;
    background:var(--card);color:var(--fg);cursor:pointer;font-size:13px}
  button.filter[aria-pressed=true]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
  article{padding:18px 0;border-bottom:1px solid var(--line)}
  .head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px;flex-wrap:wrap}
  .kind{font-size:11px;padding:2px 8px;border-radius:20px;background:var(--chip);color:var(--muted)}
  time{color:var(--muted);font-size:13px}
  .text{white-space:pre-wrap;word-break:break-word}
  .text a{color:var(--accent);text-decoration:none}
  .ctx{margin:8px 0;padding:10px 12px;border-left:3px solid var(--line);
    background:var(--chip);border-radius:0 8px 8px 0;font-size:13px;color:var(--muted)}
  .ctx b{color:var(--fg)}
  .media{display:grid;gap:8px;margin-top:10px;
    grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
  .media img,.media video{width:100%;border-radius:10px;display:block;background:var(--chip)}
  .missing{padding:24px;text-align:center;color:var(--muted);background:var(--chip);
    border-radius:10px;font-size:12px}
  .cont{margin-top:10px;padding-left:14px;border-left:2px solid var(--line)}
  .cont .text{font-size:14px}
  details.replies{margin-top:12px}
  details.replies summary{cursor:pointer;color:var(--muted);font-size:13px;
    padding:6px 0;user-select:none}
  details.replies summary:hover{color:var(--fg)}
  .rep{padding:10px 0 10px 12px;border-left:2px solid var(--line);margin-top:8px}
  .rep .rhead{font-size:13px;margin-bottom:2px}
  .rep .rhead b{font-weight:600}
  .rep .rhead time{margin-left:6px;font-size:12px}
  .rep .text{font-size:14px}
  .stats{display:flex;gap:14px;margin-top:10px;color:var(--muted);font-size:13px;flex-wrap:wrap}
  .stats a{color:var(--muted);text-decoration:none;margin-left:auto}
  .stats a:hover{color:var(--accent)}
  .link{margin-top:10px;display:block;padding:10px 12px;border:1px solid var(--line);
    border-radius:10px;text-decoration:none;color:inherit}
  .link .t{font-size:14px}
  .link .u{font-size:12px;color:var(--muted)}
  #more{display:block;width:100%;margin-top:24px;padding:12px;border:1px solid var(--line);
    border-radius:10px;background:var(--card);color:var(--fg);cursor:pointer}
  .empty{padding:60px 0;text-align:center;color:var(--muted)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${tkEscape(data.account)}</h1>
    <div class="meta" id="meta"></div>
    <div class="tools">
      <input type="search" id="q" placeholder="搜索正文…">
      <button class="filter" id="f-all" aria-pressed="true">全部</button>
      <button class="filter" id="f-post" aria-pressed="false">串文</button>
      <button class="filter" id="f-reply" aria-pressed="false">回复</button>
    </div>
  </header>
  <main id="list"></main>
  <button id="more" hidden>加载更多</button>
</div>
<script id="data" type="application/json">${payload}</script>
<script>
(function(){
  var DATA = JSON.parse(document.getElementById('data').textContent);
  var PAGE = 40, shown = 0, filtered = DATA.items, mode = 'all', q = '';

  function esc(s){ return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function linkify(s){
    return esc(s)
      .replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')
      .replace(/(^|[\\s(])@([A-Za-z0-9._]{2,30})/g,
        '$1<a href="https://www.threads.com/@$2" target="_blank" rel="noreferrer">@$2</a>');
  }

  function fmtDate(iso){
    if(!iso) return '';
    var d = new Date(iso);
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+
      String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+
      ':'+String(d.getMinutes()).padStart(2,'0');
  }

  function mediaHtml(list){
    if(!list || !list.length) return '';
    var h = list.map(function(m){
      var src = m.local || m.url;
      if(!src) return '';
      if(m.type === 'video'){
        return '<video controls preload="metadata"'+(m.poster_local?' poster="'+esc(m.poster_local)+'"':'')+
          ' src="'+esc(src)+'"></video>';
      }
      return '<img loading="lazy" alt="'+esc(m.alt||'')+'" src="'+esc(src)+'">';
    }).join('');
    return '<div class="media">'+h+'</div>';
  }

  function statsHtml(p){
    var bits = [];
    if(p.like_count != null) bits.push('♡ '+p.like_count);
    if(p.reply_count != null) bits.push('💬 '+p.reply_count);
    if(p.repost_count != null) bits.push('🔁 '+p.repost_count);
    var link = p.url ? '<a href="'+esc(p.url)+'" target="_blank" rel="noreferrer">原帖 ↗</a>' : '';
    return '<div class="stats">'+bits.map(function(b){return '<span>'+b+'</span>';}).join('')+link+'</div>';
  }

  function render(p){
    var el = document.createElement('article');
    var h = '<div class="head">';
    h += '<span class="kind">'+(p.kind === 'reply' ? '回复' : '串文')+'</span>';
    h += '<time>'+fmtDate(p.posted_at)+'</time></div>';

    if(p.in_reply_to && (p.in_reply_to.username || p.in_reply_to.text)){
      h += '<div class="ctx">回复 <b>@'+esc(p.in_reply_to.username||'')+'</b>：'+
        esc((p.in_reply_to.text||'').slice(0,160))+'</div>';
    }
    if(p.text) h += '<div class="text">'+linkify(p.text)+'</div>';
    h += mediaHtml(p.media);

    if(p.link_preview && p.link_preview.url){
      h += '<a class="link" href="'+esc(p.link_preview.url)+'" target="_blank" rel="noreferrer">'+
        '<div class="t">'+esc(p.link_preview.title||p.link_preview.url)+'</div>'+
        '<div class="u">'+esc(p.link_preview.site||'')+'</div></a>';
    }
    if(p.continuation && p.continuation.length){
      h += '<div class="cont">'+p.continuation.map(function(c){
        return '<div class="text">'+linkify(c.text||'')+'</div>'+mediaHtml(c.media);
      }).join('')+'</div>';
    }
    h += statsHtml(p);

    if(p.incoming_replies && p.incoming_replies.length){
      h += '<details class="replies"><summary>展开 '+p.incoming_replies.length+' 条回复</summary>'+
        p.incoming_replies.map(function(r){
          return '<div class="rep"><div class="rhead"><b>@'+esc(r.username||'')+'</b>'+
            '<time>'+fmtDate(r.posted_at)+'</time></div>'+
            '<div class="text">'+linkify(r.text||'')+'</div>'+mediaHtml(r.media)+'</div>';
        }).join('')+'</details>';
    }

    el.innerHTML = h;
    return el;
  }

  var list = document.getElementById('list');
  var more = document.getElementById('more');

  function apply(){
    var kw = q.trim().toLowerCase();
    filtered = DATA.items.filter(function(p){
      if(mode === 'post' && p.kind === 'reply') return false;
      if(mode === 'reply' && p.kind !== 'reply') return false;
      if(kw){
        if((p.text||'').toLowerCase().indexOf(kw) !== -1) return true;
        // 收到的回复里也搜一遍
        return (p.incoming_replies||[]).some(function(r){
          return (r.text||'').toLowerCase().indexOf(kw) !== -1;
        });
      }
      return true;
    });
    list.innerHTML = ''; shown = 0;
    if(!filtered.length){
      list.innerHTML = '<div class="empty">没有匹配的内容</div>';
      more.hidden = true; return;
    }
    draw();
  }

  function draw(){
    var frag = document.createDocumentFragment();
    var end = Math.min(shown + PAGE, filtered.length);
    for(var i = shown; i < end; i++) frag.appendChild(render(filtered[i]));
    list.appendChild(frag);
    shown = end;
    more.hidden = shown >= filtered.length;
    more.textContent = '加载更多（还有 '+(filtered.length - shown)+' 条）';
  }

  more.addEventListener('click', draw);
  document.getElementById('q').addEventListener('input', function(e){ q = e.target.value; apply(); });
  ['all','post','reply'].forEach(function(m){
    document.getElementById('f-'+m).addEventListener('click', function(){
      mode = m;
      ['all','post','reply'].forEach(function(x){
        document.getElementById('f-'+x).setAttribute('aria-pressed', String(x === m));
      });
      apply();
    });
  });

  var posts = DATA.items.filter(function(p){ return p.kind !== 'reply'; }).length;
  var replies = DATA.items.length - posts;
  document.getElementById('meta').textContent =
    posts + ' 条串文' + (replies ? ' · ' + replies + ' 条回复' : '') +
    ' · 导出于 ' + fmtDate(DATA.exported_at);

  apply();
})();
</script>
</body>
</html>`;
}
