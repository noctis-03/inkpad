/* ═══════════════════════════════════════════════════════════════
   HandNote — part 3 : UI · 공책 관리 · 내보내기 · 구글 드라이브 · 부팅
   ═══════════════════════════════════════════════════════════════ */
(function () {
'use strict';
var H = window._HN, S = H.S, $ = H.$, $$ = H.$$, clamp = H.clamp, esc = H.esc;
var PT = H.PT, PAGE_W = H.PAGE_W, PAGE_H = H.PAGE_H;

/* ── 테마 ─────────────────────────────────────────────────── */
function applyTheme(t) {
  S.prefs.theme = t;
  var resolved = t;
  if (t === 'auto') resolved = (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', resolved);
  var b = $('#btnTheme');
  if (b) b.innerHTML = '<svg><use href="#' + (resolved === 'dark' ? 'i-sun' : 'i-moon') + '"/></svg>';
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#131211' : '#EDE9DF');
  H.savePrefs();
}

/* ── 팝오버/시트 ──────────────────────────────────────────── */
var openPopEl = null;
function closePops() {
  if (openPopEl) { openPopEl.remove(); openPopEl = null; }
  $$('.pop').forEach(function (n) { n.remove(); });
}
function popover(anchor, spec) {
  closePops();
  var p = document.createElement('div');
  p.className = 'pop';
  var html = '';
  if (spec.title) html += '<div class="ph"><b>' + esc(spec.title) + '</b>' + (spec.desc ? '<p>' + esc(spec.desc) + '</p>' : '') + '</div>';
  (spec.items || []).forEach(function (it, i) {
    if (it.hr) { html += '<hr>'; return; }
    html += '<button class="pi" data-i="' + i + '">' +
      (it.icon ? '<svg><use href="#' + it.icon + '"/></svg>' : '') +
      '<span style="min-width:0"><span>' + esc(it.label) + '</span>' +
      (it.sub ? '<span class="sub">' + esc(it.sub) + '</span>' : '') + '</span>' +
      (it.kbd ? '<span class="k">' + esc(it.kbd) + '</span>' : '') + '</button>';
  });
  p.innerHTML = html;
  $('#layer').appendChild(p);
  var r = anchor.getBoundingClientRect();
  var top = r.bottom + 6, left = r.left;
  if (spec.alignRight) left = r.right - p.offsetWidth;
  p.style.top = Math.min(top, window.innerHeight - p.offsetHeight - 10) + 'px';
  p.style.left = clamp(left, 8, window.innerWidth - p.offsetWidth - 8) + 'px';
  p.addEventListener('click', function (e) {
    var b = e.target.closest('button.pi');
    if (!b) return;
    var it = spec.items[+b.dataset.i];
    closePops();
    if (it && it.run) it.run();
  });
  openPopEl = p;
  setTimeout(function () {
    document.addEventListener('pointerdown', onAway, true);
  }, 0);
}
function onAway(e) {
  if (openPopEl && !openPopEl.contains(e.target)) closePops();
  document.removeEventListener('pointerdown', onAway, true);
}

function modal(html, wire) {
  var scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  scrim.innerHTML = '<div class="modal">' + html + '</div>';
  $('#layer').appendChild(scrim);
  function close() { scrim.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('pointerdown', function (e) { if (e.target === scrim) close(); });
  scrim.querySelectorAll('[data-close]').forEach(function (b) { b.onclick = close; });
  if (wire) wire(scrim.querySelector('.modal'), close);
  var f = scrim.querySelector('input,textarea'); if (f) f.focus();
  return close;
}
function confirmBox(title, msg, okLabel, cb, danger) {
  modal(
    '<h3>' + esc(title) + '</h3><p>' + esc(msg) + '</p>' +
    '<div class="acts"><button class="btn" data-close>취소</button>' +
    '<button class="btn ' + (danger ? 'danger' : 'primary') + '" id="okBtn">' + esc(okLabel || '확인') + '</button></div>',
    function (m, close) { $('#okBtn', m).onclick = function () { close(); cb(); }; }
  );
}
function promptBox(title, label, value, cb) {
  modal(
    '<h3>' + esc(title) + '</h3><p>' + esc(label) + '</p>' +
    '<input class="inp" id="pv" value="' + esc(value || '') + '">' +
    '<div class="acts"><button class="btn" data-close>취소</button><button class="btn primary" id="okBtn">확인</button></div>',
    function (m, close) {
      var i = $('#pv', m);
      i.select();
      var go = function () { var v = i.value.trim(); if (!v) return; close(); cb(v); };
      $('#okBtn', m).onclick = go;
      i.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    }
  );
}

/* ── 공책 목록 ─────────────────────────────────────────────── */
function renderNbList() {
  var host = $('#nbList'), q = ($('#nbSearch').value || '').trim().toLowerCase();
  var list = S.notebooks.filter(function (n) { return !q || n.title.toLowerCase().indexOf(q) >= 0; });
  host.innerHTML = '';
  $('#nbCount').textContent = S.notebooks.length;
  if (!list.length) {
    host.innerHTML = '<div class="empty-note">' + (q ? '검색 결과가 없습니다' : '아직 공책이 없습니다.<br>오른쪽 위 <b>새 공책</b>으로 시작하세요') + '</div>';
    return;
  }
  list.forEach(function (nb) {
    var b = document.createElement('button');
    b.className = 'nb-row' + (S.nb && S.nb.id === nb.id ? ' on' : '');
    b.innerHTML =
      '<span class="cover" style="background:' + esc(nb.cover) + '"><span>' + esc((nb.title || '?').slice(0, 1)) + '</span></span>' +
      '<span class="meta"><b>' + esc(nb.title) + '</b><em>' + (nb.pageCount || 0) + '쪽 · ' + H.fmtDate(nb.updatedAt || nb.createdAt) + '</em></span>' +
      '<span class="pin" data-menu><svg width="16" height="16" style="stroke:currentColor;fill:none;stroke-width:1.7"><use href="#i-chevron"/></svg></span>';
    b.onclick = function (e) {
      if (e.target.closest('[data-menu]')) { nbMenu(e.target.closest('[data-menu]'), nb); return; }
      openNotebook(nb.id);
    };
    b.oncontextmenu = function (e) { e.preventDefault(); nbMenu(b, nb); };
    host.appendChild(b);
  });
}
function nbMenu(anchor, nb) {
  popover(anchor, {
    title: nb.title, desc: (nb.pageCount || 0) + '쪽 · 만든 날 ' + H.fmtDate(nb.createdAt),
    items: [
      { icon: 'i-pen', label: '이름 바꾸기', run: function () { promptBox('공책 이름', '새 이름을 입력하세요', nb.title, function (v) { nb.title = v; H.queueNbSave(nb); renderNbList(); renderHeader(); }); } },
      { icon: 'i-image', label: '표지 색', sub: '목록에서 구분하기 쉽게', run: function () { coverPicker(anchor, nb); } },
      { icon: 'i-page-add', label: '쪽 추가', run: function () { openNotebook(nb.id).then(function () { addPage(); }); } },
      { icon: 'i-copy', label: '공책 복제', run: function () { duplicateNotebook(nb); } },
      { hr: true },
      { icon: 'i-download', label: 'JSON 으로 내보내기', run: function () { exportNotebookJson(nb); } },
      { icon: 'i-cloud', label: '지금 동기화', run: function () { Drive.sync('both'); } },
      { hr: true },
      { icon: 'i-trash', label: '공책 삭제', run: function () { deleteNotebook(nb); } }
    ]
  });
}
function coverPicker(anchor, nb) {
  var html = '<div class="ph"><b>표지 색</b></div><div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:8px 10px 10px">' +
    H.COVERS.map(function (c) { return '<button data-c="' + c + '" style="height:38px;border-radius:8px;background:' + c + ';box-shadow:inset 0 0 0 1px rgba(0,0,0,.18)' + (nb.cover === c ? ';outline:2px solid var(--accent);outline-offset:2px' : '') + '"></button>'; }).join('') +
    '</div>';
  closePops();
  var p = document.createElement('div');
  p.className = 'pop';
  p.innerHTML = html;
  $('#layer').appendChild(p);
  var r = anchor.getBoundingClientRect();
  p.style.top = (r.bottom + 6) + 'px';
  p.style.left = clamp(r.left, 8, window.innerWidth - 280 - 8) + 'px';
  p.addEventListener('click', function (e) {
    var b = e.target.closest('[data-c]');
    if (!b) return;
    nb.cover = b.dataset.c;
    H.queueNbSave(nb); renderNbList(); closePops();
  });
  openPopEl = p;
  setTimeout(function () { document.addEventListener('pointerdown', onAway, true); }, 0);
}
function duplicateNotebook(nb) {
  H.busy(true);
  H.DB.pagesOf(nb.id).then(function (pages) {
    var copy = H.newNotebook(nb.title + ' 복사');
    copy.cover = nb.cover; copy.background = nb.background; copy.tone = nb.tone;
    var order = [], cl = pages.map(function (p) {
      var q = { id: H.uid('pg'), notebookId: copy.id, strokes: p.strokes.map(function (s) {
        var o = { id: H.uid('s'), t: s.t, c: s.c, w: s.w, a: s.a, p: s.p.slice() };
        return o;
      }), background: p.background, updatedAt: Date.now(), createdAt: Date.now() };
      order.push(q.id);
      return q;
    });
    copy.pageOrder = order; copy.pageCount = order.length;
    return H.DB.put('notebooks', copy).then(function () { return H.DB.putMany('pages', cl); }).then(function () {
      S.notebooks.unshift(copy);
      renderNbList(); H.busy(false); H.toast('공책을 복제했습니다', 'ok');
    });
  }).catch(function (e) { H.busy(false); H.toast('복제 실패: ' + e.message, 'err'); });
}
function deleteNotebook(nb) {
  confirmBox('공책을 삭제할까요?', '“' + nb.title + '” 의 모든 쪽이 브라우저에서 지워집니다. 되돌릴 수 없습니다.', '삭제', function () {
    H.busy(true);
    H.DB.pagesOf(nb.id).then(function (pages) {
      return H.DB.delMany('pages', pages.map(function (p) { return p.id; }));
    }).then(function () {
      return H.DB.del('notebooks', nb.id);
    }).then(function () {
      S.notebooks = S.notebooks.filter(function (n) { return n.id !== nb.id; });
      H.busy(false);
      if (S.nb && S.nb.id === nb.id) {
        S.nb = null; S.pages = []; S.pageIdx = 0;
        if (S.notebooks.length) return openNotebook(S.notebooks[0].id);
        var fresh = H.newNotebook('첫 공책');
        return H.DB.put('notebooks', fresh).then(function () { S.notebooks = [fresh]; return openNotebook(fresh.id); });
      }
      renderNbList();
    }).catch(function (e) { H.busy(false); H.toast('삭제 실패: ' + e.message, 'err'); });
  }, true);
}
function newNotebookDialog() {
  modal(
    '<h3>새 공책</h3><p>이름과 용지를 고르세요. 나중에 언제든 바꿀 수 있습니다.</p>' +
    '<div class="fld" style="padding-top:0"><label>이름</label><input class="inp" id="nbName" placeholder="예: 회의 필기" value=""></div>' +
    '<div class="fld"><label>용지</label><div class="seg" id="bgSeg">' +
    Object.keys(H.PAPERS).map(function (k) { return '<button data-v="' + k + '"' + (k === 'dot' ? ' class="on"' : '') + '>' + H.PAPERS[k] + '</button>'; }).join('') +
    '</div></div>' +
    '<div class="fld"><label>종이 색</label><div class="seg" id="toneSeg">' +
    '<button data-v="white" class="on">흰 종이</button><button data-v="warm">미색</button><button data-v="dark">먹지</button>' +
    '</div></div>' +
    '<div class="acts"><button class="btn" data-close>취소</button><button class="btn primary" id="okBtn">만들기</button></div>',
    function (m, close) {
      var bg = 'dot', tone = 'white';
      m.querySelectorAll('#bgSeg button').forEach(function (b) {
        b.onclick = function () { bg = b.dataset.v; m.querySelectorAll('#bgSeg button').forEach(function (x) { x.classList.toggle('on', x === b); }); };
      });
      m.querySelectorAll('#toneSeg button').forEach(function (b) {
        b.onclick = function () { tone = b.dataset.v; m.querySelectorAll('#toneSeg button').forEach(function (x) { x.classList.toggle('on', x === b); }); };
      });
      $('#okBtn', m).onclick = function () {
        var name = ($('#nbName', m).value || '').trim() || '새 공책';
        close();
        var nb = H.newNotebook(name);
        nb.background = bg; nb.tone = tone;
        H.DB.put('notebooks', nb).then(function () {
          S.notebooks.unshift(nb);
          return openNotebook(nb.id);
        }).then(function () { H.toast('공책을 만들었습니다', 'ok'); });
      };
    }
  );
}

/* ── 공책 열기 ─────────────────────────────────────────────── */
function paintThemeSpine() {
  if (!S.nb) return;
  $('#nbTitle').textContent = S.nb.title;
  $('#nbSpine').style.background = S.nb.cover;
}
function renderHeader() { paintThemeSpine(); }
function openNotebook(id) {
  H.busy(true);
  return H.DB.get('notebooks', id).then(function (nb) {
    if (!nb) { H.busy(false); H.toast('공책을 찾을 수 없습니다', 'err'); return; }
    return H.DB.pagesOf(id).then(function (pages) {
      var order = nb.pageOrder || [], map = {}, list = [], i;
      pages.forEach(function (p) { map[p.id] = p; });
      order.forEach(function (pid) { if (map[pid]) { list.push(map[pid]); delete map[pid]; } });
      Object.keys(map).forEach(function (k) { list.push(map[k]); });
      var fresh = null;
      if (!list.length) { fresh = H.newPage(id); list.push(fresh); }
      nb.pageOrder = list.map(function (p) { return p.id; });
      nb.pageCount = list.length;
      S.nb = nb; S.pages = list; S.pageIdx = 0;
      S.sel = []; S.history = []; S.hIdx = -1; S.live = null; S.erase = null; S.lasso = null; S.drag = null;
      S.prefs.lastNb = id; H.savePrefs();
      H.canvas.rebuildCommit();
      H.canvas.needRebuild && H.canvas.needRebuild();
      H.canvas.rebuildCommit();
      S.ready = false;
      renderHeader(); renderNbList(); renderTray(); syncPageUI(); H.refreshHistoryUI();
      updateSelChip();
      H.canvas.fit();
      S.ready = true;
      var jobs = [H.DB.put('notebooks', nb)];
      if (fresh) jobs.push(H.DB.put('pages', fresh));
      return Promise.all(jobs);
    });
  }).then(function () {
    H.busy(false);
    renderNbList();
    updateQuota();
    if (S.prefs.autoSync && S.prefs.driveClientId && S.drive.token) Drive.sync('both', true);
  }).catch(function (e) {
    H.busy(false);
    H.toast('공책을 열지 못했습니다: ' + e.message, 'err');
  });
}

/* ── 쪽 ────────────────────────────────────────────────────── */
function addPage(after) {
  if (!S.nb) return;
  var p = H.newPage(S.nb.id);
  var at = typeof after === 'number' ? after : S.pageIdx + 1;
  S.pages.splice(at, 0, p);
  S.nb.pageOrder = S.pages.map(function (x) { return x.id; });
  S.nb.pageCount = S.pages.length;
  H.DB.put('pages', p);
  H.queueNbSave(S.nb);
  goPage(at);
  renderNbList();
  H.toast('새 쪽을 추가했습니다');
}
function goPage(i) {
  i = clamp(i, 0, S.pages.length - 1);
  if (i === S.pageIdx && S.ready) return;
  S.pageIdx = i;
  S.sel = []; S.live = null; S.erase = null; S.lasso = null;
  H.canvas.rebuildCommit();
  syncPageUI(); updateSelChip(); H.canvas.fit();
}
function duplicatePage() {
  var p = H.curPage(); if (!p) return;
  var q = { id: H.uid('pg'), notebookId: p.notebookId, background: p.background, strokes: [], updatedAt: Date.now(), createdAt: Date.now() };
  q.strokes = p.strokes.map(function (s) { return { id: H.uid('s'), t: s.t, c: s.c, w: s.w, a: s.a, p: s.p.slice() }; });
  S.pages.splice(S.pageIdx + 1, 0, q);
  S.nb.pageOrder = S.pages.map(function (x) { return x.id; });
  S.nb.pageCount = S.pages.length;
  H.DB.put('pages', q); H.queueNbSave(S.nb);
  goPage(S.pageIdx + 1); renderNbList();
  H.toast('쪽을 복제했습니다', 'ok');
}
function deletePage() {
  var p = H.curPage(); if (!p) return;
  if (S.pages.length <= 1) { H.toast('마지막 쪽은 삭제할 수 없습니다', 'err'); return; }
  var idx = S.pageIdx;
  confirmBox('이 쪽을 삭제할까요?', (idx + 1) + '번째 쪽의 필기가 사라집니다. 되돌릴 수 없습니다.', '삭제', function () {
    S.pages.splice(idx, 1);
    S.nb.pageOrder = S.pages.map(function (x) { return x.id; });
    S.nb.pageCount = S.pages.length;
    H.DB.del('pages', p.id); H.queueNbSave(S.nb);
    H.history = S.history.filter(function (c) { return c.pageId !== p.id; });
    H.hIdx = H.history.length - 1;
    goPage(Math.min(idx, S.pages.length - 1));
    renderNbList();
    H.toast('쪽을 삭제했습니다');
  }, true);
}

/* ── 쪽 트레이(썸네일) ─────────────────────────────────────── */
var thumbCache = new Map();
function thumbKeyOf(p) { return p.id + '|' + (p.updatedAt || 0); }
function renderTray() {
  var inner = $('#trayInner');
  inner.innerHTML = '';
  S.pages.forEach(function (p, i) {
    var w = document.createElement('div');
    w.className = 'thumb' + (i === S.pageIdx ? ' on' : '');
    w.title = (i + 1) + '쪽';
    var c = document.createElement('canvas');
    c.width = 112; c.height = 158;
    var key = thumbKeyOf(p), hit = thumbCache.get(key);
    if (hit) c.getContext('2d').drawImage(hit, 0, 0);
    else {
      H.canvas.drawThumb(p, c, 112, 158);
      var store = document.createElement('canvas');
      store.width = 112; store.height = 158;
      store.getContext('2d').drawImage(c, 0, 0);
      thumbCache.set(key, store);
      if (thumbCache.size > 400) { var k0 = thumbCache.keys().next().value; thumbCache.delete(k0); }
    }
    var n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1);
    w.appendChild(c); w.appendChild(n);
    w.onclick = function () { goPage(i); };
    w.oncontextmenu = function (e) { e.preventDefault(); pageMenu(w, i); };
    inner.appendChild(w);
  });
  var add = document.createElement('button');
  add.className = 'thumb-add'; add.title = '새 쪽 (N)';
  add.innerHTML = '<svg><use href="#i-plus"/></svg>';
  add.onclick = function () { addPage(); };
  inner.appendChild(add);

  // 화면 밖 쪽의 썸네일을 지연 렌더
  setTimeout(function () { refreshDirtyThumbs(); }, 60);
}
function refreshDirtyThumbs() {
  var dirty = H._thumbDirty;
  if (!dirty || !dirty.size) return;
  var changed = Array.from(dirty);
  dirty.clear();
  var cancelled = [];
  changed.forEach(function (id) { cancelled.push(id); });
  void cancelled;
  // 해당 쪽 썸네일만 다시 그린다
  S.pages.forEach(function (p, i) {
    if (changed.indexOf(p.id) < 0) return;
    var node = $$('#trayInner .thumb')[i];
    if (!node) return;
    var c = node.querySelector('canvas');
    if (!c) return;
    H.canvas.drawThumb(p, c, 112, 158);
    var store = thumbCache.get(thumbKeyOf(p));
    if (store) { store.getContext('2d').clearRect(0, 0, 112, 158); store.getContext('2d').drawImage(c, 0, 0); }
  });
}
function pageMenu(anchor, i) {
  if (i !== S.pageIdx) goPage(i);
  popover(anchor, { title: (i + 1) + '쪽', items: [
    { icon: 'i-page-add', label: '뒤에 새 쪽', run: function () { addPage(i + 1); } },
    { icon: 'i-copy', label: '이 쪽 복제', run: duplicatePage },
    { icon: 'i-blank', label: '용지 바꾸기', run: function (e) { paperMenu(anchor); } },
    { hr: true },
    { icon: 'i-download', label: 'PNG 로 저장', run: function () { exportPagePng(); } },
    { icon: 'i-trash', label: '이 쪽 삭제', run: deletePage }
  ] });
}

/* ── 헤더/트레이 상태 동기화 ───────────────────────────────── */
function syncPageUI() {
  $('#pgNum').textContent = S.pages.length ? (S.pageIdx + 1) + ' / ' + S.pages.length : '– / –';
  $$('#trayInner .thumb').forEach(function (n, i) { n.classList.toggle('on', i === S.pageIdx); });
  H.refreshHistoryUI();
  var tr = $('#trayInner .thumb.on');
  if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

/* ── 도구 선택 ─────────────────────────────────────────────── */
function setTool(t) {
  S.prefs.tool = t; S.sel = [];
  $$('.tool').forEach(function (b) { b.classList.toggle('on', b.dataset.tool === t); });
  updateSelChip();
  H.savePrefs(); H.canvas.render();
}
function setColor(c) {
  S.prefs.color = c;
  $$('.sw').forEach(function (b) { b.classList.toggle('on', b.dataset.c === c); });
  H.savePrefs(); updatePenPreview();
}
function setSize(v) {
  S.prefs.size = clamp(+v || 2.6, 0.6, 14);
  var r = $('#penSize'); if (r && +r.value !== S.prefs.size) r.value = S.prefs.size;
  H.savePrefs(); updatePenPreview(); H.canvas.render();
}
function updatePenPreview() {
  var prev = $('#penPrev');
  if (!prev) return;
  var d = clamp(S.prefs.size * (S.prefs.tool === 'highlighter' ? 6 : 1), 3, 32);
  prev.innerHTML = '<i style="width:' + d.toFixed(1) + 'px;height:' + d.toFixed(1) + 'px;background:' + esc(S.prefs.color) + ';opacity:' + (S.prefs.tool === 'highlighter' ? .4 : 1) + '"></i>';
}
function buildSwatches() {
  var host = $('#swatches');
  host.innerHTML = '';
  H.INKS.forEach(function (c) {
    var b = document.createElement('button');
    b.className = 'sw' + (c === S.prefs.color ? ' on' : '');
    b.dataset.c = c; b.style.background = c; b.title = c;
    if (c === '#E9E5DC' || c === '#1B1A17') b.style.boxShadow = 'inset 0 0 0 1px rgba(127,127,127,.4)';
    b.onclick = function () { setColor(c); };
    host.appendChild(b);
  });
}

/* ── 선택 도구 칩 ─────────────────────────────────────────── */
function updateSelChip() {
  var old = $('#selChip'); if (old) old.remove();
  if (!S.sel || !S.sel.length || S.prefs.tool !== 'lasso') return;
  var d = document.createElement('div');
  d.className = 'pg-ctl'; d.id = 'selChip';
  d.style.bottom = '66px';
  d.innerHTML =
    '<span class="num">' + S.sel.length + '획</span>' +
    '<button class="btn sm" id="selMove" title="선택한 획을 끌어서 이동"><svg><use href="#i-move"/></svg>이동</button>' +
    '<button class="btn sm" id="selDup"><svg><use href="#i-copy"/></svg>복제</button>' +
    '<button class="btn sm danger" id="selDel"><svg><use href="#i-trash"/></svg>삭제</button>' +
    '<button class="btn sm ghost" id="selAll">전체</button>' +
    '<button class="ibtn sm" id="selNone" title="선택 해제 (Esc)"><svg><use href="#i-close"/></svg></button>';
  $('#stage').appendChild(d);
  $('#selDel').onclick = function () { H.canvas.deleteSel(); };
  $('#selDup').onclick = function () { H.canvas.duplicateSel(); };
  $('#selAll').onclick = function () { H.canvas.selectAll(); };
  $('#selNone').onclick = function () { H.canvas.clearSel(); };
  $('#selMove').onclick = function () { H.toast('선택 영역 안을 끌면 함께 움직입니다'); };
}
H.onSelection = updateSelChip;

/* ── 용지 선택 ─────────────────────────────────────────────── */
function paperMenu(anchor) {
  popover(anchor, {
    title: '용지', desc: '이 쪽에만 적용됩니다',
    items: Object.keys(H.PAPERS).map(function (k) {
      return { icon: k === 'dot' ? 'i-dots' : k === 'grid' ? 'i-grid' : k === 'ruled' ? 'i-lines' : 'i-blank', label: H.PAPERS[k], kbd: S.nb && S.nb.background === k ? '현재' : '', run: function () { applyPaper(k); } };
    }).concat([
      { hr: true },
      { icon: 'i-page', label: '이 공책의 기본 용지로', run: function () { S.nb.background = H.curPage().background || S.nb.background; H.queueNbSave(S.nb); H.toast('공책 기본 용지로 저장했습니다', 'ok'); } },
      { icon: 'i-eye', label: '종이 색 · 흰 종이', run: function () { setTone('white'); } },
      { icon: 'i-eye', label: '종이 색 · 미색', run: function () { setTone('warm'); } },
      { icon: 'i-eye', label: '종이 색 · 먹지', run: function () { setTone('dark'); } }
    ])
  });
}
function applyPaper(k) {
  var p = H.curPage(); if (!p) return;
  p.background = k;
  H.markDirty(p);
  H.canvas.needRebuild(); H.canvas.render();
  H.toast('용지: ' + H.PAPERS[k]);
}
function setTone(t) {
  S.nb.tone = t; H.queueNbSave(S.nb);
  S.pages.forEach(function (p) { H.markDirty(p); });
  H.canvas.needRebuild(); H.canvas.render();
  renderTray();
  H.toast('종이 색을 바꿨습니다');
}

/* ── 내보내기 ─────────────────────────────────────────────── */
function safeName(s) { return String(s).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60); }

function exportPagePng() {
  var p = H.curPage(); if (!p) return;
  H.busy(true);
  var c = H.canvas.pageBitmap(p, 2);
  c.toBlob(function (b) {
    H.busy(false);
    H.download(b, safeName(S.nb.title) + '-' + (S.pageIdx + 1) + '쪽.png');
    H.toast('PNG 로 저장했습니다', 'ok');
  }, 'image/png');
}
function exportAllPng() {
  H.busy(true);
  var i = 0;
  function next() {
    if (i >= S.pages.length) { H.busy(false); H.toast(S.pages.length + '쪽 PNG 저장 완료', 'ok'); return; }
    var p = S.pages[i], idx = i; i++;
    var c = H.canvas.pageBitmap(p, 1.6);
    c.toBlob(function (b) {
      H.download(b, safeName(S.nb.title) + '-' + String(idx + 1).padStart(3, '0') + '.png');
      setTimeout(next, 220);
    }, 'image/png');
  }
  next();
}

/*PDF-BUILD-START*/
function buildPdf(imgs) {
  // imgs: [{ bytes: Uint8Array(jpeg), w:Number, h:Number }]
  var ptW = 595.28, ptH = 841.89;
  var parts = [], len = 0, offsets = [];
  function push(u8) { parts.push(u8); len += u8.length; }
  function str(s) { push(new TextEncoder().encode(s)); }
  function obj(n, write) { offsets[n] = len; str(n + ' 0 obj\n'); write(); str('\nendobj\n'); }

  str('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

  var n = imgs.length;
  var N = 2 + n * 3;
  var kids = [];
  for (var i = 0; i < n; i++) kids.push((3 + i * 3) + ' 0 R');

  obj(1, function () { str('<< /Type /Catalog /Pages 2 0 R >>'); });
  obj(2, function () { str('<< /Type /Pages /Count ' + n + ' /Kids [' + kids.join(' ') + '] >>'); });

  for (var j = 0; j < n; j++) {
    (function (i) {
      var pg = 3 + i * 3, ct = 4 + i * 3, im = 5 + i * 3;
      var img = imgs[i];
      obj(pg, function () {
        str('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + ptW.toFixed(2) + ' ' + ptH.toFixed(2) + '] ' +
          '/Resources << /XObject << /Im0 ' + im + ' 0 R >> >> /Contents ' + ct + ' 0 R >>');
      });
      obj(ct, function () {
        var c = 'q ' + ptW.toFixed(2) + ' 0 0 ' + ptH.toFixed(2) + ' 0 0 cm /Im0 Do Q';
        str('<< /Length ' + c.length + ' >>\nstream\n' + c + '\nendstream');
      });
      obj(im, function () {
        str('<< /Type /XObject /Subtype /Image /Width ' + img.w + ' /Height ' + img.h +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + img.bytes.length + ' >>\nstream\n');
        push(img.bytes);
        str('\nendstream');
      });
    })(j);
  }

  var xref = len;
  str('xref\n0 ' + (N + 1) + '\n0000000000 65535 f \n');
  for (var k = 1; k <= N; k++) str(String(offsets[k]).padStart(10, '0') + ' 00000 n \n');
  str('trailer\n<< /Size ' + (N + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

  var out = new Uint8Array(len), o = 0;
  for (var p2 = 0; p2 < parts.length; p2++) { out.set(parts[p2], o); o += parts[p2].length; }
  return out;
}
/*PDF-BUILD-END*/

function exportPdf() {
  if (!S.pages.length) return;
  H.busy(true);
  var imgs = [], i = 0;
  function step() {
    if (i >= S.pages.length) {
      var bytes = buildPdf(imgs);
      H.busy(false);
      H.download(new Blob([bytes], { type: 'application/pdf' }), safeName(S.nb.title) + '.pdf');
      H.toast(S.pages.length + '쪽 PDF 를 만들었습니다', 'ok', 3000);
      return;
    }
    var p = S.pages[i], idx = i; i++;
    var c = H.canvas.pageBitmap(p, 1.5);
    c.toBlob(function (b) {
      b.arrayBuffer().then(function (ab) {
        imgs[idx] = { bytes: new Uint8Array(ab), w: c.width, h: c.height };
        setTimeout(step, 10);
      });
    }, 'image/jpeg', 0.88);
  }
  step();
}

function notebookPayload(nb, pages) {
  return {
    v: 1, kind: 'handnote-notebook', app: 'HandNote', exportedAt: new Date().toISOString(),
    notebook: { id: nb.id, title: nb.title, cover: nb.cover, background: nb.background, tone: nb.tone, createdAt: nb.createdAt, updatedAt: nb.updatedAt, pageOrder: nb.pageOrder },
    pages: pages.map(function (p) { return { id: p.id, background: p.background, strokes: p.strokes, updatedAt: p.updatedAt }; })
  };
}
function exportNotebookJson(nb) {
  H.busy(true);
  H.DB.pagesOf(nb.id).then(function (pages) {
    var data = notebookPayload(nb, pages);
    H.busy(false);
    H.download(new Blob([JSON.stringify(data)], { type: 'application/json' }), safeName(nb.title) + '.handnote.json');
    H.toast('JSON 으로 내보냈습니다', 'ok');
  });
}
function exportAllJson() {
  H.busy(true);
  H.DB.all('notebooks').then(function (nbs) {
    return H.DB.all('pages').then(function (pages) {
      var out = { v: 1, kind: 'handnote-backup', exportedAt: new Date().toISOString(), notebooks: [] };
      nbs.forEach(function (nb) {
        out.notebooks.push(notebookPayload(nb, pages.filter(function (p) { return p.notebookId === nb.id; })));
      });
      H.busy(false);
      H.download(new Blob([JSON.stringify(out)], { type: 'application/json' }), 'handnote-backup-' + new Date().toISOString().slice(0, 10) + '.json');
      H.toast(nbs.length + '개 공책을 백업했습니다', 'ok');
    });
  });
}
function importJson() {
  H.pickFile('.json,application/json').then(function (f) {
    if (!f) return;
    H.busy(true);
    f.text().then(function (txt) {
      var data = JSON.parse(txt);
      var list = data.notebooks ? data.notebooks : [data];
      var jobs = [];
      list.forEach(function (entry) {
        var nb = entry.notebook || {};
        var fresh = H.newNotebook(nb.title || f.name.replace(/\.json$/i, ''));
        fresh.cover = nb.cover || fresh.cover;
        fresh.background = nb.background || 'dot';
        fresh.tone = nb.tone || 'white';
        fresh.createdAt = nb.createdAt || Date.now();
        fresh.updatedAt = Date.now();
        var pages = (entry.pages || []).map(function (p) {
          return { id: H.uid('pg'), notebookId: fresh.id, background: p.background, strokes: p.strokes || [], updatedAt: Date.now(), createdAt: Date.now() };
        });
        if (!pages.length) pages.push(H.newPage(fresh.id));
        fresh.pageOrder = pages.map(function (p) { return p.id; });
        fresh.pageCount = pages.length;
        jobs.push(H.DB.put('notebooks', fresh).then(function () { return H.DB.putMany('pages', pages); }).then(function () {
          S.notebooks.unshift(fresh);
        }));
      });
      Promise.all(jobs).then(function () {
        H.busy(false);
        renderNbList();
        H.toast(list.length + '개 공책을 가져왔습니다', 'ok');
        if (list.length) openNotebook(S.notebooks[0].id);
      }).catch(function (e) { H.busy(false); H.toast('가져오기 실패: ' + e.message, 'err'); });
    }).catch(function (e) { H.busy(false); H.toast('파일을 읽지 못했습니다: ' + e.message, 'err'); });
  });
}
function exportMenu(anchor) {
  popover(anchor, { title: '내보내기', alignRight: true, items: [
    { icon: 'i-image', label: '이 쪽 PNG', sub: '지금 보고 있는 쪽', run: exportPagePng },
    { icon: 'i-image', label: '모든 쪽 PNG', sub: S.pages.length + '개 파일로 저장', run: exportAllPng },
    { icon: 'i-pdf', label: '이 공책 PDF', sub: '인쇄 · 공유용 한 파일', run: exportPdf },
    { hr: true },
    { icon: 'i-download', label: '이 공책 JSON', run: function () { exportNotebookJson(S.nb); } },
    { icon: 'i-download', label: '전체 백업 JSON', run: exportAllJson },
    { icon: 'i-upload', label: 'JSON 가져오기', run: importJson }
  ] });
}

/* ── 구글 드라이브 ─────────────────────────────────────────── */
var Drive = (function () {
  var GSI = 'https://accounts.google.com/gsi/client';
  var SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
  var loading = null;

  function hasId() { return !!(S.prefs.driveClientId || '').trim(); }
  function loadSdk() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = GSI; s.async = true; s.defer = true;
      s.onload = function () { res(); };
      s.onerror = function () { loading = null; rej(new Error('Google 로그인 스크립트를 불러오지 못했습니다 (오프라인이거나 차단됨)')); };
      document.head.appendChild(s);
    });
    return loading;
  }
  function token(interactive) {
    if (S.drive.token && Date.now() < S.drive.exp - 60000) return Promise.resolve(S.drive.token);
    if (!hasId()) return Promise.reject(new Error('Google 클라이언트 ID 가 필요합니다'));
    return loadSdk().then(function () {
      return new Promise(function (res, rej) {
        var tc = google.accounts.oauth2.initTokenClient({
          client_id: S.prefs.driveClientId.trim(), scope: SCOPE,
          callback: function (r) {
            if (r && r.access_token) {
              S.drive.token = r.access_token;
              S.drive.exp = Date.now() + (r.expires_in ? r.expires_in * 1000 : 3300000);
              res(r.access_token);
            } else rej(new Error((r && r.error) || '인증이 취소되었습니다'));
          },
          error_callback: function (err) { rej(new Error((err && err.message) || '인증 창을 열 수 없습니다 (팝업 차단을 확인하세요)')); }
        });
        try { tc.requestAccessToken({ prompt: interactive ? 'consent' : '' }); }
        catch (e) { rej(e); }
      });
    });
  }
  function api(url, opts) {
    opts = opts || {};
    var headers = Object.assign({ Authorization: 'Bearer ' + S.drive.token }, opts.headers || {});
    return fetch(url, Object.assign({}, opts, { headers: headers })).then(function (r) {
      if (r.status === 401) { S.drive.token = null; throw new Error('인증이 만료되었습니다. 다시 연결해 주세요.'); }
      if (!r.ok) {
        return r.text().then(function (t) {
          var m = 'Drive 오류 ' + r.status;
          try { var j = JSON.parse(t); if (j.error && j.error.message) m += ': ' + j.error.message; } catch (e) { }
          throw new Error(m);
        });
      }
      if (r.status === 204) return null;
      return r.json();
    });
  }
  function ensureFolder() {
    if (S.drive.folderId) return Promise.resolve(S.drive.folderId);
    var name = (S.prefs.driveFolder || 'HandNote').trim();
    var q = "mimeType='application/vnd.google-apps.folder' and name='" + name.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "' and trashed=false";
    return api('https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id,name)&q=' + encodeURIComponent(q))
      .then(function (r) {
        if (r.files && r.files.length) return r.files[0].id;
        return api('https://www.googleapis.com/drive/v3/files?fields=id', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, mimeType: 'application/vnd.google-apps.folder' })
        }).then(function (f) { return f.id; });
      })
      .then(function (id) { S.drive.folderId = id; return id; });
  }
  function listFiles(folderId) {
    var q = "'" + folderId + "' in parents and trashed=false";
    return api('https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000&orderBy=modifiedTime desc' +
      '&fields=files(id,name,modifiedTime,appProperties)&q=' + encodeURIComponent(q))
      .then(function (r) { return r.files || []; });
  }
  function saveFile(fileId, nb, payload, folderId) {
    var meta = {
      name: safeName(nb.title) + ' (' + nb.id.slice(-6) + ').json',
      mimeType: 'application/json',
      appProperties: { handnote: '1', nbId: nb.id }
    };
    if (!fileId) meta.parents = [folderId];
    var b = 'hnb' + Math.random().toString(36).slice(2);
    var body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
      '\r\n--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(payload) +
      '\r\n--' + b + '--';
    var url = 'https://www.googleapis.com/upload/drive/v3/files' + (fileId ? '/' + fileId : '') +
      '?uploadType=multipart&fields=id,modifiedTime';
    return api(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body });
  }
  function getMedia(fileId) {
    return api('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media');
  }
  function pushOne(nb, remote, folderId) {
    return H.DB.pagesOf(nb.id).then(function (pages) {
      return saveFile(remote ? remote.id : null, nb, notebookPayload(nb, pages), folderId);
    }).then(function (f) {
      if (f && f.id) {
        nb.driveFileId = f.id;
        if (f.modifiedTime) nb.driveMod = Date.parse(f.modifiedTime);
      }
      nb.updatedAt = Date.now();
      return H.DB.put('notebooks', nb);
    });
  }
  function pullOne(remote) {
    var nbId = (remote.appProperties || {}).nbId;
    return getMedia(remote.id).then(function (data) {
      if (!data || !data.pages) throw new Error('백업 파일 형식이 아닙니다');
      var nb = data.notebook || {};
      var fresh = {
        id: nbId, title: nb.title || '드라이브 공책', cover: nb.cover || H.COVERS[0],
        background: nb.background || 'dot', tone: nb.tone || 'white',
        createdAt: nb.createdAt || Date.now(), updatedAt: Date.now(),
        driveFileId: remote.id, driveMod: Date.parse(remote.modifiedTime || '') || 0
      };
      var pages = data.pages.map(function (p) {
        return { id: H.uid('pg'), notebookId: nbId, background: p.background, strokes: p.strokes || [], updatedAt: Date.now(), createdAt: Date.now() };
      });
      if (!pages.length) pages.push(H.newPage(nbId));
      fresh.pageOrder = pages.map(function (p) { return p.id; });
      fresh.pageCount = pages.length;
      return H.DB.pagesOf(nbId).then(function (old) {
        return H.DB.delMany('pages', old.map(function (p) { return p.id; }));
      }).then(function () {
        return H.DB.put('notebooks', fresh);
      }).then(function () {
        return H.DB.putMany('pages', pages);
      });
    });
  }
  function setBadge(state, msg) {
    var b = $('#syncBadge');
    if (!b) return;
    b.style.display = state ? '' : 'none';
    b.className = 'badge' + (state === 'err' ? ' err' : state === 'busy' ? ' warn' : '');
    if (msg) $('#btnSync').title = msg;
  }
  function sync(dir, silent) {
    if (S.drive.syncing) return Promise.resolve(null);
    if (!hasId()) { if (!silent) { openSettings(); H.toast('설정에서 Google 클라이언트 ID 를 먼저 입력하세요', 'err'); } return Promise.resolve(null); }
    setBadge('busy', '동기화 중…');
    S.drive.syncing = true;
    return token(!silent).then(function () { return ensureFolder(); }).then(function (fid) {
      return listFiles(fid).then(function (files) {
        var byNb = {};
        files.forEach(function (f) { var p = f.appProperties || {}; if (p.nbId) byNb[p.nbId] = f; });
        var up = 0, dn = 0, jobs = [];
        return H.DB.all('notebooks').then(function (locals) {
          locals.forEach(function (nb) {
            var rem = byNb[nb.id];
            var lTs = nb.updatedAt || 0;
            var rTs = rem ? (Date.parse(rem.modifiedTime) || 0) : 0;
            if (dir === 'down') { if (rem) jobs.push(pullOne(rem).then(function () { dn++; })); return; }
            if (dir === 'up' || !rem || lTs > rTs + 2000) { jobs.push(pushOne(nb, rem, fid).then(function () { up++; })); return; }
            if (rTs > lTs + 2000) jobs.push(pullOne(rem).then(function () { dn++; }));
          });
          if (dir !== 'up') {
            files.forEach(function (f) {
              var p = f.appProperties || {};
              if (!p.nbId) return;
              if (!locals.some(function (n) { return n.id === p.nbId; })) jobs.push(pullOne(f).then(function () { dn++; }));
            });
          }
          return Promise.all(jobs).then(function () { return { up: up, dn: dn }; });
        });
      });
    }).then(function (r) {
      S.drive.syncing = false;
      S.drive.lastSync = Date.now();
      S.drive.error = null;
      setBadge(S.prefs.autoSync ? 'ok' : null, '마지막 동기화 ' + H.fmtDate(Date.now()));
      renderSettingsIfOpen();
      if (!silent) H.toast('동기화 완료 · 올림 ' + r.up + ' · 내림 ' + r.dn, 'ok', 3000);
      return H.DB.all('notebooks').then(function (list) {
        S.notebooks = list.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
        renderNbList();
        if (r.dn > 0) return openNotebook(S.prefs.lastNb || S.notebooks[0].id);
      });
    }).catch(function (e) {
      S.drive.syncing = false;
      S.drive.error = e.message;
      setBadge('err', e.message);
      renderSettingsIfOpen();
      if (!silent) H.toast(e.message, 'err', 4200);
    });
  }
  return { sync: sync, connect: function () { return token(true).then(function () { H.toast('구글 드라이브에 연결되었습니다', 'ok'); }).catch(function (e) { H.toast(e.message, 'err'); throw e; }); }, setBadge: setBadge, hasId: hasId, getToken: function () { return S.drive.token; } };
})();
window._HN.Drive = Drive;
H.driveAutoCheck = function () { };

