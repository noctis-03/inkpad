/* ═══════════════════════════════════════════════════════════════
   HandNote — part 2 : 캔버스 · 뷰포트 · 필기 엔진 · 제스처 · 썸네일
   ═══════════════════════════════════════════════════════════════ */
(function () {
'use strict';
var H = window._HN, S = H.S, $ = H.$, clamp = H.clamp;
var PAGE_W = H.PAGE_W, PAGE_H = H.PAGE_H, PT = H.PT;

var cv, ctx, commit, cctx;
var dpr = 1, raf = 0, commitPageId = null, needRebuild = false;
var pointers = new Map(), penSeenAt = 0, lastPtrType = 'mouse';
var spaceDown = false, gest = null, panDrag = null;

/* ── 초기화 ─────────────────────────────────────────────────── */
function init() {
  cv = $('#cv'); ctx = cv.getContext('2d');
  cv.style.position = 'absolute';
  commit = document.createElement('canvas');
  commit.width = PAGE_W; commit.height = PAGE_H;
  cctx = commit.getContext('2d');

  dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);

  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onHover);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  cv.addEventListener('wheel', onWheel, { passive: false });
  cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  cv.addEventListener('dblclick', function () { if (S.tool === 'lasso') selectAll(); });

  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && !isTyping(e)) { spaceDown = true; cv.style.cursor = 'grab'; }
  });
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space') { spaceDown = false; cv.style.cursor = cursorFor(); }
  });
  window.addEventListener('resize', function () {
    var d = clamp(window.devicePixelRatio || 1, 1, 2.5);
    if (Math.abs(d - dpr) > 0.01) { dpr = d; applyView(); }
    render();
  });
  applyView();
}
function isTyping(e) {
  var t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
function cursorFor() {
  if (S.tool === 'lasso') return 'crosshair';
  if (S.tool === 'pan') return 'grab';
  return 'none';
}

/* ── 뷰포트 ─────────────────────────────────────────────────── */
function wrapCenter() {
  var r = $('#paperWrap').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}
function applyView() {
  var v = S.view, sc = v.scale;
  var w = PAGE_W * sc, h = PAGE_H * sc;
  cv.style.width = w.toFixed(2) + 'px';
  cv.style.height = h.toFixed(2) + 'px';
  var bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  cv.style.left = '50%'; cv.style.top = '50%';
  cv.style.marginLeft = (-w / 2).toFixed(2) + 'px';
  cv.style.marginTop = (-h / 2).toFixed(2) + 'px';
  cv.style.transform = 'translate(' + v.x.toFixed(2) + 'px,' + v.y.toFixed(2) + 'px)';
  var zt = $('#zTxt'); if (zt) zt.textContent = Math.round(sc * 100) + '%';
}
function fit(animate) {
  var c = wrapCenter();
  var pad = c.w < 640 ? 14 : 44;
  var sc = Math.min((c.w - pad * 2) / PAGE_W, (c.h - pad * 2) / PAGE_H);
  S.view.scale = clamp(sc, 0.1, 4);
  S.view.x = 0; S.view.y = 0;
  applyView(); render();
}
function setScale(sc, sx, sy) {
  sc = clamp(sc, 0.1, 8);
  var c = wrapCenter();
  var px = (sx - c.x - S.view.x) / S.view.scale;
  var py = (sy - c.y - S.view.y) / S.view.scale;
  S.view.scale = sc;
  S.view.x = sx - c.x - px * sc;
  S.view.y = sy - c.y - py * sc;
  applyView(); render();
}
function zoomCenter(f) {
  var c = wrapCenter();
  setScale(S.view.scale * f, c.x, c.y);
}
function onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    setScale(S.view.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
  } else {
    S.view.x -= e.deltaX; S.view.y -= e.deltaY;
    applyView(); render();
  }
}

