/* HEI Network for LG webOS — personal, unofficial client.
 * Uses the site's own app API (hei-app/v1): public catalogue, activation-code sign-in,
 * and playback URLs that the API only returns for a signed-in member. */
'use strict';

const API = 'https://www.heinetwork.tv/wp-json';
const NS = 'hei-app/v1';
const KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, ESC: 27, BKSP: 8,
  PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412 };

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const decoder = document.createElement('textarea');
const txt = s => { decoder.innerHTML = s == null ? '' : String(s); return decoder.value; };
const esc = s => txt(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clean = p => String(p || '').replace(/^\/+|\/+$/g, '');

function secs(d) {            // API gives "418" or "14:55" or "1:02:03"
  if (d == null || d === '') return 0;
  if (/^\d+(\.\d+)?$/.test(String(d))) return +d;
  return String(d).split(':').reduce((a, n) => a * 60 + (+n || 0), 0);
}
function clock(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
}

/* ---------- auth + api ---------- */
const auth = {
  get token() { return localStorage.getItem('hei.token') || ''; },
  set token(v) { v ? localStorage.setItem('hei.token', v) : localStorage.removeItem('hei.token'); },
};
async function api(path, { method = 'GET', body, ns = NS, anon = false } = {}) {
  const headers = {};
  if (auth.token && !anon) headers.Authorization = 'Bearer ' + auth.token;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${API}/${ns}/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store' });
  let data = null;
  try { data = await r.json(); } catch (e) { /* non-JSON error page */ }
  if (!r.ok) { const err = new Error((data && (data.message || data.error)) || `HTTP ${r.status}`); err.status = r.status; err.data = data; throw err; }
  return data;
}
function findToken(o, depth = 0) {      // activation result shape is not documented; look for a token-ish field
  if (!o || typeof o !== 'object' || depth > 4) return '';
  for (const k of ['token', 'jwt', 'access_token', 'accessToken', 'auth_token']) if (typeof o[k] === 'string' && o[k].length > 20) return o[k];
  for (const v of Object.values(o)) { const t = findToken(v, depth + 1); if (t) return t; }
  return '';
}
function findStream(o, depth = 0) {     // playback_url may be a string or a wrapper object
  if (typeof o === 'string') return /^https?:\/\//.test(o) ? o : '';
  if (!o || typeof o !== 'object' || depth > 4) return '';
  for (const k of ['url', 'playback_url', 'hls', 'src', 'data']) { const t = findStream(o[k], depth + 1); if (t) return t; }
  return '';
}

/* ---------- saved progress ---------- */
// Episode responses carry no resume position, and the home feed's durations are unreliable,
// so positions always come from video-progress/v1. Returns {episodeId: {pos, dur}} for unfinished episodes.
async function savedProgress() {
  if (!auth.token) return {};
  try {
    const list = await api('resume', { ns: 'video-progress/v1' });
    const map = {};
    (Array.isArray(list) ? list : []).forEach(r => { if (!+r.finished) map[String(r.episode_id)] = { pos: +r.position_seconds || 0, dur: +r.duration_seconds || 0 }; });
    return map;
  } catch (e) { console.warn('[hei] could not read saved progress:', e.message); return {}; }
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, ms = 4000) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms); }