/* ── 설정 시트 ─────────────────────────────────────────────── */
function rangeRow(id, min, max, step, val, fmt) {
  return '<div class="range-row"><input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '"><span class="val" id="' + id + 'V">' + fmt(val) + '</span></div>';
}
var sheetEl = null;
function openSettings() {
  closeSheet();
  var p = S.prefs;
  var html =
    '<div class="sheet-hd"><h2>설정</h2><span style="flex:1"></span>' +
    '<button class="ibtn" id="sheetX" title="닫기"><svg><use href="#i-close"/></svg></button></div>' +
    '<div class="sheet-bd">' +

    '<div class="fld"><label>펜</label>' +
    '<div class="switch"><span class="lbl">필압 반영<small>펜을 세게 누르면 굵게 · 살짝 누르면 가늘게</small></span><button class="tog" id="tPressure" role="switch"></button></div>' +
    '<div style="margin-top:8px"><span class="ebrow">필압 민감도</span>' + rangeRow('setPressure', 0, 1, 0.05, p.pressure, function (v) { return Math.round(v * 100) + '%'; }) + '</div>' +
    '<div style="margin-top:10px"><span class="ebrow">손떨림 보정</span>' + rangeRow('setSmooth', 0, 1, 0.05, p.smoothing, function (v) { return Math.round(v * 100) + '%'; }) + '</div>' +
    '</div>' +

    '<div class="fld"><label>입력</label>' +
    '<div class="switch"><span class="lbl">손바닥 무시<small>펜을 쓴 직후의 손 터치를 무시합니다</small></span><button class="tog" id="tPalm" role="switch"></button></div>' +
    '<div class="switch" style="margin-top:8px"><span class="lbl">손가락으로도 필기<small>끄면 한 손가락은 화면 이동이 됩니다</small></span><button class="tog" id="tTouch" role="switch"></button></div>' +
    '</div>' +

    '<div class="fld"><label>화면</label>' +
    '<div class="seg" id="themeSeg">' +
    '<button data-v="light"' + (p.theme === 'light' ? ' class="on"' : '') + '>밝게</button>' +
    '<button data-v="dark"' + (p.theme === 'dark' ? ' class="on"' : '') + '>어둡게</button>' +
    '<button data-v="auto"' + (p.theme === 'auto' ? ' class="on"' : '') + '>시스템</button></div>' +
    '<div class="hint">쪽 목록은 오른쪽 아래 버튼이나 <b>B</b> 키로 접고 펼 수 있습니다.</div>' +
    '</div>' +

    '<div class="fld"><label>구글 드라이브 동기화</label>' +
    '<div id="driveStatus"></div>' +
    '<div style="margin-top:10px"><span class="ebrow">OAuth 클라이언트 ID</span>' +
    '<input class="inp" id="driveClient" placeholder="1234567890-xxxxxxxx.apps.googleusercontent.com" value="' + esc(p.driveClientId || '') + '"></div>' +
    '<div style="margin-top:10px"><span class="ebrow">드라이브 폴더 이름</span>' +
    '<input class="inp" id="driveFolder" value="' + esc(p.driveFolder || 'HandNote') + '"></div>' +
    '<div class="hint">Google Cloud Console → <b>API 및 서비스</b> → <b>사용자 인증 정보</b> 에서 OAuth 클라이언트 ID(웹 애플리케이션)를 만들고, ' +
    '승인된 JavaScript 출처에 이 앱 주소를 추가하세요. Google Drive API 도 사용 설정해야 합니다. ' +
    '노트는 <b>내 드라이브</b>의 <b>' + esc(p.driveFolder || 'HandNote') + '</b> 폴더에만 저장되며, 앱은 자기가 만든 파일만 읽습니다.</div>' +
    '<div class="switch" style="margin-top:10px"><span class="lbl">자동 동기화<small>공책을 열 때 조용히 맞춥니다</small></span><button class="tog" id="tAuto" role="switch"></button></div>' +
    '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' +
    '<button class="btn" id="dConnect"><svg><use href="#i-cloud"/></svg>연결</button>' +
    '<button class="btn primary" id="dSync"><svg><use href="#i-sync"/></svg>지금 동기화</button>' +
    '<button class="btn" id="dUp"><svg><use href="#i-upload"/></svg>올리기</button>' +
    '<button class="btn" id="dDown"><svg><use href="#i-download"/></svg>가져오기</button>' +
    '</div></div>' +

    '<div class="fld"><label>저장소</label>' +
    '<div class="status-card" id="storeStatus"><svg><use href="#i-info"/></svg><span class="grow"><b id="storeTitle">—</b><em id="storeSub">—</em></span></div>' +
    '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' +
    '<button class="btn" id="sBackup"><svg><use href="#i-download"/></svg>전체 백업</button>' +
    '<button class="btn" id="sRestore"><svg><use href="#i-upload"/></svg>백업 복원</button>' +
    '<button class="btn danger" id="sWipe"><svg><use href="#i-trash"/></svg>모두 삭제</button>' +
    '</div>' +
    '<div class="hint">모든 필기는 이 브라우저(IndexedDB)에 먼저 저장됩니다. 브라우저 데이터를 지우면 사라지므로 중요한 공책은 정기적으로 백업하세요.</div>' +
    '</div>' +

    '<div class="fld"><label>정보</label>' +
    '<div class="hint">HandNote · 단일 HTML 필기 노트 · 오프라인 동작 · <span id="verLine">v1.0</span></div>' +
    '</div>' +
    '</div>' +
    '<div class="sheet-ft"><button class="btn primary wide" id="sheetDone">닫기</button></div>';

  var scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  var sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = html;
  $('#layer').appendChild(scrim); $('#layer').appendChild(sheet);
  sheetEl = { scrim: scrim, sheet: sheet };

  scrim.onclick = closeSheet;
  $('#sheetX', sheet).onclick = closeSheet;
  $('#sheetDone', sheet).onclick = closeSheet;

  function tog(id, key, onChange) {
    var b = $('#' + id, sheet);
    b.setAttribute('aria-checked', S.prefs[key] ? 'true' : 'false');
    b.onclick = function () {
      S.prefs[key] = !S.prefs[key];
      b.setAttribute('aria-checked', S.prefs[key] ? 'true' : 'false');
      H.savePrefs();
      if (onChange) onChange();
    };
  }
  tog('tPressure', 'pressure'); tog('tPalm', 'palmReject');
  tog('tTouch', 'touchDraw'); tog('tAuto', 'autoSync', function () { Drive.setBadge(S.prefs.autoSync && S.drive.token ? 'ok' : null); });

  var pr = $('#setPressure', sheet), sm = $('#setSmooth', sheet);
  pr.oninput = function () { S.prefs.pressure = +pr.value; $('#setPressureV', sheet).textContent = Math.round(pr.value * 100) + '%'; H.savePrefs(); };
  sm.oninput = function () { S.prefs.smoothing = +sm.value; $('#setSmoothV', sheet).textContent = Math.round(sm.value * 100) + '%'; H.savePrefs(); };

  sheet.querySelectorAll('#themeSeg button').forEach(function (b) {
    b.onclick = function () { applyTheme(b.dataset.v); sheet.querySelectorAll('#themeSeg button').forEach(function (x) { x.classList.toggle('on', x === b); }); };
  });

  var dc = $('#driveClient', sheet), df = $('#driveFolder', sheet);
  dc.onchange = function () { S.prefs.driveClientId = dc.value.trim(); H.savePrefs(); S.drive.token = null; S.drive.folderId = null; renderSettingsIfOpen(); };
  df.onchange = function () { S.prefs.driveFolder = df.value.trim() || 'HandNote'; H.savePrefs(); S.drive.folderId = null; };

  $('#dConnect', sheet).onclick = function () { Drive.connect().catch(function () { }); };
  $('#dSync', sheet).onclick = function () { Drive.sync('both'); };
  $('#dUp', sheet).onclick = function () { Drive.sync('up'); };
  $('#dDown', sheet).onclick = function () { Drive.sync('down'); };

  $('#sBackup', sheet).onclick = exportAllJson;
  $('#sRestore', sheet).onclick = importJson;
  $('#sWipe', sheet).onclick = function () {
    confirmBox('모든 데이터를 지울까요?', '이 브라우저에 저장된 모든 공책과 필기가 삭제됩니다. 백업이 없다면 되돌릴 수 없습니다.', '모두 삭제', function () {
      H.DB.wipe().then(function () { location.reload(); });
    }, true);
  };
  renderSettingsIfOpen();
  updateQuota();
}
function closeSheet() {
  if (!sheetEl) return;
  sheetEl.scrim.remove(); sheetEl.sheet.remove();
  sheetEl = null;
}
function renderSettingsIfOpen() {
  if (!sheetEl) return;
  var host = $('#driveStatus', sheetEl.sheet);
  if (!host) return;
  var d = S.drive;
  var cls = d.error ? 'err' : d.token ? 'ok' : '';
  var title = d.error ? '연결 문제' : d.token ? '연결됨' : Drive.hasId() ? '연결 준비됨' : '클라이언트 ID 필요';
  var sub = d.error ? d.error : d.token ? ('토큰 유효 · 만료 ' + H.fmtDate(d.exp)) :
    Drive.hasId() ? '“연결” 을 눌러 구글 계정으로 승인하세요' : '아래에 OAuth 클라이언트 ID 를 붙여넣으세요';
  host.innerHTML = '<div class="status-card ' + cls + '"><svg><use href="#' + (d.error ? 'i-warn' : 'i-cloud') + '"/></svg>' +
    '<span class="grow"><b>' + esc(title) + '</b><em>' + esc(sub) + '</em></span></div>' +
    (d.lastSync ? '<div class="hint">마지막 동기화: ' + H.fmtDate(d.lastSync) + '</div>' : '');
}
function updateQuota() {
  H.DB.estimate().then(function (e) {
    if (!e) { $('#quotaTxt').textContent = '사용량 정보 없음'; return; }
    var used = e.usage || 0, q = e.quota || 0;
    $('#quotaTxt').textContent = H.fmtBytes(used);
    $('#quotaBar').style.width = q ? Math.min(100, used / q * 100).toFixed(1) + '%' : '0%';
    var st = $('#storeStatus');
    if (st) {
      $('#storeTitle', st).textContent = H.DB.isMemory() ? '메모리 모드 (임시)' : '이 브라우저에 저장 중';
      $('#storeSub', st).textContent = H.DB.isMemory()
        ? 'IndexedDB 를 쓸 수 없습니다. 창을 닫으면 필기가 사라집니다 — HTTPS 주소로 열어 주세요.'
        : '사용 ' + H.fmtBytes(used) + (q ? ' / 전체 ' + H.fmtBytes(q) : '');
      if (H.DB.isMemory()) st.classList.add('err');
    }
  });
}