/* ── 렌더 ───────────────────────────────────────────────────── */
function render() {
  if (raf) return;
  raf = requestAnimationFrame(paint);
}
function paint() {
  raf = 0;
  var p = H.curPage();
  var k = S.view.scale * dpr;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, PAGE_W, PAGE_H);
  if (!p) return;

  if (needRebuild) { rebuildCommit(); needRebuild = false; }
  var vector = k > 1.42;
  if (vector) {
    H.drawPaper(ctx, PAGE_W, PAGE_H, p.background || S.nb.background, S.nb.tone || 'white');
    H.drawStrokes(ctx, p.strokes);
  } else {
    if (commitPageId !== p.id) rebuildCommit();
    ctx.drawImage(commit, 0, 0, PAGE_W, PAGE_H);
  }
  if (S.live) H.drawStroke(ctx, S.live);
  overlays();
}
function rebuildCommit() {
  var p = H.curPage();
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  cctx.clearRect(0, 0, PAGE_W, PAGE_H);
  commitPageId = p ? p.id : null;
  if (!p) return;
  H.drawPaper(cctx, PAGE_W, PAGE_H, p.background || S.nb.background, S.nb.tone || 'white');
  H.drawStrokes(cctx, p.strokes);
}
function commitStroke(s) { H.drawStroke(cctx, s); }

function overlays() {
  var acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1F5FD0';
  ctx.save();
  if (S.sel && S.sel.length) {
    ctx.globalAlpha = 0.28;
    S.sel.forEach(function (s) {
      var c = { id: s.id, t: s.t, c: acc, w: s.w + 6, p: s.p, a: 1 };
      H.drawStroke(ctx, c);
    });
    ctx.globalAlpha = 1;
    var b = H.boundsOf(S.sel);
    if (b) {
      ctx.setLineDash([9, 7]);
      ctx.lineWidth = 2 / S.view.scale;
      ctx.strokeStyle = acc;
      ctx.strokeRect(b.x0 - 14, b.y0 - 14, (b.x1 - b.x0) + 28, (b.y1 - b.y0) + 28);
      ctx.setLineDash([]);
    }
  }
  if (S.lasso && S.lasso.poly && S.lasso.poly.length >= 4) {
    ctx.lineWidth = 1.8 / S.view.scale;
    ctx.strokeStyle = acc;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(S.lasso.poly[0], S.lasso.poly[1]);
    for (var i = 2; i < S.lasso.poly.length; i += 2) ctx.lineTo(S.lasso.poly[i], S.lasso.poly[i + 1]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (S.erase) {
    ctx.lineWidth = 1.6 / S.view.scale;
    ctx.strokeStyle = acc;
    ctx.beginPath();
    ctx.arc(S.erase.x, S.erase.y, S.erase.r, 0, 6.2832);
    ctx.stroke();
  }
  if (S.hover && !S.live && S.tool !== 'lasso' && lastPtrType !== 'touch') {
    var r = S.tool === 'eraser' ? S.prefs.size * 4 + 8 : Math.max(3, S.prefs.size * (S.tool === 'highlighter' ? 6 : 1) / 2);
    ctx.lineWidth = 1.4 / S.view.scale;
    ctx.strokeStyle = 'rgba(127,127,127,.75)';
    ctx.beginPath();
    ctx.arc(S.hover.x, S.hover.y, Math.max(2.5, r), 0, 6.2832);
    ctx.stroke();
  }
  ctx.restore();
}

/* ── 좌표/입력 유틸 ────────────────────────────────────────── */
function toPage(e) {
  var r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) / S.view.scale, y: (e.clientY - r.top) / S.view.scale };
}
function onHover(e) {
  if (e.pointerType && e.pointerType !== 'mouse') lastPtrType = e.pointerType;
  S.hover = toPage(e);
  if (!S.live && !S.erase && !S.lasso && !panDrag && !gest) render();
}
function pressureOf(e, dist) {
  if (e.pointerType === 'pen' && e.pressure > 0.005) return clamp(e.pressure * 1.15, 0.03, 1);
  return clamp(0.86 - dist * 0.014, 0.26, 0.86);   // 마우스/터치: 속도 기반 굵기
}