/* ---------- screen stack + focus ---------- */
const stack = [];
const topScreen = () => stack[stack.length - 1];
function push(build) {
  const prev = topScreen();
  if (prev) { prev.last = document.activeElement; prev.el.hidden = true; }
  const s = { el: el('div', 'screen'), last: null, cleanup: null };
  $('#stack').appendChild(s.el); stack.push(s);
  s.el.appendChild(el('div', 'spinner'));
  Promise.resolve(build(s)).then(() => { const sp = $('.spinner', s.el); if (sp) sp.remove(); if (topScreen() === s) focusFirst(s); })
    .catch(e => { s.el.innerHTML = ''; s.el.appendChild(el('div', 'center', `<h1>Something went wrong</h1><p>${esc(e.message)}</p><p class="muted">Press BACK</p>`)); console.error(e); });
  return s;
}
function pop() {
  if (stack.length <= 1) return false;
  const s = stack.pop(); if (s.cleanup) s.cleanup(); s.el.remove();
  const p = topScreen(); p.el.hidden = false;
  if (p.last && p.last.isConnected) focus(p.last); else focusFirst(p);
  refreshHome();
  return true;
}
function reset() { while (stack.length) { const s = stack.pop(); if (s.cleanup) s.cleanup(); s.el.remove(); } push(homeScreen); }
function focus(e, smooth = true) {
  if (!e) return;
  e.focus({ preventScroll: true });
  e.scrollIntoView({ block: 'center', inline: 'center', behavior: smooth ? 'smooth' : 'instant' });
}
function focusFirst(s) { focus($('.f[data-autofocus]', s.el) || $('.card.f, .btn.f', s.el) || $('.f', s.el), false); }
function move(dir) {
  const s = topScreen(); if (!s) return;
  const cur = document.activeElement;
  const all = [...s.el.querySelectorAll('.f')];
  if (!cur || !s.el.contains(cur)) return focusFirst(s);
  const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const c of all) {
    if (c === cur) continue;
    const b = c.getBoundingClientRect(); if (!b.width) continue;
    const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
    let score;
    if (dir === 'left' || dir === 'right') {
      if (Math.abs(dy) > a.height / 2) continue;
      if (dir === 'left' ? dx > -10 : dx < 10) continue;
      score = Math.abs(dx);
    } else {
      if (dir === 'up' ? dy > -10 : dy < 10) continue;
      score = Math.abs(dy) * 4 + Math.abs(dx);
    }
    if (score < bestScore) { bestScore = score; best = c; }
  }
  if (best) focus(best);
}
function focusable(e, onOK) { e.classList.add('f'); e.tabIndex = -1; e._ok = onOK; return e; }

/* ---------- building blocks ---------- */
function episodeCard(ep, prog = {}) {
  const saved = prog[String(ep.id)];
  const total = (saved && saved.dur) || secs(ep.duration), pos = saved ? saved.pos : 0;
  const c = el('div', 'card');
  c.innerHTML = `<div class="thumb" style="background-image:url('${esc(ep.image_url || ep.image || '')}')">
      ${total ? `<span class="dur">${clock(total)}</span>` : ''}${pos && total ? `<span class="prog" style="width:${Math.min(100, pos / total * 100)}%"></span>` : ''}</div>
    <div class="t">${esc(ep.title)}</div><div class="m">${esc(ep.air_date || '')}</div>`;
  return focusable(c, () => openEpisode(ep.path));
}
function categoryCard(cat) {
  const c = el('div', 'card');
  c.innerHTML = `<div class="thumb" style="background-image:url('${esc(cat.image_url || cat.image || '')}')"></div>
    <div class="t">${esc(cat.name || cat.title)}</div>${cat.episode_count ? `<div class="m">${cat.episode_count} episodes</div>` : ''}`;
  return focusable(c, () => push(s => categoryScreen(s, cat.path)));
}
function row(title, cards, { grid = false, sub = '' } = {}) {
  const r = el('div', 'row');
  if (title) r.appendChild(el('h2', '', `${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}`));
  const items = el('div', 'items' + (grid ? ' grid' : ''));
  cards.forEach(c => items.appendChild(c));
  r.appendChild(items); return r;
}

/* ---------- screens ---------- */
let homeStale = false;
async function refreshHome() {          // rebuild the home screen in place once it is visible again
  const s = topScreen();
  if (!homeStale || P.open || !s || !s.isHome || stack.length !== 1) return;
  homeStale = false;
  const fresh = el('div'); const tmp = { el: fresh };
  try { await homeScreen(tmp); } catch (e) { return; }
  if (P.open || topScreen() !== s) { homeStale = true; return; }
  s.el.innerHTML = ''; while (fresh.firstChild) s.el.appendChild(fresh.firstChild);
  focusFirst(s);
}
async function homeScreen(s) {
  const [home, nav, prog] = await Promise.all([api('home'), api('navigation').catch(() => ({ main: [] })), savedProgress()]);
  s.isHome = true;
  const navEl = el('div', 'nav'); navEl.appendChild(el('div', 'brand', 'HEI NETWORK <small>unofficial</small>'));
  (nav.main || []).forEach(n => navEl.appendChild(focusable(el('div', 'tab', esc(n.label)), () => push(sc => categoryScreen(sc, n.path)))));
  navEl.appendChild(focusable(el('div', 'tab right', auth.token ? 'Account' : 'Sign in'), () => push(auth.token ? accountScreen : loginScreen)));
  s.el.appendChild(navEl);

  const h = home.hero;
  if (h && h.content) {
    const hero = el('div', 'hero'); hero.style.backgroundImage = `url('${h.image}')`;
    const body = el('div', 'hero-body', `<div class="eyebrow">${esc(h.content.eyebrow || '')}</div><h1>${esc(h.content.title || '')}</h1>`);
    const b = focusable(el('div', 'btn', '▶  ' + esc(h.content.link_text || 'Watch')), () => openEpisode(h.content.path));
    b.dataset.autofocus = '1'; body.appendChild(b); hero.appendChild(body); s.el.appendChild(hero);
  }
  if ((home.resume_episodes || []).length) s.el.appendChild(row('Continue watching', home.resume_episodes.map(e => episodeCard(e, prog))));
  (home.featured_collections || []).forEach(fc => { if ((fc.episodes || []).length) s.el.appendChild(row(fc.title, fc.episodes.map(e => episodeCard(e, prog)), { sub: fc.subtitle })); });
  if ((home.home_collections || []).length) s.el.appendChild(row('Browse', home.home_collections.map(c => categoryCard({ name: c.title, path: c.path, image_url: c.image }))));
}

