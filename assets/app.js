/* 推しガチャ開封所 — MUZE TOOL BOX
 * Firebase (匿名ログイン + Firestore) で開封所（rooms）ごとに結果を共有する。
 * 設定が無いときは localStorage だけで動く「ひとりモード」。
 *
 * Firestore:
 *   rooms/{code}                {owner, price, secretRate, createdAt}
 *   rooms/{code}/players/{uid}  {name, oshi, inv, shots, pulls, hits, queue, recent}
 */
(() => {
'use strict';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $ = id => document.getElementById(id);
const nums = n => Array.from({length:n}, (_, k) => String(k + 1).padStart(2, '0'));

/* ---------- members (static) ---------- */
const NAMES = ['KAIRYU','NAOYA','RAN','SEITO','RYUKI','TAKUTO','HAYATO','EIKI'];
const MEMBERS = NAMES.map((name, i) => ({
  id: 'mazzel-' + name.toLowerCase(), name, order: i, secret: false,
  shots: nums(18).map(x => `photos/${name.toLowerCase()}/${x}.jpg`)
}));
MEMBERS.push({ id: 'mazzel-secret', name: 'MAZZEL 集合', order: 99, secret: true,
  shots: nums(16).map(x => `photos/group/${x}.jpg`) });
const M = id => MEMBERS.find(m => m.id === id);
const NORMALS = MEMBERS.filter(m => !m.secret);
const SECRETS = MEMBERS.filter(m => m.secret);
const SHOT_TOTAL = MEMBERS.reduce((s, m) => s + m.shots.length, 0);

/* ---------- state ---------- */
let mode = 'loading';            // loading | lobby | room | local
let fdb = null, me = null, room = null, unsub = [];
let roomDoc = { owner: null, price: 550, secretRate: 3 };
let players = {};
let view = { stage: 'pack', last: null, shot: 0, verdict: '', note: '', hit: false, fresh: false, tab: 'rank', joinedAt: Date.now() };
let pendingReset = null;
let authError = null;
let tearing = false; // 袋を開けている途中（演出中）

const mine = () => players[me];
const cnt = (p, id) => (p && p.inv && p.inv[id]) || 0;
const got = (p, id) => (p && p.shots && Array.isArray(p.shots[id])) ? p.shots[id] : [];
const isOwner = () => mode === 'local' || roomDoc.owner === me;
function normPlayer(d) {
  const p = { name: '', oshi: '', inv: {}, shots: {}, pulls: 0, hits: 0, queue: 0, recent: [], ...d };
  ['inv', 'shots'].forEach(k => { if (typeof p[k] !== 'object' || p[k] === null) p[k] = {}; });
  if (typeof p.queue !== 'number') p.queue = 0;
  if (!Array.isArray(p.recent)) p.recent = [];
  return p;
}

/* ---------- local mode ---------- */
const LKEY = 'oshigacha-gh-local-v1';
function loadLocal() {
  let s = null; try { s = JSON.parse(localStorage.getItem(LKEY)); } catch (e) {}
  roomDoc = { owner: 'local', price: 550, secretRate: 3, ...(s?.room || {}) };
  me = 'local';
  players = { local: normPlayer(s?.me || {}) };
}
function saveLocal() { try { localStorage.setItem(LKEY, JSON.stringify({ room: roomDoc, me: players.local })); } catch (e) {} }

/* ---------- writes ---------- */
let wq = Promise.resolve();
function queueWrite(fn) { wq = wq.then(fn).catch(err => { console.error(err); toast('保存できませんでした。通信を確認してください'); }); return wq; }
const roomRef = () => fdb.collection('rooms').doc(room);
function savePlayer(id) {
  if (mode === 'local') { saveLocal(); return; }
  const body = JSON.parse(JSON.stringify(players[id]));
  queueWrite(() => roomRef().collection('players').doc(id).set(body));
}
const saveMe = () => savePlayer(me);
function saveRoom(patch) {
  Object.assign(roomDoc, patch);
  if (mode === 'local') { saveLocal(); return; }
  queueWrite(() => roomRef().update(patch));
}

/* ---------- boot ---------- */
const CODE_RE = /^[A-Z0-9]{6}$/;
function roomFromUrl() {
  const c = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  return CODE_RE.test(c) ? c : null;
}
async function boot() {
  const cfg = window.FIREBASE_CONFIG || {};
  if (!window.firebase || !cfg.apiKey) {
    mode = 'local'; loadLocal(); renderAll(); return;
  }
  try {
    firebase.initializeApp(cfg);
    const cred = await firebase.auth().signInAnonymously();
    me = cred.user.uid;
    fdb = firebase.firestore();
  } catch (e) {
    console.error(e); mode = 'local'; loadLocal(); authError = e && e.code || 'unknown';
    renderAll(); return;
  }
  const code = roomFromUrl();
  if (code) enterRoom(code); else { mode = 'lobby'; renderAll(); }
}
async function enterRoom(code) {
  unsub.forEach(u => u()); unsub = [];
  room = code; players = {}; view.joinedAt = Date.now();
  const snap = await fdb.collection('rooms').doc(code).get().catch(() => null);
  if (!snap || !snap.exists) {
    room = null; mode = 'lobby';
    const u = new URL(location.href); u.searchParams.delete('room'); history.replaceState(null, '', u);
    renderAll();
    toast(`開封所「${code}」が見つかりません。コードを確かめてください`); return;
  }
  try { localStorage.setItem('oshigacha-last-room', code); } catch (e) {}
  const url = new URL(location.href); url.searchParams.set('room', code); history.replaceState(null, '', url);
  mode = 'room';
  unsub.push(roomRef().onSnapshot(s => { if (s.exists) roomDoc = { ...roomDoc, ...s.data() }; renderAll(); }, dead));
  unsub.push(roomRef().collection('players').onSnapshot(s => {
    const next = {}; s.forEach(d => { next[d.id] = normPlayer(d.data()); });
    // keep my optimistic local copy while my own writes are pending
    if (players[me] && s.metadata.hasPendingWrites) next[me] = players[me];
    announce(next); players = next; renderAll();
  }, dead));
  renderAll();
}
async function createRoom() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 5; tries++) {
    const code = Array.from({length:6}, () => abc[Math.floor(Math.random() * abc.length)]).join('');
    const ref = fdb.collection('rooms').doc(code);
    const ex = await ref.get().catch(() => null);
    if (ex && ex.exists) continue;
    try {
      await ref.set({ owner: me, price: 550, secretRate: 3, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      await enterRoom(code); return;
    } catch (e) { console.error(e); toast('開封所を作れませんでした。時間をおいて試してください'); return; }
  }
  toast('開封所を作れませんでした。もう一度押してください');
}
function dead(e) { console.error(e); toast('共有データとの接続が切れました。ページを開き直してください'); }

function announce(next) {
  for (const [id, p] of Object.entries(next)) {
    if (id === me) continue;
    const r = p.recent?.[0], old = players[id]?.recent?.[0];
    if (r && r.t > view.joinedAt && (!old || old.t !== r.t)) {
      const m = M(r.m);
      if (r.hit) toast(`${p.name}が自引き！ ${m?.name || ''}`);
      else if (m?.secret) toast(`${p.name}がシークレットを引きました`);
    }
  }
}

/* ---------- gacha ---------- */
function draw() {
  const pool = (SECRETS.length && Math.random() * 100 < roomDoc.secretRate) ? SECRETS : NORMALS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ---------- top rows ---------- */
function renderTop() {
  const b = $('banner');
  if (mode === 'local') {
    b.hidden = false;
    const why = {
      'auth/operation-not-allowed': 'Firebaseで匿名ログインが有効になっていません（Authentication → ログイン方法 → 匿名）。',
      'auth/admin-restricted-operation': 'Firebaseで匿名ログインが有効になっていません（Authentication → ログイン方法 → 匿名）。',
      'auth/configuration-not-found': 'FirebaseのAuthenticationがまだ始まっていません（Authentication →「始める」→ 匿名を有効に）。',
      'auth/network-request-failed': '通信できませんでした。電波の良い場所で再読み込みしてください。',
      'auth/invalid-api-key': 'Firebaseの設定（apiKey）が正しくありません。',
      'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'Firebaseの設定（apiKey）が正しくありません。',
      'auth/unauthorized-domain': 'このサイトのドメインがFirebaseで許可されていません（Authentication → 設定 → 承認済みドメイン）。'
    };
    b.innerHTML = authError
      ? `<b>ひとりモード</b>：共有サーバーにつながらないため、この端末だけに保存されます。<br>${esc(why[authError] || 'つながらなかった理由')}（${esc(authError)}）`
      : '<b>ひとりモード</b>：共有サーバーの設定がないため、この端末だけに保存されます。';
  }
  else b.hidden = true;

  const rb = $('roombar');
  if (mode === 'room') {
    rb.hidden = false;
    // 大きな招待欄は「開封所を作った人が、まだ1人のとき」だけ。招待リンクから入った人には小さい欄を出す。
    const big = isOwner() && Object.values(players).filter(p => p.name).length <= 1;
    rb.innerHTML = big ? `
      <div class="invite alone">
        <div class="invite-t"><b>お友達はここから招待してね</b><span>下のリンクをLINEやDMで送ると、同じ開封所に入れます。1人で遊ぶときはそのままでOK。</span></div>
        <div class="invite-row"><code id="inviteUrl">${esc(location.href)}</code><button class="btn" id="copyLink">招待リンクをコピー</button></div>
        <div class="invite-foot"><span>開封所コード <b>${esc(room)}</b></span><button class="linkbtn" id="leave">この開封所を出る</button></div>
      </div>` : `
      <div class="invite compact">
        <span class="invite-c">開封所コード <b>${esc(room)}</b></span>
        <button class="btn ghost" id="copyLink">お友達を招待（リンクをコピー）</button>
        <button class="linkbtn" id="leave">出る</button>
      </div>`;
    $('copyLink').onclick = () => copy(location.href, '招待リンクをコピーしました');
    $('leave').onclick = () => { unsub.forEach(u => u()); unsub = []; room = null; players = {}; mode = 'lobby';
      const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url); renderAll(); };
  } else rb.hidden = true;

  const ids = Object.keys(players).filter(id => players[id].name)
    .sort((a, b) => (a === me ? -1 : b === me ? 1 : 0) || (players[b].pulls - players[a].pulls));
  $('players').innerHTML = ids.map(id => {
    const p = players[id], o = M(p.oshi);
    return `<div class="pchip ${id === me ? 'me on' : ''}"><span class="dot">${o ? `<img src="${esc(o.shots[0])}" alt="">` : '?'}</span>${esc(p.name)}${id === me ? '（自分）' : ''} <small>${p.pulls}袋</small></div>`;
  }).join('');

  const inRoom = mode === 'room' || mode === 'local';
  $('guide').hidden = mode !== 'lobby';
  document.body.dataset.mode = mode;
  $('tabs').hidden = !inRoom; $('panel').hidden = !inRoom;
}

/* ---------- stage ---------- */
function packHTML(empty, extra = '') {
  return `<div class="pack ${empty ? 'empty' : ''} ${extra}" id="pack" ${empty ? '' : 'role="button" tabindex="0" aria-label="袋を開ける"'}>
    <div class="strip" id="strip"><span class="cut" id="cut"></span>✂ ここから切って開けてね →</div>
    <div class="body"><div class="fine">RANDOM ARTIST PHOTO CARD</div><div class="logo">MAZZEL</div>
    <div class="fine">全${NORMALS.length}種＋シークレット</div></div></div>`;
}
function setStage(html, cache) {
  const st = $('stage');
  if (cache) { if (st.dataset.html === html && !view.fresh) return false; st.dataset.html = html; }
  else st.dataset.html = '';
  st.innerHTML = html; return true;
}
function renderStage() {
  if (mode === 'loading') return;
  if (tearing) return; // 開封の演出中は、自分の保存やお友達の更新で袋を描き直さない
  if (mode === 'lobby') {
    let last = null; try { last = localStorage.getItem('oshigacha-last-room'); } catch (e) {}
    setStage(`<div class="lobby">
      <h2>開封所を作る</h2>
      <button class="btn" id="mk">新しい開封所を作る</button>
      <p class="hint">作ったあとに出てくる招待リンクを送ると、お友達が同じ開封所に入れます。</p>
      <div class="or">開封所コードを持っている人</div>
      <form id="joinCode"><input id="code" maxlength="6" placeholder="ABC123" aria-label="開封所コード" value="${esc(last || '')}" autocomplete="off"><button class="btn" type="submit">入る</button></form>
    </div>`);
    $('mk').onclick = e => { e.target.disabled = true; createRoom().finally(() => { if ($('mk')) $('mk').disabled = false; }); };
    $('joinCode').onsubmit = e => {
      e.preventDefault(); const c = $('code').value.trim().toUpperCase();
      if (!CODE_RE.test(c)) { toast('開封所コードは英数字6文字です'); return; }
      enterRoom(c);
    };
    return;
  }
  const p = mine();
  if (!p || !p.name) {
    setStage(`<form class="join" id="joinForm">
      <h2>開封所に参加</h2>
      <label for="jn">ニックネーム<input type="text" id="jn" maxlength="12" required placeholder="例：みー"></label>
      <label for="jo">推し<select id="jo">${NORMALS.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
      <p class="hint">自引き判定に使います。箱推しの人も、いちばんの1人を選んでください。</p>
      <button class="btn" type="submit">参加する</button></form>`);
    $('joinForm').onsubmit = e => {
      e.preventDefault(); const n = $('jn').value.trim(); if (!n) return;
      players[me] = normPlayer({ name: n, oshi: $('jo').value }); saveMe(); renderAll();
    };
    return;
  }
  const o = M(p.oshi), q = p.queue;
  let html = `<div class="turn">推し：<b>${esc(o?.name || 'なし')}</b>　開けた袋 <b>${p.pulls}袋</b></div>`;
  if (view.stage === 'reveal' && view.last) {
    const m = view.last, src = m.shots[view.shot];
    html += `<div class="slot ${view.hit ? 'hitfx' : ''}">${view.hit ? '<span class="rays" aria-hidden="true"></span>' : ''}${packHTML(false, 'torn gone')}
      <div class="card ${m.secret ? 'secret' : ''}">${view.hit ? '<span class="stamp" aria-hidden="true">自引き</span>' : ''}
        <div class="ph">${src ? `<img src="${esc(src)}" alt="${esc(m.name)}のアーティスト写真">` : `<div class="init">${esc(m.name)}</div>`}
          <span class="no">No.${String(m.order + 1 > 90 ? 0 : m.order + 1).padStart(2, '0')}-${String(view.shot + 1).padStart(2, '0')}${m.secret ? ' SECRET' : ''}</span></div>
        <div class="cap"><span class="nm">${esc(m.name)}</span><span class="grp">MAZZEL</span></div>
      </div></div>
      <div class="verdict ${view.hit ? 'hit' : ''}">${esc(view.verdict)}</div>
      <div class="note">${esc(view.note)}</div>
      <div class="actions">${q > 0 ? `<button class="btn" data-act="next">次の袋へ（残り${q}）</button>` :
        `<button class="btn" data-act="buy1">もう1袋</button><button class="btn ghost" data-act="buy5">5袋まとめてもらう</button>`}</div>`;
  } else if (q > 0) {
    html += `<div class="queue">未開封 ${q}袋</div><div class="slot">${packHTML(false)}</div>
      <div class="note" style="margin-top:0">切り取り線を指で右へなぞると開きます</div>
      <button class="linkbtn tearlink" data-act="tear">なぞるのが難しいときは、ここをタップ</button>`;
  } else {
    html += `<div class="queue">未開封 0袋</div><div class="slot">${packHTML(true)}</div>
      <div class="actions"><button class="btn" data-act="buy1">1袋もらう</button><button class="btn ghost" data-act="buy5">5袋まとめてもらう</button></div>`;
  }
  if (!setStage(html, true)) return;
  if (view.stage !== 'reveal' && q > 0) bindTear();
  if (view.stage === 'reveal' && view.hit && view.fresh) { view.fresh = false; confetti($('stage')); }
  view.fresh = false;
}
function bindTear() {
  const strip = $('strip'), cut = $('cut'), pack = $('pack');
  let x0 = null;
  strip.addEventListener('pointerdown', e => { x0 = e.clientX; strip.setPointerCapture(e.pointerId); });
  strip.addEventListener('pointermove', e => {
    if (x0 === null) return; const w = strip.offsetWidth, d = Math.max(0, e.clientX - x0);
    cut.style.width = Math.min(100, d / w * 100) + '%';
    if (d > w * 0.6) { x0 = null; tear(); }
  });
  const end = () => { if (x0 !== null) { x0 = null; cut.style.width = '0'; } };
  strip.addEventListener('pointerup', end); strip.addEventListener('pointercancel', end);
  pack.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tear(); } });
}
let tearLockUntil = 0; // 袋をもらった直後の連打で、勝手に開かないようにする
function tear() {
  const pack = $('pack'), p = mine();
  if (!pack || tearing || !p || p.queue <= 0 || Date.now() < tearLockUntil) return;
  const m = draw(), k = Math.floor(Math.random() * m.shots.length), had = got(p, m.id), isNew = !had.includes(k);
  tearing = true;
  const willHit = p.oshi === m.id;
  // 推しのときは、袋が光って震える「溜め」を入れてから開く
  if (willHit) { pack.classList.add('charge'); try { navigator.vibrate && navigator.vibrate([20, 60, 20, 60, 120]); } catch (e) {} }
  setTimeout(() => pack.classList.add('torn'), willHit ? 900 : 0);
  p.queue--; p.pulls++; p.inv = { ...p.inv, [m.id]: cnt(p, m.id) + 1 };
  if (isNew) p.shots = { ...p.shots, [m.id]: [...had, k].sort((a, b) => a - b) };
  const c = p.inv[m.id], hit = p.oshi === m.id; if (hit) p.hits++;
  p.recent = [{ m: m.id, s: k, t: Date.now(), hit }, ...p.recent].slice(0, 15);
  view.hit = hit; view.fresh = true; view.last = m; view.shot = k;
  if (hit) view.verdict = c > 1 ? `また${m.name}！自引き${c}枚目` : `自引き成功！${m.name}が来た`;
  else if (m.secret) view.verdict = 'シークレット！';
  else view.verdict = c > 1 ? `${m.name}（${c}枚目）` : `${m.name}、はじめまして`;
  const n = got(p, m.id).length, tot = m.shots.length;
  const shotNote = isNew ? `新しいアー写！ ${m.name}のアー写 ${n}/${tot}` : `持っているアー写（${n}/${tot}）`;
  view.note = shotNote;
  saveMe();
  setTimeout(() => { tearing = false; view.stage = 'reveal'; renderAll(); }, willHit ? 1350 : 450);
}
function confetti(host) {
  const box = document.createElement('div'); box.className = 'confetti';
  const colors = ['var(--tape-berry)', 'var(--tape-mint)', '#f2c94c', '#ffffff'];
  for (let i = 0; i < 70; i++) {
    const s = document.createElement('i'); s.style.left = Math.random() * 100 + '%';
    s.style.background = colors[i % colors.length];
    if (i % 5 === 0) s.className = 'heart';
    s.style.setProperty('--dx', (Math.random() * 120 - 60) + 'px');
    s.style.animationDuration = (1.4 + Math.random() * .9) + 's';
    s.style.animationDelay = (.55 + Math.random() * .5) + 's'; box.appendChild(s);
  }
  host.appendChild(box); setTimeout(() => box.remove(), 3400);
}
$('stage').addEventListener('click', e => {
  const a = e.target.closest('[data-act]'); if (!a) return; const p = mine(); if (!p) return;
  switch (a.dataset.act) {
    case 'buy1': p.queue += 1; view.stage = 'pack'; tearLockUntil = Date.now() + 700; saveMe(); break;
    case 'buy5': p.queue += 5; view.stage = 'pack'; tearLockUntil = Date.now() + 700; saveMe(); break;
    case 'next': view.stage = 'pack'; tearLockUntil = Date.now() + 700; break;
    case 'tear': tear(); return;
  }
  renderAll();
});