/* ── 포인터 다운 ───────────────────────────────────────────── */
function onDown(e) {
  if (!S.ready || !S.nb) return;
  if (e.pointerType === 'pen') penSeenAt = Date.now();
  else if (e.pointerType === 'touch') lastPtrType = 'touch';

  // 손바닥 무시: 펜 사용 직후의 터치는 무시
  if (e.pointerType === 'touch' && S.prefs.palmReject && Date.now() - penSeenAt < 2500) return;

  if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (err) { } }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

  if (pointers.size === 2) {
    if (S.live) { S.live = null; }
    S.erase = null; S.lasso = null;
    startGesture();
    return;
  }
  if (pointers.size > 2) return;

  if (e.button === 2 && e.pointerType === 'mouse') return;
  if (e.button === 1 || spaceDown || S.tool === 'pan' || (e.pointerType === 'touch' && !S.prefs.touchDraw)) {
    panDrag = { sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y };
    document.body.dataset.dragging = '1';
    cv.style.cursor = 'grabbing';
    return;
  }

  var pt = toPage(e);
  if (S.tool === 'eraser') { startErase(pt); return; }
  if (S.tool === 'lasso') {
    if (S.sel.length && insideSel(pt)) { startMoveSel(pt); return; }
    S.sel = []; window._HN.onSelection && window._HN.onSelection();
    S.lasso = { poly: [pt.x, pt.y] };
    render();
    return;
  }
  if (S.sel.length) { S.sel = []; window._HN.onSelection && window._HN.onSelection(); }
  startStroke(pt, e);
}

/* ── 필기 ──────────────────────────────────────────────────── */
function startStroke(pt, e) {
  var high = S.tool === 'highlighter';
  S.live = {
    id: H.uid('s'), t: high ? 'high' : 'pen',
    c: high ? S.prefs.highColor || S.prefs.color : S.prefs.color,
    w: S.prefs.size * (high ? 6 : 1),
    a: high ? 0.3 : 1,
    src: e.pointerType,
    p: [pt.x, pt.y, pressureOf(e, 0)]
  };
  render();
}
function appendPoint(e, coalesced) {
  var p = S.live; if (!p) return;
  var list = (coalesced && e.getCoalescedEvents) ? e.getCoalescedEvents() : null;
  var n = list && list.length ? list.length : 1;
  for (var i = 0; i < n; i++) {
    var ev = list && list.length ? list[i] : e;
    var q = toPage(ev);
    var last = p.p.length - PT;
    var dx = q.x - p.p[last], dy = q.y - p.p[last];
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.6) continue;
    p.p.push(q.x, q.y, pressureOf(ev, d));
  }
}
function endStroke() {
  var s = S.live; S.live = null;
  if (!s) return;
  s.p = H.simplify(H.smoothPts(s.p, S.prefs.smoothing), 1.05);
  if (s.p.length < PT) { render(); return; }
  var p = H.curPage(); if (!p) { render(); return; }
  p.strokes.push(s);
  commitStroke(s);
  H.pushHistory({ t: 'add', pageId: p.id, stroke: s });
  H.markDirty(p);
  render();
}

/* ── 지우개 ────────────────────────────────────────────────── */
function startErase(pt) {
  S.erase = { x: pt.x, y: pt.y, r: S.prefs.size * 4 + 10, removed: [] };
  eraseAt(pt); render();
}
function eraseAt(pt) {
  var p = H.curPage(); if (!p || !S.erase) return;
  S.erase.x = pt.x; S.erase.y = pt.y;
  var r = S.erase.r, rest = [], i;
  for (i = 0; i < p.strokes.length; i++) {
    var s = p.strokes[i];
    if (H.strokeHit(s, pt.x, pt.y, r)) S.erase.removed.push(s);
    else rest.push(s);
  }
  if (rest.length !== p.strokes.length) { p.strokes = rest; needRebuild = true; render(); }
}
function endErase() {
  var e = S.erase; S.erase = null;
  if (!e || !e.removed.length) { render(); return; }
  var p = H.curPage();
  H.pushHistory({ t: 'del', pageId: p.id, strokes: e.removed });
  H.markDirty(p);
  needRebuild = true; render();
}