async function categoryScreen(s, path) {
  const [c, prog] = await Promise.all([api(clean(path)), savedProgress()]);
  if (c.type === 'episode') { pop(); return openEpisode(path); }
  s.el.appendChild(el('div', 'header', `${c.parent ? `<div class="eyebrow">${esc(c.parent.name)}</div>` : ''}<h1>${esc(c.name)}</h1>`));
  if ((c.categories || []).length) s.el.appendChild(row('', c.categories.map(categoryCard), { grid: true }));
  if ((c.episodes || []).length) s.el.appendChild(row((c.categories || []).length ? 'Episodes' : '', c.episodes.map(e => episodeCard(e, prog)), { grid: true }));
  if (!(c.categories || []).length && !(c.episodes || []).length) s.el.appendChild(el('div', 'center', '<p>Nothing here yet.</p>'));
}

async function loginScreen(s) {
  const g = await api('activation/generate-code', { anon: true });
  const short = String(g.activate || 'https://www.heinetwork.tv/activate').replace(/^https?:\/\/(www\.)?/, '').split('?')[0];
  const box = el('div', 'center login');
  box.innerHTML = `<img src="${g.qr_base64 || ''}" alt=""><div class="col"><h1>Sign in to HEI Network</h1>
    <p>Scan the code with your phone, or go to <b>${esc(short)}</b> and enter:</p><div class="code">${esc(g.code)}</div>
    <p class="muted" id="login-status">Waiting for you to confirm…</p></div>`;
  s.el.appendChild(box);
  let stopped = false; s.cleanup = () => { stopped = true; };
  const started = Date.now();
  (async function poll() {
    while (!stopped && Date.now() - started < 19 * 60000) {
      await new Promise(r => setTimeout(r, 3500)); if (stopped) return;
      let p; try { p = await api('activation/poll?code=' + encodeURIComponent(g.code), { anon: true }); } catch (e) { p = e.data || { status: 'error:' + e.message }; }
      if (p && p.status === 'pending') continue;
      const token = findToken(p);
      // Shape log (field names only, never values) so an unexpected response can be diagnosed.
      console.log('[hei] activation result fields:', JSON.stringify(Object.keys(p || {})), 'status:', p && p.status, 'token:', token ? 'yes' : 'no');
      if (token) { auth.token = token; toast('Signed in'); reset(); return; }
      const st = $('#login-status', s.el); if (st) st.textContent = 'Activation did not complete (' + ((p && (p.status || p.error)) || 'unknown') + '). Press BACK and try again.';
      return;
    }
    const st = $('#login-status', s.el); if (st && !stopped) st.textContent = 'Code expired. Press BACK and try again.';
  })();
}

async function accountScreen(s) {
  let who = '';
  try { const u = await api('user_data'); who = u.display_name || u.name || u.email || (u.user && (u.user.display_name || u.user.email)) || ''; console.log('[hei] user_data fields:', JSON.stringify(Object.keys(u || {}))); }
  catch (e) { who = e.status === 401 || e.status === 403 ? '(session expired)' : ''; }
  const box = el('div', 'center', `<h1>Account</h1><p>${who ? 'Signed in as ' + esc(who) : 'Signed in'}</p>`);
  const b = focusable(el('div', 'btn', 'Sign out'), () => { auth.token = ''; toast('Signed out'); reset(); });
  b.dataset.autofocus = '1'; box.appendChild(b); s.el.appendChild(box);
}

