/* ═══════════════════════════════════════════════════════════════
   HandNote — part 1 : 상수 · 유틸 · 저장소 · 종이/획 렌더링 · 히스토리
   ═══════════════════════════════════════════════════════════════ */
(function () {
'use strict';

var CFG = Object.assign({ googleClientId: '', driveFolderName: 'HandNote' }, window.HANDNOTE_CONFIG || {});

var PAGE_W = 1240, PAGE_H = 1754;   // A4 150dpi 기준 좌표계 (세로)
var RULE = 31;                      // 괘선 간격
var MARGIN_X = 92;                  // 공책 세로 여백선 위치
var PT = 3;                         // 점 1개당 값 수: x, y, pressure
var MAX_UNDO = 80;

var COVERS = ['#1F5FD0','#C0392B','#2E7D5B','#B7791F','#6B4FBB','#0E7490','#9A3412','#334155','#9D174D','#4D7C0F'];
var INKS   = ['#1B1A17','#1F5FD0','#C0392B','#2E7D5B','#B7791F','#6B4FBB','#0E7490','#E9E5DC'];
var PAPERS = { dot: '도트', grid: '모눈', ruled: '줄', blank: '무지' };
var TONES  = { white: '#ffffff', warm: '#fbf7ee', dark: '#262320' };

/* ── 유틸 ───────────────────────────────────────────────────── */
var $  = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function uid(p) { return (p || 'id') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function fmtDate(ts) {
  var d = new Date(ts), n = new Date();
  var p2 = function (v) { return String(v).padStart(2, '0'); };
  if (d.toDateString() === n.toDateString()) return p2(d.getHours()) + ':' + p2(d.getMinutes());
  var y = d.getFullYear() !== n.getFullYear() ? d.getFullYear() + '. ' : '';
  return y + (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
}
function fmtBytes(b) {
  if (!b && b !== 0) return '—';
  if (b < 1024) return b + ' B';
  var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return (b < 10 ? b.toFixed(1) : Math.round(b)) + ' ' + u[i];
}
function debounce(fn, ms) {
  var t = null;
  return function () {
    var a = arguments, self = this;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(self, a); }, ms);
  };
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function toast(msg, kind, ms) {
  var host = $('#toasts');
  if (!host) { console.log('[toast]', msg); return; }
  var ico = kind === 'err' ? 'i-warn' : kind === 'ok' ? 'i-check' : 'i-info';
  var t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.innerHTML = '<svg><use href="#' + ico + '"/></svg><span>' + esc(msg) + '</span>';
  host.appendChild(t);
  setTimeout(function () {
    t.classList.add('out');
    setTimeout(function () { t.remove(); }, 240);
  }, ms || 2200);
}
function busy(on) {
  var b = $('#busy');
  if (!b) return;
  if (on) { b.style.width = '34%'; setTimeout(function () { b.style.width = '72%'; }, 400); }
  else { b.style.width = '100%'; setTimeout(function () { b.style.width = '0'; }, 320); }
}
function download(blob, name) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}
function pickFile(accept) {
  return new Promise(function (res) {
    var i = document.createElement('input');
    i.type = 'file'; i.accept = accept || '';
    i.style.position = 'fixed'; i.style.left = '-9999px';
    document.body.appendChild(i);
    i.addEventListener('change', function () { res(i.files && i.files[0] || null); i.remove(); });
    i.click();
  });
}

/* ── 저장소: IndexedDB, 실패 시 메모리 폴백 ─────────────────── */
var DB = (function () {
  var NAME = 'handnote', VER = 1, _db = null, mem = null;
  // file:// 로 직접 열면 브라우저가 IndexedDB 호출을 멈춰 세우는 경우가 있어 바로 메모리 모드로 갑니다.
  var _broken = (location.protocol === 'file:');

  function memdb() {
    if (!mem) {
      mem = { notebooks: new Map(), pages: new Map(), meta: new Map() };
      console.warn('[HandNote] IndexedDB 를 쓸 수 없어 메모리 모드로 동작합니다.');
    }
    return mem;
  }
  function open() {
    if (_db) return Promise.resolve(_db);
    if (_broken) return Promise.reject(new Error('idb-unavailable'));
    return new Promise(function (res, rej) {
      var rq;
      try { rq = indexedDB.open(NAME, VER); }
      catch (e) { _broken = true; rej(e); return; }
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains('notebooks')) db.createObjectStore('notebooks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) {
          var s = db.createObjectStore('pages', { keyPath: 'id' });
          s.createIndex('notebookId', 'notebookId');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      };
      rq.onsuccess = function () { _db = rq.result; res(_db); };
      rq.onerror = function () { _broken = true; rej(rq.error || new Error('idb-open-failed')); };
      rq.onblocked = function () { };
    });
  }
  function req(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function run(store, mode, fn) {
    return open().then(function (db) {
      return req(fn(db.transaction(store, mode).objectStore(store)));
    });
  }

  return {
    isMemory: function () { return _broken; },
    all: function (store) {
      return run(store, 'readonly', function (s) { return s.getAll(); })
        .catch(function () { return Array.from(memdb()[store].values()); });
    },
    get: function (store, id) {
      return run(store, 'readonly', function (s) { return s.get(id); })
        .catch(function () { return memdb()[store].get(id); });
    },
    put: function (store, val) {
      return run(store, 'readwrite', function (s) { return s.put(val); })
        .catch(function () { memdb()[store].set(val.id || val.k, val); return val; });
    },
    putMany: function (store, vals) {
      if (!vals.length) return Promise.resolve();
      return open().then(function (db) {
        var t = db.transaction(store, 'readwrite'), s = t.objectStore(store);
        vals.forEach(function (v) { s.put(v); });
        return new Promise(function (res, rej) { t.oncomplete = res; t.onerror = function () { rej(t.error); }; });
      }).catch(function () { vals.forEach(function (v) { memdb()[store].set(v.id || v.k, v); }); });
    },
    del: function (store, id) {
      return run(store, 'readwrite', function (s) { return s.delete(id); })
        .catch(function () { memdb()[store].delete(id); });
    },
    delMany: function (store, ids) {
      if (!ids.length) return Promise.resolve();
      return open().then(function (db) {
        var t = db.transaction(store, 'readwrite'), s = t.objectStore(store);
        ids.forEach(function (id) { s.delete(id); });
        return new Promise(function (res, rej) { t.oncomplete = res; t.onerror = function () { rej(t.error); }; });
      }).catch(function () { ids.forEach(function (id) { memdb()[store].delete(id); }); });
    },
    pagesOf: function (nbId) {
      return run('pages', 'readonly', function (s) { return s.index('notebookId').getAll(nbId); })
        .catch(function () {
          return Array.from(memdb().pages.values()).filter(function (p) { return p.notebookId === nbId; });
        });
    },
    estimate: function () {
      if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
      return navigator.storage.estimate().catch(function () { return null; });
    },
    wipe: function () {
      return open().then(function (db) { db.close(); _db = null; return req(indexedDB.deleteDatabase(NAME)); })
        .catch(function () { });
    }
  };
})();

/* ── 환경 설정(로컬) ────────────────────────────────────────── */
var PREFS_KEY = 'handnote:prefs:v1';
var PREFS_DEF = {
  theme: 'light', tool: 'pen', color: '#1B1A17', size: 2.6,
  pressure: 0.55, smoothing: 0.45, palmReject: true, touchDraw: true,
  trayHidden: false, sideCollapsed: false, showHint: true,
  driveClientId: '', driveFolder: CFG.driveFolderName, lastNb: null, autoSync: false
};
function loadPrefs() {
  var p = Object.assign({}, PREFS_DEF);
  try {
    var raw = localStorage.getItem(PREFS_KEY);
    if (raw) Object.assign(p, JSON.parse(raw));
  } catch (e) { }
  if (!p.driveClientId && CFG.googleClientId) p.driveClientId = CFG.googleClientId;
  return p;
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(S.prefs)); } catch (e) { }
}