/* ── 올가미 선택 ───────────────────────────────────────────── */
function insideSel(pt) {
  var b = H.boundsOf(S.sel);
  return b && pt.x >= b.x0 - 16 && pt.x <= b.x1 + 16 && pt.y >= b.y0 - 16 && pt.y <= b.y1 + 16;
}
function startMoveSel(pt) {
  var ids = S.sel.map(function (s) { return s.id; });
  var before = S.sel.map(function (s) { return s.p.slice(); });
  var b = H.boundsOf(S.sel);
  S.drag = { ids: ids, before: before, base: before.map(function (a) { return a.slice(); }), sx: pt.x, sy: pt.y, b: b };
}
function moveSel(pt) {
  var d = S.drag; if (!d) return;
  var dx = pt.x - d.sx, dy = pt.y - d.sy;
  S.sel.forEach(function (s, i) {
    var src = d.base[i], out = new Array(src.length);
    for (var k = 0; k < src.length; k += PT) { out[k] = src[k] + dx; out[k + 1] = src[k + 1] + dy; out[k + 2] = src[k + 2]; }
    s.p = out;
  });
  needRebuild = true; render();
}
function endMoveSel() {
  var d = S.drag; S.drag = null;
  var p = H.curPage();
  if (!d || !p) return;
  var dx = S.sel[0].p[0] - d.before[0][0], dy = S.sel[0].p[1] - d.before[0][1];
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
  var after = S.sel.map(function (s) { return s.p.slice(); });
  H.pushHistory({ t: 'pts', pageId: p.id, ids: d.ids, before: d.before, after: after });
  H.markDirty(p);
}
function endLasso() {
  var l = S.lasso; S.lasso = null;
  if (!l) return;
  var poly = l.poly || [];
  if (poly.length < 6) { S.sel = []; window._HN.onSelection && window._HN.onSelection(); render(); return; }
  var p = H.curPage(); if (!p) return;
  S.sel = p.strokes.filter(function (s) { return H.strokeInPoly(s, poly); });
  window._HN.onSelection && window._HN.onSelection();
  if (S.sel.length) window._HN.toast(S.sel.length + '개 획을 선택했습니다');
  render();
}
function selectAll() {
  var p = H.curPage(); if (!p) return;
  S.sel = p.strokes.slice();
  window._HN.onSelection && window._HN.onSelection();
  render();
}
function clearSel() { S.sel = []; window._HN.onSelection && window._HN.onSelection(); render(); }
function deleteSel() {
  var p = H.curPage();
  if (!p || !S.sel.length) return;
  var removed = S.sel.slice();
  p.strokes = p.strokes.filter(function (s) { return removed.indexOf(s) < 0; });
  S.sel = [];
  H.pushHistory({ t: 'del', pageId: p.id, strokes: removed });
  H.markDirty(p);
  window._HN.onSelection && window._HN.onSelection();
  needRebuild = true; render();
  window._HN.toast(removed.length + '개 획을 지웠습니다');
}
function duplicateSel() {
  var p = H.curPage();
  if (!p || !S.sel.length) return;
  var copies = S.sel.map(function (s) {
    var o = { id: H.uid('s'), t: s.t, c: s.c, w: s.w, a: s.a, p: new Array(s.p.length) };
    for (var i = 0; i < s.p.length; i += PT) { o.p[i] = s.p[i] + 34; o.p[i + 1] = s.p[i + 1] + 34; o.p[i + 2] = s.p[i + 2]; }
    return o;
  });
  copies.forEach(function (c) { p.strokes.push(c); commitStroke(c); });
  S.sel = copies;
  H.pushHistory({ t: 'order', pageId: p.id, before: p.strokes.slice(0, p.strokes.length - copies.length), after: p.strokes.slice() });
  H.markDirty(p);
  render();
}