/* ---------- panels ---------- */
function ago(t) { const s = Math.max(0, (Date.now() - t) / 1000 | 0); return s < 60 ? `${s}秒前` : s < 3600 ? `${s / 60 | 0}分前` : `${s / 3600 | 0}時間前`; }
function renderPanel() {
  if (mode !== 'room' && mode !== 'local') return;
  const el = $('panel');
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === view.tab));
  const ps = Object.entries(players).filter(([, p]) => p.name);
  if (view.tab === 'rank') {
    const r = ps.map(([, p]) => p).sort((a, b) => b.hits - a.hits || a.pulls - b.pulls);
    const feed = ps.flatMap(([, p]) => p.recent.map(x => ({ ...x, who: p.name }))).sort((a, b) => b.t - a.t).slice(0, 8);
    const my = mine();
    el.innerHTML = `<h2>自引きランキング</h2>
      ${r.length ? `<ol class="rank">${r.map((p, i) => `<li><span class="n">${i + 1}</span><span>${esc(p.name)}</span>
        <span class="v">自引き${p.hits} / ${p.pulls}袋</span></li>`).join('')}</ol>`
        : '<p class="hint">まだ誰も参加していません。上の開封所から参加すると、ここに並びます。</p>'}
      <h2>さっき開いた袋</h2>
      ${feed.length ? `<ul class="feed">${feed.map(f => { const m = M(f.m), src = m?.shots[f.s ?? 0];
        return `<li class="${f.hit ? 'hit' : ''}"><i>${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : ''}</i>
        <span>${esc(f.who)}：${esc(m?.name || '')}${f.hit ? ' 自引き！' : m?.secret ? ' シークレット' : ''}</span><time>${ago(f.t)}</time></li>`; }).join('')}</ul>`
        : '<p class="hint">袋が開くと、誰が何を引いたかがここに流れます。</p>'}
      ${my && my.name ? `<button class="btn ghost" id="share">自分の結果をコピー</button>` : ''}`;
    const sh = $('share');
    if (sh) sh.onclick = () => {
      const o = M(my.oshi);
      copy(`【推しガチャ開封所】${my.name}（${o?.name || ''}推し）は${my.pulls}袋で自引き${my.hits}回！アー写${shotCount(my)}/${SHOT_TOTAL} #推しガチャ`, 'コピーしました');
    };
  } else if (view.tab === 'coll') {
    el.innerHTML = ps.length ? ps.map(([id, p]) => {
      const own = MEMBERS.filter(m => cnt(p, m.id)).length;
      const dup = MEMBERS.reduce((s, m) => s + dupOf(p, m.id), 0);
      return `<div class="pl"><div class="pl-h"><b>${esc(p.name)}${id === me ? '（自分）' : ''}</b><span>${own}/${MEMBERS.length}人 ・ アー写${shotCount(p)}/${SHOT_TOTAL} ・ ダブり${dup}枚</span></div>
      <div class="coll">${MEMBERS.map(m => { const c = cnt(p, m.id); const g = got(p, m.id); const src = m.shots[g[g.length - 1] ?? 0];
        return c ? `<button class="mini" data-open="${esc(id)}" data-mem="${m.id}" aria-label="${esc(p.name)}の${esc(m.name)}のカードを見る"><span class="in"><img src="${esc(src)}" alt="" loading="lazy"></span>
          <span class="sh">${g.length}/${m.shots.length}</span>
          ${p.oshi === m.id ? '<span class="star">推し</span>' : ''}<span class="cnt">×${c}</span></button>`
        : `<div class="mini none" title="${esc(m.name)}">?</div>`; }).join('')}</div></div>`; }).join('')
      : '<p class="hint">参加した人のコレクションがここに並びます。</p>';
    el.querySelectorAll('[data-open]').forEach(btn => btn.onclick = () => openCards(btn.dataset.open, btn.dataset.mem));
  } else renderSettings(el);
}