/* ── 앱 상태 ────────────────────────────────────────────────── */
var S = {
  notebooks: [],
  nb: null,
  pages: [],
  pageIdx: 0,
  view: { scale: 1, x: 0, y: 0 },
  prefs: loadPrefs(),
  sel: [],
  history: [], hIdx: -1,
  live: null,
  erase: null,
  lasso: null,
  drag: null,
  hover: null,
  dirtyPages: new Set(),
  drive: { token: null, exp: 0, folderId: null, email: '', syncing: false, lastSync: 0, error: null },
  ready: false
};
var pageOf = function (id) {
  for (var i = 0; i < S.pages.length; i++) if (S.pages[i].id === id) return S.pages[i];
  return null;
};
var curPage = function () { return S.pages[S.pageIdx] || null; };
var idxOfPage = function (id) {
  for (var i = 0; i < S.pages.length; i++) if (S.pages[i].id === id) return i;
  return -1;
};

/* ── 종이(괘선) 렌더링 ─────────────────────────────────────── */
function drawPaper(ctx, w, h, type, tone) {
  var bg = TONES[tone] || TONES.white;
  var dark = tone === 'dark';
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  if (type !== 'blank') {
    ctx.strokeStyle = dark ? 'rgba(255,255,255,.115)' : 'rgba(44,68,112,.24)';
    ctx.fillStyle = dark ? 'rgba(255,255,255,.20)' : 'rgba(44,68,112,.36)';
    ctx.lineWidth = 1;
    var x, y;
    if (type === 'grid') {
      ctx.beginPath();
      for (x = RULE; x < w; x += RULE) { ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, h); }
      for (y = RULE; y < h; y += RULE) { ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(w, Math.round(y) + .5); }
      ctx.stroke();
    } else if (type === 'dot') {
      for (x = RULE; x < w; x += RULE) {
        for (y = RULE; y < h; y += RULE) {
          ctx.beginPath();
          ctx.arc(x, y, 2.2, 0, 6.2832);
          ctx.fill();
        }
      }
    } else if (type === 'ruled') {
      ctx.strokeStyle = dark ? 'rgba(255,255,255,.14)' : 'rgba(44,68,112,.26)';
      ctx.beginPath();
      for (y = RULE * 2; y < h; y += RULE * 2) { ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(w, Math.round(y) + .5); }
      ctx.stroke();
      ctx.strokeStyle = dark ? 'rgba(255,255,255,.22)' : 'rgba(44,68,112,.38)';
      ctx.beginPath();
      ctx.moveTo(0, 0.5); ctx.lineTo(w, 0.5);
      ctx.stroke();
    }
    // 공책 세로 여백선
    ctx.strokeStyle = dark ? 'rgba(201,99,79,.7)' : 'rgba(210,80,60,.66)';
    ctx.lineWidth = 1.9;
    ctx.beginPath();
    ctx.moveTo(MARGIN_X + .5, 0); ctx.lineTo(MARGIN_X + .5, h);
    ctx.stroke();
  }
  ctx.restore();
}