/* ── 이동(팬) / 제스처 ─────────────────────────────────────── */
function startGesture() {
  var a = Array.from(pointers.values());
  if (a.length < 2) return;
  gest = {
    d: Math.max(1, Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y)),
    cx: (a[0].x + a[1].x) / 2, cy: (a[0].y + a[1].y) / 2,
    scale: S.view.scale, vx: S.view.x, vy: S.view.y
  };
}
function moveGesture() {
  var a = Array.from(pointers.values());
  if (!gest || a.length < 2) return;
  var c = wrapCenter();
  var d = Math.max(1, Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y));
  var mx = (a[0].x + a[1].x) / 2, my = (a[0].y + a[1].y) / 2;
  var sc = clamp(gest.scale * (d / gest.d), 0.1, 8);
  var px = (gest.cx - c.x - gest.vx) / gest.scale;
  var py = (gest.cy - c.y - gest.vy) / gest.scale;
  S.view.scale = sc;
  S.view.x = mx - c.x - px * sc;
  S.view.y = my - c.y - py * sc;
  applyView(); render();
}

/* ── 포인터 무브/업 ────────────────────────────────────────── */
function onMove(e) {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  if (gest) { moveGesture(); return; }
  if (panDrag) {
    S.view.x = panDrag.vx + (e.clientX - panDrag.sx);
    S.view.y = panDrag.vy + (e.clientY - panDrag.sy);
    applyView(); return;
  }
  if (!pointers.size) return;
  var pt = toPage(e);
  if (S.live) { appendPoint(e, true); render(); }
  else if (S.erase) eraseAt(pt);
  else if (S.lasso) { S.lasso.poly.push(pt.x, pt.y); render(); }
  else if (S.drag) moveSel(pt);
}
function onUp(e) {
  pointers.delete(e.pointerId);
  if (gest) {
    if (pointers.size < 2) { gest = null; }
    return;
  }
  if (panDrag) {
    panDrag = null;
    document.body.removeAttribute('data-dragging');
    cv.style.cursor = cursorFor();
    return;
  }
  if (S.live) endStroke();
  else if (S.erase) endErase();
  else if (S.lasso) endLasso();
  else if (S.drag) endMoveSel();
}

/* ── 쪽 비우기 ─────────────────────────────────────────────── */
function clearPage() {
  var p = H.curPage(); if (!p) return;
  window._HN.confirmBox('이 쪽을 비울까요?', '되돌리기(Ctrl+Z)로 복구할 수 있습니다.', '비우기', function () {
    if (!p.strokes.length) return;
    var before = p.strokes.slice();
    p.strokes = [];
    H.pushHistory({ t: 'clear', pageId: p.id, strokes: before });
    H.markDirty(p);
    S.sel = []; needRebuild = true; render();
  });
}

/* ── 썸네일 ────────────────────────────────────────────────── */
function drawThumb(page, canvas, w, h) {
  var c = canvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, canvas.width, canvas.height);
  var k = canvas.width / PAGE_W;
  c.setTransform(k, 0, 0, k, 0, 0);
  H.drawPaper(c, PAGE_W, PAGE_H, page.background || (S.nb && S.nb.background) || 'dot', (S.nb && S.nb.tone) || 'white');
  H.drawStrokes(c, page.strokes);
}
function pageBitmap(page, scale) {
  var c = document.createElement('canvas');
  c.width = Math.round(PAGE_W * scale); c.height = Math.round(PAGE_H * scale);
  var x = c.getContext('2d');
  x.setTransform(scale, 0, 0, scale, 0, 0);
  H.drawPaper(x, PAGE_W, PAGE_H, page.background || (S.nb && S.nb.background) || 'dot', (S.nb && S.nb.tone) || 'white');
  H.drawStrokes(x, page.strokes);
  return c;
}

/* ── 등록 ─────────────────────────────────────────────────── */
H.canvas = {
  init: init, render: render, rebuildCommit: rebuildCommit, applyView: applyView,
  fit: fit, setScale: setScale, zoomCenter: zoomCenter, clearPage: clearPage,
  drawThumb: drawThumb, pageBitmap: pageBitmap, needRebuild: function () { needRebuild = true; },
  selectAll: selectAll, clearSel: clearSel, deleteSel: deleteSel, duplicateSel: duplicateSel,
  getSel: function () { return S.sel; }
};
H.rebuildCommit = function () { rebuildCommit(); };
H.render = function () { render(); };
})();