/* ── 키보드 ────────────────────────────────────────────────── */
function isTyping(e) {
  var t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
function keys(e) {
  if (isTyping(e)) return;
  var mod = e.ctrlKey || e.metaKey;
  var k = e.key;
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? H.redo() : H.undo(); return; }
  if (mod && k.toLowerCase() === 'y') { e.preventDefault(); H.redo(); return; }
  if (mod && k.toLowerCase() === 'a') { e.preventDefault(); setTool('lasso'); H.canvas.selectAll(); return; }
  if (mod && k.toLowerCase() === 'd') { e.preventDefault(); H.canvas.duplicateSel(); return; }
  if (mod && k.toLowerCase() === 's') { e.preventDefault(); exportPdf(); return; }
  if (mod) return;
  switch (k) {
    case 'p': case 'P': setTool('pen'); break;
    case 'h': case 'H': setTool('highlighter'); break;
    case 'e': case 'E': setTool('eraser'); break;
    case 'l': case 'L': setTool('lasso'); break;
    case 't': case 'T': applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); break;
    case 'b': case 'B': toggleTray(); break;
    case 'n': case 'N': addPage(); break;
    case '0': H.canvas.fit(); break;
    case '+': case '=': H.canvas.zoomCenter(1.15); break;
    case '-': case '_': H.canvas.zoomCenter(1 / 1.15); break;
    case '[': setSize(S.prefs.size - 0.6); break;
    case ']': setSize(S.prefs.size + 0.6); break;
    case 'ArrowLeft': case 'PageUp': goPage(S.pageIdx - 1); break;
    case 'ArrowRight': case 'PageDown': goPage(S.pageIdx + 1); break;
    case 'Delete': case 'Backspace':
      if (S.sel.length) { e.preventDefault(); H.canvas.deleteSel(); }
      break;
    case 'Escape':
      if (S.sel.length) H.canvas.clearSel();
      else if (sheetEl) closeSheet();
      else closePops();
      break;
  }
}