/* ── 획(스트로크) ──────────────────────────────────────────── */
function widthFactor(p, gamma) {
  p = clamp(p, 0.02, 1);
  return 0.22 + 0.78 * Math.pow(p, gamma);
}
function pressureGamma() { return 0.45 + (1 - S.prefs.pressure) * 1.35; }

function drawStroke(ctx, s, opts) {
  var pp = s.p, n = pp.length / PT;
  if (!n) return;
  opts = opts || {};
  var alpha = s.t === 'high' ? (s.a || 0.32) : 1;
  var g = pressureGamma();
  ctx.save();
  ctx.globalCompositeOperation = s.t === 'high' ? 'multiply' : 'source-over';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = s.c;

  if (n === 1) {
    var r = Math.max(0.6, (s.w * (s.t === 'high' ? 1 : widthFactor(pp[2], g))) / 2);
    ctx.beginPath();
    ctx.arc(pp[0], pp[1], r, 0, 6.2832);
    ctx.fill();
    ctx.restore();
    return;
  }
  var i, x0, y0, p0, x1, y1, p1, w0, w1, dx, dy, len, nx, ny;
  for (i = 0; i < n - 1; i++) {
    x0 = pp[i * PT]; y0 = pp[i * PT + 1]; p0 = pp[i * PT + 2];
    x1 = pp[(i + 1) * PT]; y1 = pp[(i + 1) * PT + 1]; p1 = pp[(i + 1) * PT + 2];
    w0 = s.t === 'high' ? s.w : s.w * widthFactor(p0, g);
    w1 = s.t === 'high' ? s.w : s.w * widthFactor(p1, g);
    if (w0 < 0.4) w0 = 0.4;
    if (w1 < 0.4) w1 = 0.4;
    dx = x1 - x0; dy = y1 - y0;
    len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
    nx = -dy / len; ny = dx / len;
    ctx.beginPath();
    ctx.moveTo(x0 + nx * w0 / 2, y0 + ny * w0 / 2);
    ctx.lineTo(x1 + nx * w1 / 2, y1 + ny * w1 / 2);
    ctx.lineTo(x1 - nx * w1 / 2, y1 - ny * w1 / 2);
    ctx.lineTo(x0 - nx * w0 / 2, y0 - ny * w0 / 2);
    ctx.closePath();
    ctx.fill();
    if (s.t !== 'high' && i % 1 === 0) {
      ctx.beginPath();
      ctx.arc(x0, y0, w0 / 2, 0, 6.2832);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawStrokes(ctx, list, opts) {
  for (var i = 0; i < list.length; i++) drawStroke(ctx, list[i], opts);
}

/* 연속 점 단순화 (RDP-lite) */
function simplify(pts, tol) {
  if (pts.length < 3 * PT) return pts;
  var out = [pts[0], pts[1], pts[2]], i, lx = pts[0], ly = pts[1], px, py, d;
  for (i = 1; i < pts.length / PT - 1; i++) {
    px = pts[i * PT]; py = pts[i * PT + 1];
    d = Math.abs(px - lx) + Math.abs(py - ly);
    if (d >= tol) { out.push(px, py, pts[i * PT + 2]); lx = px; ly = py; }
  }
  out.push(pts[pts.length - 3], pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}

/* 이동평균 스무딩(입력 중 1회) */
function smoothPts(pts, amt) {
  if (amt <= 0 || pts.length < 3 * PT * 3) return pts;
  var k = amt * 0.5, out = pts.slice(), n = pts.length / PT, i;
  for (i = 1; i < n - 1; i++) {
    out[i * PT]     = pts[i * PT]     * (1 - k) + (pts[(i - 1) * PT] + pts[(i + 1) * PT]) * k / 2;
    out[i * PT + 1] = pts[i * PT + 1] * (1 - k) + (pts[(i - 1) * PT + 1] + pts[(i + 1) * PT + 1]) * k / 2;
  }
  // 압력도 살짝 평활
  for (i = 1; i < n - 1; i++) {
    out[i * PT + 2] = clamp(pts[i * PT + 2] * (1 - k * 0.6) + (pts[(i - 1) * PT + 2] + pts[(i + 1) * PT + 2]) * k * 0.3, 0.02, 1);
  }
  return out;
}

function strokeBounds(s) {
  var pp = s.p, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, i;
  for (i = 0; i < pp.length; i += PT) {
    if (pp[i] < x0) x0 = pp[i];
    if (pp[i] > x1) x1 = pp[i];
    if (pp[i + 1] < y0) y0 = pp[i + 1];
    if (pp[i + 1] > y1) y1 = pp[i + 1];
  }
  return { x0: x0, y0: y0, x1: x1, y1: y1 };
}
function boundsOf(list) {
  var b = null, i, s;
  for (i = 0; i < list.length; i++) {
    s = strokeBounds(list[i]);
    if (!b) b = s;
    else { b.x0 = Math.min(b.x0, s.x0); b.y0 = Math.min(b.y0, s.y0); b.x1 = Math.max(b.x1, s.x1); b.y1 = Math.max(b.y1, s.y1); }
  }
  return b;
}
function segDist(px, py, ax, ay, bx, by) {
  var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  if (!l2) return Math.hypot(px - ax, py - ay);
  var t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function strokeHit(s, x, y, tol) {
  var pp = s.p, n = pp.length / PT, i, d;
  var r = tol + s.w * 0.5;
  if (n === 1) return Math.hypot(x - pp[0], y - pp[1]) <= r;
  for (i = 0; i < n - 1; i++) {
    d = segDist(x, y, pp[i * PT], pp[i * PT + 1], pp[(i + 1) * PT], pp[(i + 1) * PT + 1]);
    if (d <= r + (s.t === 'high' ? s.w * 0.4 : 0)) return true;
  }
  return false;
}
function pointInPoly(x, y, poly) {
  var inside = false, i, j;
  for (i = 0, j = poly.length / 2 - 1; i < poly.length / 2; j = i++) {
    var xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function strokeInPoly(s, poly) {
  var pp = s.p, n = pp.length / PT, i, hits = 0, step = Math.max(1, Math.floor(n / 24));
  for (i = 0; i < n; i += step) {
    if (pointInPoly(pp[i * PT], pp[i * PT + 1], poly)) hits++;
  }
  if (hits > 0) return true;
  if (n === 1) return pointInPoly(pp[0], pp[1], poly);
  return false;
}

/* ── 히스토리(실행 취소/다시 실행) ─────────────────────────── */
function pushHistory(cmd) {
  S.history = S.history.slice(0, S.hIdx + 1);
  S.history.push(cmd);
  if (S.history.length > MAX_UNDO) S.history.shift();
  S.hIdx = S.history.length - 1;
  refreshHistoryUI();
}
function applyCmd(cmd, forward) {
  var p = pageOf(cmd.pageId);
  if (!p) return;
  if (cmd.t === 'add') {
    if (forward) p.strokes.push(cmd.stroke);
    else {
      var i = p.strokes.indexOf(cmd.stroke);
      if (i >= 0) p.strokes.splice(i, 1);
    }
  } else if (cmd.t === 'del') {
    if (forward) {
      cmd.strokes.forEach(function (s) {
        var k = p.strokes.indexOf(s);
        if (k >= 0) p.strokes.splice(k, 1);
      });
    } else {
      p.strokes = cmd.strokes.concat(p.strokes);
    }
  } else if (cmd.t === 'clear') {
    if (forward) p.strokes = [];
    else p.strokes = cmd.strokes.slice();
  } else if (cmd.t === 'move') {
    var dx = forward ? cmd.dx : -cmd.dx, dy = forward ? cmd.dy : -cmd.dy;
    p.strokes.forEach(function (s) {
      if (cmd.ids.indexOf(s.id) < 0) return;
      for (var i = 0; i < s.p.length; i += PT) { s.p[i] += dx; s.p[i + 1] += dy; }
    });
  } else if (cmd.t === 'pts') {
    p.strokes.forEach(function (s) {
      var k = cmd.ids.indexOf(s.id);
      if (k < 0) return;
      s.p = (forward ? cmd.after[k] : cmd.before[k]).slice();
    });
  } else if (cmd.t === 'order') {
    p.strokes = forward ? cmd.after.slice() : cmd.before.slice();
  }
  markDirty(p);
}
function undo() {
  if (S.hIdx < 0) { toast('되돌릴 작업이 없습니다'); return; }
  var cmd = S.history[S.hIdx];
  S.hIdx--;
  applyCmd(cmd, false);
  var i = idxOfPage(cmd.pageId);
  if (i >= 0 && i !== S.pageIdx) { S.pageIdx = i; }
  afterHistory(cmd.pageId);
  refreshHistoryUI();
}
function redo() {
  if (S.hIdx >= S.history.length - 1) { toast('다시 실행할 작업이 없습니다'); return; }
  var cmd = S.history[S.hIdx + 1];
  S.hIdx++;
  applyCmd(cmd, true);
  var i = idxOfPage(cmd.pageId);
  if (i >= 0 && i !== S.pageIdx) { S.pageIdx = i; }
  afterHistory(cmd.pageId);
  refreshHistoryUI();
}
function afterHistory(pageId) {
  var p = pageOf(pageId);
  if (p) markDirty(p);
  window._HN.rebuildCommit();
  window._HN.render();
  window._HN.syncPageUI();
  queuePageSave(p);
}
function refreshHistoryUI() {
  var u = $('#btnUndo'), r = $('#btnRedo');
  if (u) u.disabled = S.hIdx < 0;
  if (r) r.disabled = S.hIdx >= S.history.length - 1;
}

/* ── 노트북/쪽 관리 ───────────────────────────────────────── */
function newPage(nbId, first) {
  return {
    id: uid('pg'), notebookId: nbId, strokes: [], updatedAt: Date.now(),
    background: first || null, createdAt: Date.now(), driveFileId: null, dirty: false
  };
}
function newNotebook(title) {
  var used = S.notebooks.map(function (n) { return n.cover; });
  var cover = COVERS.filter(function (c) { return used.indexOf(c) < 0; })[0] || COVERS[Math.floor(Math.random() * COVERS.length)];
  return {
    id: uid('nb'), title: title || '새 공책', cover: cover, createdAt: Date.now(), updatedAt: Date.now(),
    pageOrder: [], background: 'dot', tone: 'white', driveFileId: null, driveMod: 0
  };
}

/* ── 저장 ──────────────────────────────────────────────────── */
var pageSaveTimers = {};
function queuePageSave(page) {
  if (!page) return;
  setDirtyLabel(true);
  clearTimeout(pageSaveTimers[page.id]);
  pageSaveTimers[page.id] = setTimeout(function () {
    page.dirty = true;
    DB.put('pages', page).then(function () {
      setDirtyLabel(false);
    });
  }, 420);
}
function queueNbSave(nb) {
  if (!nb) return;
  nb.updatedAt = Date.now();
  setDirtyLabel(true);
  clearTimeout(nb._t);
  nb._t = setTimeout(function () {
    DB.put('notebooks', nb).then(function () { setDirtyLabel(false); });
  }, 420);
}
var _dirtyCount = 0;
function setDirtyLabel(on) {
  _dirtyCount = Math.max(0, _dirtyCount + (on ? 1 : -1));
  var e = $('#saveState');
  if (!e) return;
  if (_dirtyCount > 0) { e.textContent = '저장 중…'; e.style.color = 'var(--warn)'; }
  else { e.textContent = '로컬 저장됨'; e.style.color = ''; }
}
function markDirty(page) {
  if (!page) return;
  page.updatedAt = Date.now();
  window._HN.markThumbDirty(page.id);
  queuePageSave(page);
  if (S.nb) queueNbSave(S.nb);
}

/* 전역 노출 (다른 part 에서 사용) */
window._HN = {
  S: S, CFG: CFG,
  PAGE_W: PAGE_W, PAGE_H: PAGE_H, RULE: RULE, MARGIN_X: MARGIN_X, PT: PT,
  COVERS: COVERS, INKS: INKS, PAPERS: PAPERS, TONES: TONES,
  $: $, $$: $$, clamp: clamp, uid: uid, esc: esc, toast: toast, busy: busy, download: download,
  pickFile: pickFile, fmtDate: fmtDate, fmtBytes: fmtBytes, debounce: debounce,
  DB: DB, savePrefs: savePrefs,
  drawPaper: drawPaper, drawStroke: drawStroke, drawStrokes: drawStrokes,
  simplify: simplify, smoothPts: smoothPts, widthFactor: widthFactor,
  strokeBounds: strokeBounds, boundsOf: boundsOf, strokeHit: strokeHit,
  strokeInPoly: strokeInPoly, pointInPoly: pointInPoly,
  pushHistory: pushHistory, undo: undo, redo: redo, refreshHistoryUI: refreshHistoryUI,
  newPage: newPage, newNotebook: newNotebook, pageOf: pageOf, curPage: curPage, idxOfPage: idxOfPage,
  markDirty: markDirty, queuePageSave: queuePageSave, queueNbSave: queueNbSave,
  markThumbDirty: function (id) { if (window._HN._thumbDirty) window._HN._thumbDirty.add(id); },
  _thumbDirty: new Set(),
  rebuildCommit: function () { }, render: function () { }, syncPageUI: function () { }
};
})();