/* ---------- playback ---------- */
const P = { el: null, v: null, ep: null, osdTimer: 0, progTimer: 0, seekTarget: null, seekTimer: 0, nextTimer: 0, open: false };

async function openEpisode(path, { fromStart = false } = {}) {
  if (!path) return;
  if (!auth.token) { toast('Sign in to watch'); return push(loginScreen); }
  $('#spinner').hidden = false; $('#player').hidden = false; P.open = true; $('#p-title').textContent = ''; $('#p-eyebrow').textContent = '';
  try {
    const [ep, prog] = await Promise.all([api(clean(path)), fromStart ? {} : savedProgress()]);
    const url = findStream(ep.playback_url);
    if (!url) {
      const pu = ep.playback_url || {}; const why = (pu.data && pu.data.error) || pu.error || 'This episode is not available on your account.';
      closePlayer(); toast(txt(why), 6000);
      if (pu.status === 401) { auth.token = ''; push(loginScreen); }
      return;
    }
    const saved = prog[String(ep.id)];
    const resume = saved ? saved.pos : 0;
    play({ url, title: txt(ep.title), eyebrow: [ep.parent_category && ep.parent_category.name, ep.category && ep.category.name].filter(Boolean).map(txt).join(' · '), ep, startAt: resume });
  } catch (e) { closePlayer(); toast('Could not load episode: ' + e.message, 6000); }
}