/* ── 트레이 토글 ───────────────────────────────────────────── */
function toggleTray() {
  S.prefs.trayHidden = !S.prefs.trayHidden;
  document.body.classList.toggle('tray-hidden', S.prefs.trayHidden);
  H.savePrefs();
  setTimeout(function () { H.canvas.fit(); }, 220);
}
function toggleSide() {
  if (window.innerWidth <= 900) document.body.classList.toggle('side-open');
  else { S.prefs.sideCollapsed = !S.prefs.sideCollapsed; document.body.classList.toggle('side-collapsed', S.prefs.sideCollapsed); H.savePrefs(); }
  setTimeout(function () { H.canvas.fit(); }, 240);
}

/* ── 첫 안내 ───────────────────────────────────────────────── */
function showHint(msg, ms) {
  var h = $('#hint');
  if (!h) return;
  h.innerHTML = msg;
  h.classList.add('show');
  clearTimeout(h._t);
  h._t = setTimeout(function () { h.classList.remove('show'); }, ms || 4200);
}

/* ── 부팅 ─────────────────────────────────────────────────── */
function wireUI() {
  $('#btnTheme').onclick = function () { applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); };
  $('#btnSettings').onclick = openSettings;
  $('#btnSideToggle').onclick = toggleSide;
  $('#btnTrayToggle').onclick = toggleTray;
  $('#btnTrayHide').onclick = toggleTray;
  $('#btnNewNb').onclick = newNotebookDialog;
  $('#btnPgDup').onclick = duplicatePage;
  $('#btnPgDel').onclick = deletePage;
  $('#nbSearch').oninput = H.debounce(renderNbList, 120);
  $('#btnUndo').onclick = H.undo;
  $('#btnRedo').onclick = H.redo;
  $('#btnSync').onclick = function () { Drive.sync('both'); };
  $('#btnClear').onclick = H.canvas.clearPage;
  $('#btnPaper').onclick = function () { paperMenu(this); };
  $('#btnExport').onclick = function () { exportMenu(this); };
  $('#pgPrev').onclick = function () { goPage(S.pageIdx - 1); };
  $('#pgNext').onclick = function () { goPage(S.pageIdx + 1); };
  $('#zIn').onclick = function () { H.canvas.zoomCenter(1.15); };
  $('#zOut').onclick = function () { H.canvas.zoomCenter(1 / 1.15); };
  $('#zFit').onclick = function () { H.canvas.fit(); };
  $('#btnBackup').onclick = exportAllJson;

  $('#nbSwitch').onclick = function () { nbSwitchMenu(this); };

  $$('.tool').forEach(function (b) { b.onclick = function () { setTool(b.dataset.tool); }; });
  $('#penSize').oninput = function () { setSize(this.value); };

  // 드래그앤드롭으로 JSON 가져오기
  ['dragenter', 'dragover'].forEach(function (t) {
    window.addEventListener(t, function (e) { e.preventDefault(); });
  });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.json$/i.test(f.name)) { H.toast('JSON 백업 파일만 가져올 수 있습니다', 'err'); return; }
    var dt = new DataTransfer(); dt.items.add(f);
    var inp = document.createElement('input'); inp.type = 'file';
    Object.defineProperty(inp, 'files', { value: dt.files });
    inp.dispatchEvent(new Event('change'));
  });

  window.addEventListener('keydown', keys);
  window.addEventListener('beforeunload', function () { H.savePrefs(); });

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && document.body.classList.contains('side-open')) document.body.classList.remove('side-open');
  });
}
function nbSwitchMenu(anchor) {
  var items = S.notebooks.slice(0, 12).map(function (nb) {
    return { icon: 'i-book', label: nb.title, sub: (nb.pageCount || 0) + '쪽 · ' + H.fmtDate(nb.updatedAt || nb.createdAt), run: function () { openNotebook(nb.id); } };
  });
  items.push({ hr: true });
  items.push({ icon: 'i-plus', label: '새 공책', run: newNotebookDialog });
  items.push({ icon: 'i-gear', label: '설정', run: openSettings });
  popover(anchor, { title: '공책', items: items });
}