/* ---------- card list modal ---------- */
let dlgState = null; // {pid, mid, pick}
function openCards(pid, mid) {
  const p = players[pid], g = got(p, mid);
  dlgState = { pid, mid, pick: g.length ? g[g.length - 1] : null };
  let d = $('cardsDlg');
  if (!d) {
    d = document.createElement('dialog'); d.id = 'cardsDlg'; d.className = 'cards-dlg';
    d.addEventListener('click', e => { if (e.target === d) d.close(); });
    d.addEventListener('close', () => { dlgState = null; });
    document.body.appendChild(d);
  }
  renderCards();
  if (!d.open) d.showModal();
}
function renderCards() {
  const d = $('cardsDlg'); if (!d || !dlgState) return;
  const p = players[dlgState.pid], m = M(dlgState.mid);
  if (!p || !m) { d.close(); return; }
  const g = got(p, m.id), c = cnt(p, m.id), pick = dlgState.pick;
  d.innerHTML = `
    <div class="dlg-head">
      <div><b>${esc(m.name)}</b><span>${esc(p.name)}${dlgState.pid === me ? '（自分）' : ''}のカード ・ アー写${g.length}/${m.shots.length} ・ ${c}枚引いた（ダブり${dupOf(p, m.id)}枚）</span></div>
      <button class="dlg-x" id="dlgClose" aria-label="閉じる"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>
    </div>
    ${pick !== null ? `<figure class="dlg-big"><img src="${esc(m.shots[pick])}" alt="${esc(m.name)}のアー写 No.${pick + 1}"><figcaption>No.${String(pick + 1).padStart(2, '0')}</figcaption></figure>` : ''}
    <div class="dlg-grid">${m.shots.map((src, k) => g.includes(k)
      ? `<button class="dlg-cell ${k === pick ? 'on' : ''}" data-k="${k}" aria-label="No.${k + 1}を大きく見る"><img src="${esc(src)}" alt="" loading="lazy"><span>${String(k + 1).padStart(2, '0')}</span></button>`
      : `<div class="dlg-cell none"><span>${String(k + 1).padStart(2, '0')}</span>?</div>`).join('')}
    </div>`;
  $('dlgClose').onclick = () => d.close();
  d.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { dlgState.pick = +b.dataset.k; renderCards(); d.scrollTo({ top: 0, behavior: 'smooth' }); });
}
const shotCount = p => MEMBERS.reduce((s, m) => s + got(p, m.id).length, 0);
// ダブり = 同じアー写をもう一度引いた枚数（引いた枚数 − 集めたアー写の種類）
const dupOf = (p, mid) => Math.max(0, cnt(p, mid) - got(p, mid).length);
function renderSettings(el) {
  const my = mine(), owner = isOwner();
  el.innerHTML = `
    ${my && my.name ? `<h2>自分</h2>
    <div class="row" style="grid-template-columns:1fr 1fr">
      <input type="text" id="myname" value="${esc(my.name)}" maxlength="12" aria-label="ニックネーム">
      <select id="myoshi" aria-label="推し">${NORMALS.map(m => `<option value="${m.id}" ${m.id === my.oshi ? 'selected' : ''}>${esc(m.name)}推し</option>`).join('')}</select></div>
    <div class="actions" style="justify-content:flex-start"><button class="btn ghost" id="resetMine">自分の開封記録をリセット</button></div>` : ''}
    <h2>パックの設定${mode === 'room' ? '（開封所の全員共通）' : ''}</h2>
    ${owner ? '' : '<p class="hint">開封所を作った人だけが変えられます。</p>'}
    <div class="field"><label for="rate">シークレット排出率：<b id="rv">${roomDoc.secretRate}%</b></label><input type="range" id="rate" min="0" max="20" value="${roomDoc.secretRate}" ${owner ? '' : 'disabled'}></div>
    ${owner && mode === 'room' ? `<h2>開封所を作った人用</h2><div class="actions" style="justify-content:flex-start"><button class="btn ghost" id="resetAll">全員の開封記録をリセット</button></div>` : ''}
    <p class="hint" id="confirmMsg" hidden></p>
    <p class="hint">カードの写真は公式アーティスト写真です（各メンバー18ショット、シークレットは集合写真16ショット）。</p>`;
  const q = s => el.querySelector(s);
  if (my && my.name) {
    q('#myname').onchange = e => { const v = e.target.value.trim(); if (v) { my.name = v; saveMe(); renderTop(); } };
    q('#myoshi').onchange = e => { my.oshi = e.target.value; saveMe(); renderAll(); };
  }
  if (owner) {
    q('#rate').oninput = e => { q('#rv').textContent = e.target.value + '%'; };
    q('#rate').onchange = e => saveRoom({ secretRate: +e.target.value });
  }
  const msg = q('#confirmMsg');
  const ask = (kind, text, fn) => {
    if (pendingReset === kind) { pendingReset = null; fn(); view.stage = 'pack'; renderAll(); toast('リセットしました'); return; }
    pendingReset = kind; msg.hidden = false; msg.textContent = text;
  };
  const wipe = p => Object.assign(p, { inv: {}, shots: {}, pulls: 0, hits: 0, queue: 0, recent: [] });
  if (my && my.name) q('#resetMine').onclick = () => ask('mine', 'もう一度押すと、自分の開封記録を消します。', () => { wipe(my); saveMe(); });
  const ra = q('#resetAll');
  if (ra) ra.onclick = () => ask('all', 'もう一度押すと、開封所の全員の開封記録を消します。', () => { for (const id of Object.keys(players)) { wipe(players[id]); savePlayer(id); } });
}
document.getElementById('tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]'); if (!b) return; view.tab = b.dataset.tab; pendingReset = null; renderPanel();
});

/* ---------- utils ---------- */
let tt;
function toast(t) {
  let d = document.querySelector('.toast');
  if (!d) { d = document.createElement('div'); d.className = 'toast'; d.setAttribute('role', 'status'); document.body.appendChild(d); }
  d.textContent = t; clearTimeout(tt); tt = setTimeout(() => d.remove(), 2600);
}
function copy(text, done) {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast(done)).catch(() => toast(text));
}
function renderAll() {
  if (mode === 'loading') return;
  renderTop(); renderStage();
  const panel = $('panel');
  if (view.tab !== 'set' || !panel.contains(document.activeElement)) renderPanel();
  if (dlgState) renderCards();
}
setInterval(() => { if (view.tab === 'rank') renderPanel(); }, 30000);

boot();
})();