function play({ url, title, eyebrow = '', ep = null, startAt = 0 }) {
  const v = P.v; P.ep = ep; P.open = true; P.seekTarget = null; P.dirty = false;
  $('#player').hidden = false; $('#upnext').hidden = true; $('#spinner').hidden = false;
  $('#p-title').textContent = title; $('#p-eyebrow').textContent = eyebrow;
  v.src = url;
  v.addEventListener('loadedmetadata', () => {
    if (startAt > 10 && !(startAt > v.duration - 20)) { v.currentTime = startAt; toast('Resuming from ' + clock(startAt), 4000); }
  }, { once: true });
  v.play().catch(e => console.warn('[hei] play() rejected', e && e.message));
  showOSD();
  clearInterval(P.progTimer); P.progTimer = setInterval(() => report(false), 20000);
}
function nextEpisode() {
  const ep = P.ep; if (!ep || !ep.playlist_episodes) return null;
  const i = ep.playlist_episodes.findIndex(x => String(x.id) === String(ep.id));
  return i >= 0 ? ep.playlist_episodes[i + 1] || null : null;
}
function report(finished) {
  const v = P.v, ep = P.ep; if (!ep || !auth.token || !v.duration || !isFinite(v.duration)) return Promise.resolve();
  if (!finished && v.currentTime < 15) return Promise.resolve();   // too early to be a meaningful position
  P.dirty = true;
  return api('progress', { ns: 'video-progress/v1', method: 'POST', body: { episode_id: +ep.id, content_url: ep.content_url, position_seconds: Math.floor(v.currentTime), duration_seconds: Math.floor(v.duration), finished: !!finished } })
    .catch(e => console.warn('[hei] progress not saved:', e.message));
}
function closePlayer() {
  const saving = P.open && P.v.currentTime > 0 ? report(false) : Promise.resolve();
  const wasDirty = () => P.dirty;
  Promise.resolve(saving).then(() => { if (wasDirty()) { homeStale = true; refreshHome(); } });
  clearInterval(P.progTimer); clearTimeout(P.nextTimer); clearTimeout(P.seekTimer);
  P.v.pause(); P.v.removeAttribute('src'); P.v.load();
  P.open = false; P.ep = null; $('#player').hidden = true; $('#spinner').hidden = true; $('#upnext').hidden = true;
}
function showOSD(sticky = false) {
  $('#player').classList.add('show-osd'); clearTimeout(P.osdTimer);
  if (!sticky && !P.v.paused) P.osdTimer = setTimeout(() => $('#player').classList.remove('show-osd'), 4000);
}
function paint() {
  const v = P.v, d = v.duration || 0, t = P.seekTarget != null ? P.seekTarget : v.currentTime;
  $('#p-pos').style.width = d ? (t / d * 100) + '%' : '0';
  $('#p-buf').style.width = d && v.buffered.length ? (v.buffered.end(v.buffered.length - 1) / d * 100) + '%' : '0';
  $('#p-cur').textContent = clock(t); $('#p-dur').textContent = d ? clock(d) : '';
  $('#p-state').textContent = P.seekTarget != null ? (P.seekTarget > v.currentTime ? '▶▶ ' : '◀◀ ') + clock(P.seekTarget) : v.paused ? 'Paused' : '';
}
function toggle() { const v = P.v; if (v.paused) v.play(); else v.pause(); showOSD(v.paused); paint(); }
function seek(delta, repeat) {          // seeks are batched: hold a direction, the jump lands when you let go
  const v = P.v; if (!v.duration) return;
  const step = repeat ? delta * 2 : delta;
  P.seekTarget = Math.max(0, Math.min(v.duration - 2, (P.seekTarget != null ? P.seekTarget : v.currentTime) + step));
  showOSD(true); paint();
  clearTimeout(P.seekTimer); P.seekTimer = setTimeout(() => { v.currentTime = P.seekTarget; P.seekTarget = null; showOSD(); }, 450);
}
function playerKey(e) {
  if (!$('#upnext').hidden && (e.keyCode === KEY.BACK || e.keyCode === KEY.ESC)) { clearTimeout(P.nextTimer); return closePlayer(); }
  switch (e.keyCode) {
    case KEY.OK: toggle(); break;
    case KEY.PLAY: P.v.play(); showOSD(); break;
    case KEY.PAUSE: P.v.pause(); showOSD(true); break;
    case KEY.LEFT: seek(-10, e.repeat); break;
    case KEY.RIGHT: seek(10, e.repeat); break;
    case KEY.RW: seek(-30, e.repeat); break;
    case KEY.FF: seek(30, e.repeat); break;
    case KEY.UP: case KEY.DOWN: showOSD(); break;
    case KEY.STOP: case KEY.BACK: case KEY.ESC: case KEY.BKSP: closePlayer(); break;
    default: return;
  }
  e.preventDefault();
}
function initPlayer() {
  const v = P.v = $('#video'); P.el = $('#player');
  ['timeupdate', 'progress', 'durationchange', 'pause', 'play', 'seeked'].forEach(n => v.addEventListener(n, paint));
  ['waiting', 'seeking', 'loadstart'].forEach(n => v.addEventListener(n, () => { if (P.open) $('#spinner').hidden = false; }));
  ['playing', 'canplay', 'seeked'].forEach(n => v.addEventListener(n, () => { $('#spinner').hidden = true; }));
  v.addEventListener('pause', () => { if (P.open && v.currentTime > 0) report(false); });
  v.addEventListener('error', () => { if (!P.open) return; const c = v.error && v.error.code; closePlayer(); toast('Playback error' + (c ? ' (' + c + ')' : ''), 6000); });
  v.addEventListener('ended', () => {
    report(true);
    const n = nextEpisode(); if (!n) return closePlayer();
    const u = $('#upnext'); u.innerHTML = `<b>Up next in 8s · BACK to stop</b>${esc(n.title)}`; u.hidden = false; showOSD(true);
    P.nextTimer = setTimeout(() => { u.hidden = true; openEpisode(n.path, { fromStart: true }); }, 8000);
  });
  $('#player').addEventListener('click', () => { if (P.open) toggle(); });
  $('#player').addEventListener('mousemove', () => { if (P.open) showOSD(); });
}

/* ---------- input ---------- */
document.addEventListener('keydown', e => {
  if (P.open) return playerKey(e);
  switch (e.keyCode) {
    case KEY.LEFT: move('left'); break;
    case KEY.RIGHT: move('right'); break;
    case KEY.UP: move('up'); break;
    case KEY.DOWN: move('down'); break;
    case KEY.OK: { const a = document.activeElement; if (a && a._ok) a._ok(); break; }
    case KEY.BACK: case KEY.ESC: case KEY.BKSP:
      if (!pop()) { if (window.PalmSystem && PalmSystem.platformBack) PalmSystem.platformBack(); else window.close(); }
      break;
    default: return;
  }
  e.preventDefault();
});
// Magic Remote pointer: hover focuses, click activates.
document.addEventListener('mouseover', e => { const f = e.target.closest && e.target.closest('.f'); if (f && !P.open && document.activeElement !== f) f.focus({ preventScroll: true }); });
document.addEventListener('click', e => { const f = e.target.closest && e.target.closest('.f'); if (f && !P.open && f._ok) f._ok(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && P.open) { P.v.pause(); } });

initPlayer();
push(homeScreen);
window.HEI = { play, closePlayer, api, auth, stack };   // debugging hooks