function boot() {
  applyTheme(S.prefs.theme || 'light');
  document.body.classList.toggle('tray-hidden', !!S.prefs.trayHidden);
  document.body.classList.toggle('side-collapsed', !!S.prefs.sideCollapsed);
  buildSwatches();
  setTool(S.prefs.tool); setColor(S.prefs.color); setSize(S.prefs.size);
  wireUI();
  H.canvas.init();
  // 저장소 로드 전에도 빈 종이가 즉시 보이도록 첫 화면을 먼저 그린다.
  var ph = H.newNotebook('불러오는 중…');
  S.nb = ph; S.pages = [H.newPage(ph.id)]; S.pageIdx = 0;
  renderHeader(); renderTray(); syncPageUI(); H.refreshHistoryUI(); renderNbList();
  H.canvas.rebuildCommit(); H.canvas.fit();
  setTimeout(function () {
    if (!S.nb) H.toast('저장소가 응답하지 않습니다 — 새로 고치거나 HTTPS 주소(배포 주소)로 열어 주세요', 'err', 7000);
  }, 6000);

  H.DB.all('notebooks').then(function (list) {
    S.notebooks = list.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    if (!S.notebooks.length) {
      var nb = H.newNotebook('첫 공책');
      return H.DB.put('notebooks', nb).then(function () { S.notebooks = [nb]; });
    }
  }).then(function () {
    renderNbList();
    var id = (S.prefs.lastNb && S.notebooks.some(function (n) { return n.id === S.prefs.lastNb; })) ? S.prefs.lastNb : (S.notebooks[0] && S.notebooks[0].id);
    if (!id) return;
    return openNotebook(id).then(function () {
      syncPageUI();
      if (S.prefs.showHint) {
        S.prefs.showHint = false; H.savePrefs();
        showHint('펜으로 바로 쓰세요 · <kbd>P</kbd> 펜 <kbd>E</kbd> 지우개 <kbd>Ctrl+Z</kbd> 되돌리기 · 두 손가락으로 이동/확대', 7000);
      }
      updateQuota();
    });
  }).catch(function (e) {
    console.error(e);
    H.toast('시작 중 문제가 발생했습니다: ' + e.message, 'err', 5000);
  });

  if (H.DB.isMemory()) setTimeout(function () { H.toast('IndexedDB 를 쓸 수 없어 임시 모드입니다 — HTTPS 주소로 열어 주세요', 'err', 6000); }, 1200);

  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () { });
    });
  }
  if (window.matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (S.prefs.theme === 'auto') applyTheme('auto');
    });
  }
}
H.confirmBox = confirmBox;
H.promptBox = promptBox;
H.syncPageUI = syncPageUI;
H.updateQuota = updateQuota;
H.openNotebook = openNotebook;
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
})();
