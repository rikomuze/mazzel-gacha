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
let mode = 'loading';            // loading | start（遊び方を選ぶ） | friends（開封所を作る・入る） | room | local（ひとりで）
let fdb = null, me = null, uid = null, room = null, unsub = [];
let fbReady = Promise.resolve(false); // 共有サーバーにつながったら true
let roomDoc = { owner: null, price: 550, secretRate: 3 };
let players = {};
let view = { stage: 'pack', last: null, shot: 0, verdict: '', note: '', hit: false, fresh: false, tab: 'rank', joinedAt: Date.now(), inviting: false };
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

/* ---------- boot / 画面の切り替え ---------- */
// 画面はURLで決まる：なし=最初の画面、?play=solo=ひとりで、?play=friends=お友達と、?room=コード=開封所
// （スマホの「戻る」でひとつ前の画面に戻れるように、移動は pushState で記録する）
const CODE_RE = /^[A-Z0-9]{6}$/;
function boot() {
  const cfg = window.FIREBASE_CONFIG || {};
  if (window.firebase && cfg.apiKey) {
    fbReady = (async () => {
      try {
        firebase.initializeApp(cfg);
        const cred = await firebase.auth().signInAnonymously();
        uid = cred.user.uid; fdb = firebase.firestore(); return true;
      } catch (e) { console.error(e); authError = e && e.code || 'unknown'; return false; }
    })();
    fbReady.then(() => { if (mode === 'friends') renderAll(); });
  } else authError = 'no-config';
  window.addEventListener('popstate', route);
  route();
}
function go(params, replace) {
  const u = new URL(location.href); u.search = new URLSearchParams(params).toString(); u.hash = location.hash;
  history[replace ? 'replaceState' : 'pushState'](null, '', u);
  route();
}
function leaveRoom() { unsub.forEach(u => u()); unsub = []; room = null; }
function resetView() { Object.assign(view, { stage: 'pack', last: null, hit: false, fresh: false, tab: 'rank', inviting: false }); }
async function route() {
  const q = new URLSearchParams(location.search);
  const code = (q.get('room') || '').toUpperCase(), play = q.get('play');
  if (CODE_RE.test(code)) {
    if (mode === 'room' && room === code) return;
    leaveRoom(); mode = 'loading'; renderAll();
    if (!(await fbReady)) { go({ play: 'friends' }, true); toast('共有サーバーにつながらないため、開封所に入れませんでした'); return; }
    enterRoom(code); return;
  }
  leaveRoom(); resetView();
  if (play === 'solo') { mode = 'local'; loadLocal(); }
  else if (play === 'friends') { mode = 'friends'; players = {}; }
  else { mode = 'start'; players = {}; }
  renderAll(); window.scrollTo(0, 0);
}
async function enterRoom(code) {
  leaveRoom(); resetView();
  room = code; me = uid; players = {}; view.joinedAt = Date.now();
  const snap = await fdb.collection('rooms').doc(code).get().catch(() => null);
  if (room !== code) return; // 待っている間に別の画面へ移った
  if (!snap || !snap.exists) {
    room = null; go({ play: 'friends' }, true);
    toast(`開封所「${code}」が見つかりません。コードを確かめてください`); return;
  }
  try { localStorage.setItem('oshigacha-last-room', code); } catch (e) {}
  roomDoc = { owner: null, price: 550, secretRate: 3, ...snap.data() };
  mode = 'room';
  // 作った本人がまだ参加していなければ、参加のあとに「お友達を招待しよう」画面を出す
  view.inviting = roomDoc.owner === me;
  unsub.push(roomRef().onSnapshot(s => { if (s.exists) roomDoc = { ...roomDoc, ...s.data() }; renderAll(); }, dead));
  unsub.push(roomRef().collection('players').onSnapshot(s => {
    const next = {}; s.forEach(d => { next[d.id] = normPlayer(d.data()); });
    // keep my optimistic local copy while my own writes are pending
    if (players[me] && s.metadata.hasPendingWrites) next[me] = players[me];
    if (view.inviting && next[me]?.pulls > 0) view.inviting = false; // もう開け始めている人には招待画面を出さない
    announce(next); players = next; renderAll();
  }, dead));
  renderAll(); window.scrollTo(0, 0);
}
async function createRoom() {
  if (!(await fbReady)) { toast('共有サーバーにつながりません'); return; }
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 5; tries++) {
    const code = Array.from({length:6}, () => abc[Math.floor(Math.random() * abc.length)]).join('');
    const ref = fdb.collection('rooms').doc(code);
    const ex = await ref.get().catch(() => null);
    if (ex && ex.exists) continue;
    try {
      await ref.set({ owner: uid, price: 550, secretRate: 3, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      go({ room: code }); return;
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
// 演出の確認用：アドレスの最後に #oshi を付けて開くと、次の1袋だけ必ず推しが出る
// 推しが出たときに、カードの後ろに出すオーロラの光ときらめき
const GLITTER = '<span class="aura" aria-hidden="true"></span><span class="glints" aria-hidden="true"><i style="left:-34%;top:8%;--s:33px;animation-delay:0.50s"></i><i style="left:118%;top:2%;--s:24px;animation-delay:0.80s"></i><i style="left:-22%;top:52%;--s:18px;animation-delay:1.30s"></i><i style="left:124%;top:40%;--s:36px;animation-delay:0.65s"></i><i style="left:-40%;top:86%;--s:27px;animation-delay:1.00s"></i><i style="left:112%;top:92%;--s:21px;animation-delay:1.45s"></i><i style="left:10%;top:-14%;--s:21px;animation-delay:1.10s"></i><i style="left:78%;top:-12%;--s:30px;animation-delay:0.55s"></i><i style="left:30%;top:108%;--s:18px;animation-delay:1.60s"></i><i style="left:88%;top:106%;--s:27px;animation-delay:0.90s"></i><i style="left:-12%;top:28%;--s:15px;animation-delay:1.80s"></i><i style="left:132%;top:68%;--s:16px;animation-delay:1.20s"></i><i style="left:-30%;top:-4%;--s:14px;animation-delay:1.50s"></i><i style="left:104%;top:-16%;--s:15px;animation-delay:1.70s"></i></span>';
let forceOshi = location.hash === '#oshi';
function draw() {
  if (forceOshi && mine() && M(mine().oshi)) { forceOshi = false; history.replaceState(null, '', location.pathname + location.search); return M(mine().oshi); }
  const pool = (SECRETS.length && Math.random() * 100 < roomDoc.secretRate) ? SECRETS : NORMALS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ---------- top rows ---------- */
function renderTop() {
  const b = $('banner');
  if (false) { // ひとりで遊ぶのは自分で選んだモードなので、お知らせは出さない（つながらない理由は「お友達と」の画面に出す）
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

  // 上の細いバー：いまどのモードで遊んでいるか＋移動先
  const rb = $('roombar');
  const p = mine(), joined = !!(p && p.name);
  if (mode === 'room') {
    rb.hidden = false;
    rb.innerHTML = `<div class="invite compact">
        <span class="invite-c">開封所 <b>${esc(room)}</b></span>
        ${joined && !view.inviting ? '<button class="btn ghost" id="openInvite">お友達を招待</button>' : ''}
        <button class="linkbtn" data-go="start">出る</button>
      </div>`;
    const oi = $('openInvite'); if (oi) oi.onclick = () => { view.inviting = true; renderAll(); $('stage').scrollIntoView({ block: 'start' }); };
  } else if (mode === 'local' && joined) {
    rb.hidden = false;
    rb.innerHTML = `<div class="invite compact">
        <span class="invite-c"><b class="solo">ひとりで開封中</b></span>
        <button class="linkbtn" data-go="friends">お友達と遊ぶ</button>
        <button class="linkbtn" data-go="start">最初の画面へ</button>
      </div>`;
  } else { rb.hidden = true; rb.innerHTML = ''; }

  const ids = mode !== 'room' || view.inviting ? [] : Object.keys(players).filter(id => players[id].name)
    .sort((a, b) => (a === me ? -1 : b === me ? 1 : 0) || (players[b].pulls - players[a].pulls));
  $('players').innerHTML = ids.map(id => {
    const p = players[id], o = M(p.oshi);
    return `<div class="pchip ${id === me ? 'me on' : ''}"><span class="dot">${o ? `<img src="${esc(o.shots[0])}" alt="">` : '?'}</span>${esc(p.name)}${id === me ? '（自分）' : ''} <small>${p.pulls}袋</small></div>`;
  }).join('');

  // 結果・コレクション・設定のタブは、参加して袋を開けられる状態になってから出す
  const playing = (mode === 'room' || mode === 'local') && joined && !view.inviting;
  $('guide').hidden = mode !== 'start';
  document.body.dataset.mode = mode;
  $('tabs').hidden = !playing; $('panel').hidden = !playing;
  const rt = document.querySelector('#tabs [data-tab="rank"]'); if (rt) rt.textContent = mode === 'local' ? '開封の記録' : 'みんなの結果';
}

/* ---------- stage ---------- */
// 推しを写真で選ぶボタンの並び
function oshiPicker(sel) {
  return `<div class="oshi-pick" role="radiogroup" aria-label="推し">${NORMALS.map(m =>
    `<button type="button" role="radio" aria-checked="${m.id === sel}" data-oshi="${m.id}"><img src="${esc(m.shots[0])}" alt=""><span>${esc(m.name)}</span></button>`).join('')}</div>`;
}
function bindPicker(form) {
  form.querySelectorAll('[data-oshi]').forEach(b => b.onclick = () => {
    form.querySelectorAll('[data-oshi]').forEach(x => x.setAttribute('aria-checked', x === b));
    form.dataset.oshi = b.dataset.oshi; const sb = form.querySelector('[type=submit]'); if (sb) sb.disabled = false;
  });
}
// 最初の画面：ひとりで / お友達と
function renderStart() {
  let solo = null; try { solo = JSON.parse(localStorage.getItem(LKEY))?.me; } catch (e) {}
  const cont = solo && solo.oshi && solo.pulls ? `<small>つづきから：${esc(M(solo.oshi)?.name || '')}推し ・ ${solo.pulls}袋開封ずみ</small>` : '';
  setStage(`<div class="start">
    <h2>どうやって遊ぶ？</h2>
    <button class="choice" data-go="solo"><span class="ic" aria-hidden="true">1</span><b>ひとりで開ける</b>
      <span>この端末だけで、自分のペースでアー写を集める。</span>${cont}</button>
    <button class="choice" data-go="friends"><span class="ic two" aria-hidden="true">2+</span><b>お友達と開ける</b>
      <span>開封所を作って招待リンクを送ると、それぞれのスマホから参加できて、みんなの開封結果がリアルタイムで並ぶ。</span></button>
  </div>`, true);
}
// お友達と：開封所を作る / コードで入る
function renderFriends() {
  let last = null; try { last = localStorage.getItem('oshigacha-last-room'); } catch (e) {}
  const down = authError && authError !== 'no-config' ? authError : null;
  setStage(`<div class="lobby">
    <h2>お友達と開ける</h2>
    ${authError ? `<p class="warn">共有サーバーにつながらないため、いまはお友達と遊べません。${authError === 'no-config' ? '' : `<br><small>${esc(down)}</small>`}</p>
      <button class="btn" data-go="solo">ひとりで開ける</button>` : `
    <div class="opt"><b>開封所を作る</b><span>あなたが開封所を作って、お友達を招待します。</span>
      <button class="btn" id="mk">開封所を作る</button></div>
    <div class="opt"><b>招待された人</b><span>招待リンクを開けば、そのまま入れます。開封所コードで入るときはこちら。</span>
      <form id="joinCode"><input id="code" maxlength="6" placeholder="ABC123" aria-label="開封所コード" autocomplete="off"><button class="btn" type="submit">入る</button></form>
      ${last ? `<button class="linkbtn" data-room="${esc(last)}">前回の開封所（${esc(last)}）にもどる</button>` : ''}</div>`}
    <button class="linkbtn" data-go="start">← 最初の画面にもどる</button>
  </div>`, true);
  if (authError) return;
  $('mk').onclick = e => { const b = e.currentTarget; b.disabled = true; b.textContent = '作っています…'; createRoom().finally(() => { if (b.isConnected) { b.disabled = false; b.textContent = '開封所を作る'; } }); };
  $('joinCode').onsubmit = e => {
    e.preventDefault(); const c = $('code').value.trim().toUpperCase();
    if (!CODE_RE.test(c)) { toast('開封所コードは英数字6文字です'); return; }
    go({ room: c });
  };
  const lb = document.querySelector('[data-room]'); if (lb) lb.onclick = () => go({ room: lb.dataset.room });
}
// 参加：ひとりなら推しだけ、お友達となら名前＋推し
function renderJoin() {
  const solo = mode === 'local', owner = isOwner();
  const host = players[roomDoc.owner]?.name;
  const head = solo ? `<h2>推しはだれ？</h2><p class="hint">推しのカードが出たら「自引き」です。箱推しの人も、いちばんの1人を選んでね。</p>`
    : owner ? `<p class="step">開封所ができました！</p><h2>名前と推しを決めよう</h2><p class="hint">次の画面で、お友達を招待できます。</p>`
    : `<p class="step">${host ? `${esc(host)}さんの` : ''}開封所に招待されました</p><h2>名前と推しを決めて参加</h2>`;
  setStage(`<form class="join" id="joinForm">${head}
    ${solo ? '' : '<label for="jn">ニックネーム<input type="text" id="jn" maxlength="12" required placeholder="例：みー" autocomplete="nickname"></label>'}
    <div class="field"><span class="lbl">推し</span>${oshiPicker('')}</div>
    <button class="btn" type="submit" disabled>${solo ? 'この推しではじめる' : owner ? '次へ' : '参加する'}</button>
    ${solo ? '<button type="button" class="linkbtn" data-go="start">← 最初の画面にもどる</button>' : ''}</form>`, true);
  const f = $('joinForm'); bindPicker(f);
  f.onsubmit = e => {
    e.preventDefault(); if (!f.dataset.oshi) { toast('推しを選んでください'); return; }
    const n = solo ? 'わたし' : $('jn').value.trim(); if (!n) return;
    const prev = mine() || {};
    players[me] = normPlayer({ ...prev, name: n, oshi: f.dataset.oshi }); saveMe(); renderAll(); window.scrollTo(0, 0);
  };
}
// 開封所を作った人：お友達を招待しよう
function renderInvite() {
  const url = location.origin + location.pathname + '?room=' + room;
  const others = Object.entries(players).filter(([id, p]) => p.name && id !== me);
  setStage(`<div class="lobby invite-step">
    <p class="step">開封所 <b>${esc(room)}</b></p>
    <h2>お友達を招待しよう</h2>
    <p class="hint">このリンクをLINEやDMで送ってね。開くだけで、同じ開封所に入れます。</p>
    <code class="url">${esc(url)}</code>
    <div class="actions">${navigator.share ? '<button class="btn" id="shareLink">招待リンクを送る</button>' : ''}<button class="btn ${navigator.share ? 'ghost' : ''}" id="copyInvite">リンクをコピー</button></div>
    <div class="joined"><span class="lbl">参加中</span>${[me, ...others.map(([id]) => id)].map(id => { const q = players[id], o = M(q?.oshi);
      return q ? `<span class="pchip ${id === me ? 'me on' : ''}"><span class="dot">${o ? `<img src="${esc(o.shots[0])}" alt="">` : ''}</span>${esc(q.name)}${id === me ? '（自分）' : ''}</span>` : ''; }).join('')}
      ${others.length ? '' : '<span class="wait">お友達を待っています…</span>'}</div>
    <button class="btn big" data-act="start">${others.length ? 'みんなで開封をはじめる' : '開封をはじめる'}</button>
    <p class="hint">はじめたあとも、上の「お友達を招待」からいつでも呼べます。</p>
  </div>`, true);
  $('copyInvite').onclick = () => copy(url, '招待リンクをコピーしました');
  const sh = $('shareLink');
  if (sh) sh.onclick = () => navigator.share({ title: '推しガチャ開封所', text: 'MAZZELの推しガチャ、一緒に開けよう！', url }).catch(() => {});
}
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
  if (mode === 'loading') { setStage('<p class="empty">開封所に入っています…</p>'); return; }
  if (tearing) return; // 開封の演出中は、自分の保存やお友達の更新で袋を描き直さない
  if (mode === 'start') { renderStart(); return; }
  if (mode === 'friends') { renderFriends(); return; }
  const p = mine();
  if (!p || !p.name) { renderJoin(); return; }
  if (mode === 'room' && view.inviting) { renderInvite(); return; }
  const o = M(p.oshi), q = p.queue;
  let html = `<div class="turn">推し：<b>${esc(o?.name || 'なし')}</b>　開けた袋 <b>${p.pulls}袋</b></div>`;
  if (view.stage === 'reveal' && view.last) {
    const m = view.last, src = m.shots[view.shot];
    html += `<div class="slot ${view.hit ? 'hitfx' : ''}">${view.hit ? GLITTER : ''}${packHTML(false, 'torn gone')}
      <div class="card ${m.secret ? 'secret' : ''}">
        <div class="ph">${view.hit ? '<span class="holo" aria-hidden="true"></span>' : ''}${src ? `<img src="${esc(src)}" alt="${esc(m.name)}のアーティスト写真">` : `<div class="init">${esc(m.name)}</div>`}
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
function tear(fromLink) {
  const pack = $('pack'), p = mine();
  if (!pack || tearing || !p || p.queue <= 0) return;
  if (fromLink && Date.now() < tearLockUntil) return; // 袋をもらった直後の二度押しだけ無視（なぞる操作は止めない）
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
  const colors = ['#f6d98a', '#ffffff', '#f4b8c8', '#d9c8f0', '#bfe3d6'];
  for (let i = 0; i < 70; i++) {
    const s = document.createElement('i'); s.style.left = Math.random() * 100 + '%';
    s.style.background = colors[i % colors.length];
    if (i % 3 === 0) s.className = 'spark';
    s.style.setProperty('--dx', (Math.random() * 120 - 60) + 'px');
    s.style.animationDuration = (1.4 + Math.random() * .9) + 's';
    s.style.animationDelay = (.55 + Math.random() * .5) + 's'; box.appendChild(s);
  }
  host.appendChild(box); setTimeout(() => box.remove(), 3400);
}
function doAct(act) {
  const p = mine(); if (!p) return;
  switch (act) {
    case 'buy1': p.queue += 1; view.stage = 'pack'; tearLockUntil = Date.now() + 400; saveMe(); break;
    case 'buy5': p.queue += 5; view.stage = 'pack'; tearLockUntil = Date.now() + 400; saveMe(); break;
    case 'next': view.stage = 'pack'; break;
    case 'start': view.inviting = false; window.scrollTo(0, 0); break;
    case 'tear': tear(true); return;
    default: return;
  }
  renderAll();
}
// スマホでは「指を離した瞬間」に反応させる。
// iPhoneはスクロールの勢いが残っているときや、押している間に画面が描き直されたときに
// click が届かず「1回目が効かない」ことがあるため。
let downAct = null, ghostUntil = 0;
$('stage').addEventListener('pointerdown', e => {
  const a = e.target.closest('[data-act]');
  downAct = a && e.pointerType !== 'mouse' ? { act: a.dataset.act, x: e.clientX, y: e.clientY } : null;
});
$('stage').addEventListener('pointerup', e => {
  const d = downAct; downAct = null; if (!d) return;
  const a = e.target.closest('[data-act]');
  if (!a || a.dataset.act !== d.act || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return;
  ghostUntil = Date.now() + 600; // このあと遅れて届く click は無視する（次の画面のボタンを押してしまわないように）
  doAct(d.act);
});
$('stage').addEventListener('pointercancel', () => { downAct = null; });
$('stage').addEventListener('click', e => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  if (Date.now() < ghostUntil) return;
  doAct(a.dataset.act);
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
    const solo = mode === 'local';
    el.innerHTML = solo ? `<h2>自分の記録</h2>
      <p class="mystats"><span><b>${my.pulls}</b>袋</span><span>自引き<b>${my.hits}</b>回</span><span>アー写<b>${shotCount(my)}</b>/${SHOT_TOTAL}</span></p>
      <h2>さっき開いた袋</h2>
      ${feed.length ? `<ul class="feed">${feed.map(f => { const m = M(f.m), src = m?.shots[f.s ?? 0];
        return `<li class="${f.hit ? 'hit' : ''}"><i>${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : ''}</i>
        <span>${esc(m?.name || '')}${f.hit ? ' 自引き！' : m?.secret ? ' シークレット' : ''}</span><time>${ago(f.t)}</time></li>`; }).join('')}</ul>`
        : '<p class="hint">袋を開けると、ここに記録されます。</p>'}
      <button class="btn ghost" id="share">自分の結果をコピー</button>` : `<h2>自引きランキング</h2>
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
      copy(`【推しガチャ開封所】${solo ? '' : my.name}（${o?.name || ''}推し）は${my.pulls}袋で自引き${my.hits}回！アー写${shotCount(my)}/${SHOT_TOTAL} #推しガチャ`, 'コピーしました');
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
    <div class="row" style="grid-template-columns:${mode === 'local' ? '1fr' : '1fr 1fr'}">
      ${mode === 'local' ? '' : `<input type="text" id="myname" value="${esc(my.name)}" maxlength="12" aria-label="ニックネーム">`}
      <select id="myoshi" aria-label="推し">${NORMALS.map(m => `<option value="${m.id}" ${m.id === my.oshi ? 'selected' : ''}>${esc(m.name)}推し</option>`).join('')}</select></div>
    <div class="actions" style="justify-content:flex-start"><button class="btn ghost" id="resetMine">自分の開封記録をリセット</button></div>` : ''}
    <h2>パックの設定${mode === 'room' ? '（開封所の全員共通）' : ''}</h2>
    ${owner ? '' : '<p class="hint">開封所を作った人だけが変えられます。</p>'}
    <div class="field"><label for="rate">シークレット排出率：<b id="rv">${roomDoc.secretRate}%</b></label><input type="range" id="rate" min="0" max="20" value="${roomDoc.secretRate}" ${owner ? '' : 'disabled'}></div>
    ${owner && mode === 'room' ? `<h2>開封所を作った人用</h2><div class="actions" style="justify-content:flex-start"><button class="btn ghost" id="resetAll">全員の開封記録をリセット</button></div>` : ''}
    ${mode === 'local' ? '<p class="hint">推しを変えると、ここから先の自引き判定が新しい推しになります。</p>' : ''}
    <p class="hint">カードの写真は公式アーティスト写真です（各メンバー18ショット、シークレットは集合写真16ショット）。</p>`;
  const q = s => el.querySelector(s);
  if (my && my.name) {
    if (q('#myname')) q('#myname').onchange = e => { const v = e.target.value.trim(); if (v) { my.name = v; saveMe(); renderTop(); } };
    q('#myoshi').onchange = e => { my.oshi = e.target.value; saveMe(); renderAll(); };
  }
  if (owner) {
    q('#rate').oninput = e => { q('#rv').textContent = e.target.value + '%'; };
    q('#rate').onchange = e => saveRoom({ secretRate: +e.target.value });
  }
  // リセットは2回押し。1回目でボタン自体が「もう一度押すと消えます」に変わる（4秒で元に戻る）
  let resetTimer = null;
  const ask = (kind, btn, label, fn) => {
    clearTimeout(resetTimer);
    if (pendingReset === kind) {
      pendingReset = null; fn(); Object.assign(view, { stage: 'pack', last: null, hit: false });
      renderAll(); renderPanel(); toast('リセットしました'); return;
    }
    pendingReset = kind; const orig = btn.textContent;
    btn.textContent = label; btn.classList.add('danger');
    resetTimer = setTimeout(() => { if (pendingReset === kind) { pendingReset = null; if (btn.isConnected) { btn.textContent = orig; btn.classList.remove('danger'); } } }, 4000);
  };
  const wipe = p => Object.assign(p, { inv: {}, shots: {}, pulls: 0, hits: 0, queue: 0, recent: [] });
  const rm = q('#resetMine');
  if (rm) rm.onclick = () => ask('mine', rm, 'もう一度押すと記録が消えます', () => { wipe(my); saveMe(); });
  const ra = q('#resetAll');
  if (ra) ra.onclick = () => ask('all', ra, 'もう一度押すと全員の記録が消えます', () => { for (const id of Object.keys(players)) { wipe(players[id]); savePlayer(id); } });
}
document.getElementById('tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]'); if (!b) return; view.tab = b.dataset.tab; pendingReset = null; renderPanel();
});

// 画面の移動ボタン（data-go）
document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]'); if (!g) return;
  e.preventDefault(); const t = g.dataset.go;
  go(t === 'start' ? {} : { play: t });
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
  if (mode === 'loading') { $('banner').hidden = $('roombar').hidden = $('guide').hidden = $('tabs').hidden = $('panel').hidden = true; $('players').innerHTML = ''; renderStage(); return; }
  renderTop(); renderStage();
  const panel = $('panel');
  if (view.tab !== 'set' || !panel.contains(document.activeElement)) renderPanel();
  if (dlgState) renderCards();
}
setInterval(() => { if (view.tab === 'rank') renderPanel(); }, 30000);

boot();
})();
