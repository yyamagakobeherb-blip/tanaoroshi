import { db } from './db.js';
import { GasBackend, NetError, ApiError } from './api.js';
import { norm, fmtQty, hhmm, esc, uid, looksWrong, monthEndDefault } from './util.js';

// GAS の URL は config.js で設定する（未設定ならお試しモード）
const { API_URL = '' } = await import('./config.js').catch(() => ({}));

const DEMO = !API_URL;
const api = DEMO ? new (await import('./demo-backend.js')).DemoBackend() : new GasBackend(API_URL);

const $app = document.getElementById('app');

// 同期の間隔（設計書 v0.2 §0-6）
const DEBOUNCE_MS = 3000;   // 入力が止まってから送るまで
const MAX_WAIT_MS = 15000;  // 入力が続いていても、最初の未送信からこの時間で必ず送る
const POLL_MS = 30000;      // 表示中に他の人の入力を取りに行く間隔
const BACKOFF_MAX_MS = 300000;
const CLAIM_FRESH_MS = 30 * 60000;

// ── 状態 ──
const S = {
  me: null,           // { token, storeId, storeName, name, deviceId, isAdmin, company }
  items: [],          // この店舗の置き場所（品目情報つき）。id=置場ID, itemId=品目ID
  itemById: new Map(),
  areas: [],
  session: null,      // { id, date, status }
  counts: new Map(),  // 置場ID → { qty, by, deviceId, ts, rev }
  unsent: new Map(),  // 置場ID → この端末の未送信の入力数（この間はサーバーの値で上書きしない）
  conflicts: new Map(), // 置場ID → { opId, mine, theirs, theirBy, theirRev }（この端末の食い違い）
  openConflicts: [],  // 店舗全体で未解決の食い違い（管理画面用）
  participants: {},
  rev: 0,
  pending: 0,         // 送信待ち（全棚卸回）
  held: [],           // 管理者用: この回の保留（締め後に届いた入力）
  lastArchivedHeld: null, // 管理者用: 直近に完了した回に届いた保留
  online: navigator.onLine,
  authLost: false,
  lastSyncAt: 0,
  syncError: '',
  view: 'home',
  count: null,        // { area, list, idx, buf, edit: { pid, rev } }
  list: { area: '', q: '' },
};

// ── 起動 ──
async function boot() {
  S.me = await db.get('me');
  if (!S.me) return renderSetup();
  await loadLocal();
  render();
  refreshFromServer();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

async function loadLocal() {
  const [items, session, rev, conflicts, outbox] = await Promise.all([
    db.allItems(), db.get('session'), db.get('rev'), db.get('conflicts'), db.outbox(),
  ]);
  setItems(items);
  S.session = session || null;
  S.rev = rev || 0;
  S.conflicts = new Map(conflicts || []);
  S.counts = new Map();
  if (S.session) (await db.sessionCounts(S.session.id)).forEach(c => S.counts.set(c.pid, c));
  setOutbox(outbox);
}

function setOutbox(outbox) {
  S.pending = outbox.length;
  S.unsent = new Map();
  for (const o of outbox) if (o.sessionId === S.session?.id) S.unsent.set(o.pid, (S.unsent.get(o.pid) || 0) + 1);
}

function setItems(items) {
  items.sort((a, b) => (a.areaOrder - b.areaOrder) || String(a.area).localeCompare(String(b.area), 'ja') || (a.sort - b.sort) || a.name.localeCompare(b.name, 'ja'));
  S.items = items;
  S.itemById = new Map(items.map(i => [i.id, i]));
  S.areas = [...new Set(items.map(i => i.area))];
}

// ── サーバーとのやりとりは1本ずつ順番に行う（初期取得と同期が入れ違って古い値に戻るのを防ぐ） ──
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// サーバーから最新の品目・棚卸回を取り直す（失敗しても端末内のデータで動き続ける）
function refreshFromServer() {
  return serial(async () => {
    try {
      await doFlush({});
      const r = await api.call('bootstrap', { token: S.me.token });
      await db.replaceItems(r.items);
      setItems(r.items);
      Object.assign(S.me, { isAdmin: r.isAdmin, company: r.company, storeName: r.store?.name || S.me.storeName });
      await db.set('me', S.me);
      if ((S.session?.id || null) !== (r.session?.id || null)) {
        // 棚卸回が変わった。前の回の数量は端末に残し、前の回の未送信も消さない（保留として扱う）
        S.counts = new Map(); S.rev = 0; S.conflicts = new Map();
        await Promise.all([db.set('rev', 0), db.set('conflicts', [])]);
      }
      S.session = r.session;
      await db.set('session', S.session);
      setOutbox(await db.outbox());
      if (S.session) await applyServer({ rows: r.counts, rev: r.rev, openConflicts: r.conflicts });
      S.participants = r.participants || {};
      S.openConflicts = r.conflicts || [];
      S.held = r.held || [];
      S.lastArchivedHeld = r.lastArchivedHeld || null;
      okSync();
    } catch (e) {
      handleSyncError(e);
    }
    redraw();
  });
}

// サーバーの値を端末に取り込む（db.applySync が、未送信の置場と古い版を除外する）
async function applyServer({ ack = [], rows = [], rev, openConflicts }) {
  // 食い違い: サーバーが持っている「この端末の未解決の食い違い」が正。解決の入力をまだ送っていない置場は除く
  const conflicts = new Map();
  for (const cf of openConflicts || []) {
    if (cf.mineDevice && cf.mineDevice !== S.me.deviceId) continue;
    if (S.unsent.get(cf.pid)) continue;
    const prev = conflicts.get(cf.pid);
    if (prev) { if (!prev.alts.includes(cf.mine)) prev.alts.push(cf.mine); }
    else conflicts.set(cf.pid, { ...cf, alts: [cf.mine] });
  }
  // 相手の値は、自分の未送信がある間は取り込みを見送っていたため、差分に含まれないことがある
  const theirRows = [...conflicts.values()].map(cf => ({
    pid: cf.pid, qty: cf.theirs, by: cf.theirBy, deviceId: cf.theirDevice || '', ts: cf.theirTs || Date.now(), rev: cf.theirRev,
  }));
  const accepted = await db.applySync({
    sessionId: S.session.id, ack, rows: [...theirRows, ...rows], conflicts: openConflicts ? [...conflicts] : undefined, rev,
  });
  if (openConflicts) {
    for (const pid of conflicts.keys()) {
      if (!S.conflicts.has(pid)) toast(`「${S.itemById.get(pid)?.name || pid}」は ${conflicts.get(pid).theirBy}さんと数が食い違っています。確認してください`);
    }
    S.conflicts = conflicts;
  }
  let unknown = false;
  for (const c of accepted) {
    if (S.unsent.get(c.pid)) continue; // 取り込み中に新しく入力された置場は、画面の値を守る
    const before = S.counts.get(c.pid);
    S.counts.set(c.pid, c);
    if (!S.itemById.has(c.pid)) unknown = true;
    if (before && before.deviceId === S.me.deviceId && c.deviceId !== S.me.deviceId && before.qty !== c.qty && !S.conflicts.has(c.pid)) {
      toast(`${c.by}さんが「${S.itemById.get(c.pid)?.name || c.pid}」を ${fmtQty(before.qty)} → ${fmtQty(c.qty)} に変更しました`);
    }
  }
  if (rev != null) S.rev = Math.max(S.rev, rev);
  return { unknown };
}

// ── 同期 ──
let flushTimer = null;
let firstPendingAt = 0;
let backoffMs = 0;
let retryAt = 0;

function scheduleFlush() {
  const now = Date.now();
  if (!firstPendingAt) firstPendingAt = now;
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstPendingAt + MAX_WAIT_MS - now));
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flush(), wait);
}

function flush(extra = {}) {
  return serial(() => doFlush(extra)).then(r => { redraw(); return r; });
}

// 送信待ちを送り、他の人の変更を受け取る。必ず serial() の中から呼ぶ
async function doFlush(extra) {
  if (!S.me || S.authLost) return {};
  if (Date.now() < retryAt && !extra.force) return {};
  clearTimeout(flushTimer);
  const outbox = await db.outbox();
  let result = {};
  try {
    // 前の棚卸回の未送信（棚卸回が切り替わる前に入力したもの）。サーバーは保留として記録する
    let held = 0;
    const others = new Map();
    outbox.filter(o => o.sessionId !== S.session?.id).forEach(o => { if (!others.has(o.sessionId)) others.set(o.sessionId, []); others.get(o.sessionId).push(o); });
    for (const [sid, ops] of others) {
      const r = await api.call('sync', { token: S.me.token, sessionId: sid, ops: ops.slice(0, 200), since: 1e9, deviceId: S.me.deviceId, by: S.me.name, pendingCount: ops.length })
        .catch(e => { if (e instanceof ApiError && e.code === 'NO_SESSION') return { applied: [], held: [] }; throw e; });
      await db.applySync({ sessionId: sid, ack: r.applied });
      held += r.held?.length || 0;
    }
    if (S.session) {
      const mine = outbox.filter(o => o.sessionId === S.session.id);
      const batch = mine.slice(0, 200);
      const r = await api.call('sync', {
        token: S.me.token, sessionId: S.session.id, ops: batch, since: S.rev,
        deviceId: S.me.deviceId, by: S.me.name, pendingCount: mine.length,
        area: S.view === 'count' ? S.count?.area || '' : '', doneArea: extra.doneArea || '',
      });
      // 送信済みとなった分を未送信の印から外してから取り込む
      for (const id of r.applied) {
        const op = batch.find(o => o.opId === id);
        if (op) S.unsent.set(op.pid, Math.max(0, (S.unsent.get(op.pid) || 0) - 1));
      }
      for (const [pid, n] of S.unsent) if (!n) S.unsent.delete(pid);
      const { unknown } = await applyServer({ ack: r.applied, rows: r.changes, rev: r.rev, openConflicts: r.openConflicts });
      S.openConflicts = r.openConflicts || [];
      S.participants = r.participants || S.participants;
      if (r.heldItems) S.held = r.heldItems;
      held += r.held?.length || 0;
      if (r.session && r.session.status !== S.session.status) {
        S.session = r.session;
        await db.set('session', S.session);
        toast(S.session.status === 'open' ? '棚卸が再開されました' : 'この棚卸は締められました。入力はできません。');
      }
      result = { doneAccepted: r.doneAccepted, more: mine.length > batch.length && r.applied.length > 0, unknown };
    }
    if (held) toast(`締めた後の入力 ${held} 件は「保留」としてサーバーに記録しました。管理者が取り込めます。`);
    setOutbox(await db.outbox());
    okSync();
    backoffMs = 0; retryAt = 0;
    firstPendingAt = S.pending ? Date.now() : 0;
    if (result.more) setTimeout(() => flush(), 300);
    if (result.unknown) setTimeout(() => refreshFromServer(), 0); // 他の人が仮登録した品目を取りに行く
  } catch (e) {
    handleSyncError(e);
    if (!S.authLost) {
      backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs ? backoffMs * 2 : 5000);
      retryAt = Date.now() + backoffMs;
      if (S.pending) { clearTimeout(flushTimer); flushTimer = setTimeout(() => flush(), backoffMs); }
    }
  }
  return result;
}

function okSync() {
  S.syncError = '';
  S.online = true;
  S.lastSyncAt = Date.now();
}

function handleSyncError(e) {
  if (e instanceof ApiError && e.code === 'AUTH') { S.authLost = true; S.syncError = 'ログインし直してください'; }
  else if (e instanceof ApiError && e.code === 'BUSY') S.syncError = '';
  else if (e instanceof NetError) { S.syncError = ''; S.online = false; }
  else S.syncError = e.message;
  renderSyncBadge();
}

window.addEventListener('online', () => { S.online = true; retryAt = 0; flush(); });
window.addEventListener('offline', () => { S.online = false; renderSyncBadge(); });
document.addEventListener('visibilitychange', () => {
  if (!S.me) return;
  if (document.visibilityState === 'hidden') flush({ force: true });
  else refreshFromServer();
});
setInterval(() => {
  if (document.visibilityState !== 'visible' || !S.me) return;
  if (S.view === 'admin') refreshFromServer(); // 保留・参加者・直近完了回の保留まで取り直す
  else if (S.session) flush();
}, POLL_MS);

function syncLabel() {
  if (S.syncError) return { cls: 'offline', text: '⚠ ' + S.syncError };
  if (!S.online) return { cls: 'offline', text: S.pending ? `圏外・保存済み${S.pending}件` : '圏外' };
  if (S.pending) return { cls: 'pending', text: `送信待ち${S.pending}件` };
  if (DEMO) return { cls: '', text: 'お試しモード' };
  return { cls: '', text: S.lastSyncAt ? `✓送信済 ${hhmm(S.lastSyncAt)}` : '' };
}

function renderSyncBadge() {
  const el = document.querySelector('.sync');
  if (!el) return;
  const { cls, text } = syncLabel();
  el.className = 'sync ' + cls;
  el.textContent = text;
}

// 同期のあと、入力中の画面は数字と注意書きだけを書き換える（入力途中の数字を消さない）
function redraw() {
  if (S.view === 'count' && S.count) {
    renderSyncBadge();
    updateQtyView();
    renderConflictNote();
  } else if (!document.querySelector('.sheet-backdrop')) {
    render();
  } else {
    renderSyncBadge();
  }
}

// ── 入力の保存（端末に即保存して画面を進め、送信は後でまとめて） ──
let opSeq = 0;
async function saveCount(pid, qty, { baseRev, resolves = false } = {}) {
  const now = Date.now();
  const prev = S.counts.get(pid);
  const base = baseRev ?? prev?.rev ?? 0;
  const row = { sessionId: S.session.id, pid, qty, by: S.me.name, deviceId: S.me.deviceId, ts: now, rev: base };
  const op = {
    opId: `${S.me.deviceId}-${now.toString(36)}-${(opSeq++).toString(36)}`,
    sessionId: S.session.id, pid, qty, by: S.me.name, deviceId: S.me.deviceId, ts: now, baseRev: base, resolves,
  };
  const hadConflict = S.conflicts.get(pid);
  if (resolves) S.conflicts.delete(pid);
  S.counts.set(pid, row);
  S.unsent.set(pid, (S.unsent.get(pid) || 0) + 1);
  S.pending++;
  renderSyncBadge();
  try {
    // 数量・送信待ち・（解決なら）食い違い一覧を1回で保存する
    await db.recordCount(row, op, resolves ? [...S.conflicts] : undefined);
  } catch (e) {
    S.pending--;
    S.unsent.set(pid, S.unsent.get(pid) - 1);
    if (prev) S.counts.set(pid, prev); else S.counts.delete(pid);
    if (hadConflict) S.conflicts.set(pid, hadConflict);
    toast('端末に保存できませんでした（空き容量を確認してください）。もう一度入力してください。');
    redraw();
    return;
  }
  scheduleFlush();
}

// ── 画面切り替え ──
function go(view, opts = {}) {
  S.view = view;
  if (view === 'count') startCount(opts);
  render();
  if (view === 'count') flush(); // 担当エリアを知らせる
}

function render() {
  if (!S.me) return renderSetup();
  if (S.view === 'count' && S.count) return renderCount();
  if (S.view === 'list') return renderList();
  if (S.view === 'admin') return renderAdmin();
  return renderHome();
}

function bar(title, left = '', right = '') {
  return `<div class="bar">${left}<h1>${esc(title)}</h1><span class="sync"></span>${right}</div>`;
}

/**
 * 画面を書き換える。前回と同じ内容なら作り直さない（定期更新で、押しかけのボタンや入力中の欄が消えないように）。
 * 作り直したときだけ true を返すので、呼び出し側はそのときだけボタンの動きを付け直す。
 */
function setHtml(html) {
  const changed = $app.__html !== html;
  if (changed) {
    $app.innerHTML = html;
    $app.__html = html;
  }
  renderSyncBadge();
  return changed;
}

// ── 初回設定 ──
async function renderSetup(errorMsg = '') {
  $app.__html = null;
  $app.innerHTML = `<div class="screen">${bar('棚卸 はじめての設定')}
    <div class="page">
      ${DEMO ? '<div class="card muted">お試しモードです（サーバー未接続・この端末の中だけで動きます）。合言葉は <b>1234</b>、管理者は <b>admin</b> です。</div>' : ''}
      <div class="card">
        <form id="setup" style="display:flex;flex-direction:column;gap:12px">
          <label class="field">店舗<select name="store" required><option value="">読み込み中…</option></select></label>
          <label class="field">合言葉<input name="pass" type="password" autocomplete="current-password" required></label>
          <label class="field">あなたの名前<input name="name" required maxlength="20" placeholder="例: 山賀" autocomplete="name"></label>
          <div class="error">${esc(errorMsg)}</div>
          <button class="btn" type="submit">はじめる</button>
        </form>
      </div>
    </div></div>`;
  const form = document.getElementById('setup');
  try {
    const { stores } = await api.call('stores');
    form.store.innerHTML = stores.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  } catch (e) {
    form.store.innerHTML = '<option value="">店舗を読み込めません</option>';
    form.querySelector('.error').textContent = e.message;
  }
  form.onsubmit = async ev => {
    ev.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const deviceId = (await db.get('deviceId')) || uid();
      await db.set('deviceId', deviceId);
      const name = form.name.value.trim();
      const r = await api.call('login', { storeId: form.store.value, pass: form.pass.value, name, deviceId });
      S.me = { token: r.token, storeId: r.store.id, storeName: r.store.name, name, deviceId, isAdmin: r.isAdmin, company: r.company };
      S.authLost = false;
      await db.set('me', S.me);
      await loadLocal();
      S.view = 'home';
      render();
      refreshFromServer();
    } catch (e) {
      renderSetup(e.message);
    }
  };
}

// ── ホーム ──
const hasQty = pid => S.counts.get(pid)?.qty != null;

function areaInfo(area) {
  const list = S.items.filter(i => i.area === area);
  const done = list.filter(i => hasQty(i.id)).length;
  const now = Date.now();
  const workers = [], finished = [];
  for (const [dev, p] of Object.entries(S.participants)) {
    if (p.doneAreas?.includes(area)) finished.push(p.name);
    else if (p.area === area && now - p.areaAt < CLAIM_FRESH_MS && dev !== S.me.deviceId) workers.push(p.name);
  }
  return { total: list.length, done, workers, finished };
}

function renderHome() {
  const s = S.session;
  const total = S.items.length;
  const done = S.items.filter(i => hasQty(i.id)).length;
  const auth = S.authLost
    ? `<div class="card item-note">ログインの有効期限が切れました。入力はこの端末に残っています。<button class="btn" style="width:100%;margin-top:8px" data-act="relogin">合言葉を入れ直す</button></div>` : '';
  let body = '';
  if (!s) {
    body = `<div class="card"><h2>入力中の棚卸はありません</h2>
      <p class="muted">${S.me.isAdmin ? '「管理」から棚卸を始めてください。' : '管理者が棚卸を始めると、ここに表示されます。'}</p>
      <button class="btn ghost" data-act="reload">最新の状態を確認</button></div>`;
  } else {
    const closed = s.status !== 'open';
    body = `
      ${S.conflicts.size ? `<button class="card item-note" data-act="conflictList" style="text-align:left">⚠ 確認が必要な品目が ${S.conflicts.size} 件あります（他の人と数が食い違っています）</button>` : ''}
      <div class="card">
        <h2>${esc(s.date)} の棚卸 ${closed ? '（締め済み）' : ''}</h2>
        <div class="muted">全体 ${done} / ${total} か所</div>
        <div class="progress" style="margin-top:8px;border-radius:2px"><div style="width:${total ? done / total * 100 : 0}%"></div></div>
        <div class="muted" style="margin-top:8px">${S.items.length ? `オフライン準備OK（品目 ${S.items.length} 件を端末に保存済み）` : '品目を読み込めていません。電波のある場所で開き直してください。'}</div>
      </div>
      <div class="card"><h2>エリアを選んで数える</h2>
        ${S.areas.map(a => {
          const st = areaInfo(a);
          const who = [st.workers.length ? `${st.workers.join('・')}さんが担当中` : '', st.finished.length ? `${st.finished.join('・')}さん終了報告済み` : ''].filter(Boolean).join(' / ');
          return `<button class="area-row" data-area="${esc(a)}" ${closed ? 'disabled' : ''}>
            <span class="name">${esc(a)}<span class="who">${esc(who)}</span></span>
            <span class="count">${st.done}/${st.total}</span>
            <span class="mini-bar"><div style="width:${st.total ? st.done / st.total * 100 : 0}%"></div></span>
          </button>`;
        }).join('')}
      </div>
      <button class="btn ghost" data-act="list">一覧・検索</button>`;
  }
  if (!setHtml(`<div class="screen">${bar(S.me.storeName, '', S.me.isAdmin ? '<button class="btn-icon" data-act="admin">管理</button>' : '')}
    <div class="page">${auth}${body}
      <p class="muted" style="text-align:center">${esc(S.me.name)}さんとして入力中 ・ <button data-act="logout" style="color:var(--accent)">切り替え</button></p>
    </div></div>`)) return;
  $app.querySelectorAll('[data-area]').forEach(b => b.onclick = () => openArea(b.dataset.area));
  bindActs();
}

async function openArea(area) {
  const st = areaInfo(area);
  if (st.workers.length) {
    const ok = await confirmSheet(`${st.workers.join('・')}さんが「${area}」を担当中です。一緒に数えますか？（同じ品目を2人で入れると確認が必要になります）`, '数える');
    if (!ok) return;
  }
  go('count', { area });
}

function bindActs() {
  $app.querySelectorAll('[data-act]').forEach(b => b.onclick = () => ACTS[b.dataset.act]?.(b));
}

const ACTS = {
  reload: () => refreshFromServer(),
  list: () => { S.list.area = ''; go('list'); },
  admin: () => { go('admin'); refreshFromServer(); },
  home: () => go('home'),
  conflictList: () => { S.list.area = '__conf'; go('list'); },
  // 期限切れのとき: 同じ店舗・名前・端末のまま、合言葉だけ入れ直す（未送信は消さない）
  relogin: async () => {
    const r = await formSheet('合言葉を入れ直す', [{ name: 'pass', label: '合言葉', required: true, type: 'password' }], 'ログイン');
    if (!r) return;
    try {
      const res = await api.call('login', { storeId: S.me.storeId, pass: r.pass, name: S.me.name, deviceId: S.me.deviceId });
      S.me.token = res.token;
      S.me.isAdmin = res.isAdmin;
      await db.set('me', S.me);
      S.authLost = false;
      S.syncError = '';
      await refreshFromServer();
      toast('ログインし直しました');
    } catch (e) { toast(e.message); }
  },
  logout: async () => {
    if (S.pending) {
      if (S.authLost) return ACTS.relogin();
      const ok = await confirmSheet(`まだ送信していない入力が ${S.pending} 件あります。先に送信してから切り替えます。`, '送信して切り替え');
      if (!ok) return;
      await flush({ force: true });
      if (S.pending) return toast('送信できませんでした。電波のよい場所でもう一度お試しください。');
    }
    await db.set('me', null);
    S.me = null;
    renderSetup();
  },
};

// ── カウント画面 ──
function startCount({ area = '', itemId = '' } = {}) {
  const list = area ? S.items.filter(i => i.area === area) : S.items;
  let idx = itemId ? list.findIndex(i => i.id === itemId) : list.findIndex(i => !hasQty(i.id));
  if (idx < 0) idx = 0;
  S.count = { area, list, idx, buf: '', edit: null };
}

const isOpen = () => S.session?.status === 'open';

function renderCount() {
  const c = S.count;
  const it = c.list[c.idx];
  if (!it) { go('home'); return; }
  const done = c.list.filter(i => hasQty(i.id)).length;
  $app.__html = null;
  $app.innerHTML = `<div class="screen" id="count">
    ${bar(c.area || '全品目', '<button class="btn-icon" data-act="home">戻る</button>', '<button class="btn-icon" data-act="countList">一覧</button>')}
    <div class="progress"><div style="width:${done / c.list.length * 100}%"></div></div>
    <div class="item-area">
      <div class="item-meta"><span>${c.idx + 1} / ${c.list.length}</span><span>入力済み ${done}</span></div>
      <div class="item-name">${esc(it.name)}</div>
      <div class="item-hints">
        <span>単位: <b>${esc(it.unit || '—')}</b></span>
        ${it.prevQty != null ? `<span>前回: ${fmtQty(it.prevQty)}${esc(it.unit || '')}</span>` : ''}
        ${it.provisional ? '<span style="color:var(--warn)">仮登録</span>' : ''}
      </div>
      <div id="note"></div>
      <div class="qty"><span class="num"></span><span class="unit">${esc(it.unit || '')}</span></div>
    </div>
    <div class="keypad">
      <button class="key" data-k="7">7</button><button class="key" data-k="8">8</button><button class="key" data-k="9">9</button>
      <button class="key small" data-k="bs" aria-label="1文字消す">⌫</button>
      <button class="key" data-k="4">4</button><button class="key" data-k="5">5</button><button class="key" data-k="6">6</button>
      <button class="key small" data-k="prev">◀ 前へ</button>
      <button class="key" data-k="1">1</button><button class="key" data-k="2">2</button><button class="key" data-k="3">3</button>
      <button class="key next" data-k="next">次へ<br>▶</button>
      <button class="key" data-k="0" style="grid-column:span 2">0</button><button class="key" data-k=".">.</button>
    </div>
  </div>`;
  renderSyncBadge();
  bindActs();
  $app.querySelector('[data-act=countList]').onclick = () => { S.list.area = c.area; go('list'); };
  $app.querySelectorAll('[data-k]').forEach(b => {
    // 反応を速くするため click ではなく pointerdown で処理する
    b.addEventListener('pointerdown', ev => { ev.preventDefault(); onKey(b.dataset.k); });
  });
  updateQtyView();
  renderConflictNote();
}

// 他の人の入力・食い違い・締めの表示（同期のたびにここだけ書き換える）
function renderConflictNote() {
  const el = document.getElementById('note');
  if (!el || !S.count) return;
  const it = S.count.list[S.count.idx];
  const saved = S.counts.get(it.id);
  const cf = S.conflicts.get(it.id);
  let html = '';
  if (!isOpen()) html += '<div class="item-note">この棚卸は締め済みのため入力できません</div>';
  if (cf) {
    const alts = (cf.alts || [cf.mine]).filter(v => v !== cf.theirs);
    html += `<div class="item-note">⚠ ${esc(cf.theirBy)}さん: <b>${fmtQty(cf.theirs) || '空'}</b> ／ あなた: <b>${alts.map(v => fmtQty(v) || '空').join('・')}</b><br>正しいものを選ぶか、数え直して入力してください
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
        <button class="btn ghost" style="flex:1;min-height:44px" data-cf="theirs">${fmtQty(cf.theirs) || '空'} にする</button>
        ${alts.map((v, i) => `<button class="btn ghost" style="flex:1;min-height:44px" data-cf="m${i}">${fmtQty(v) || '空'} にする</button>`).join('')}
      </div></div>`;
  } else if (saved && saved.qty != null && saved.deviceId !== S.me.deviceId) {
    html += `<div class="item-note">${esc(saved.by)}さんが入力済み（${hhmm(saved.ts)}）</div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('[data-cf]').forEach(b => b.onclick = () => resolveConflict(it.id, b.dataset.cf));
}

async function resolveConflict(pid, pick) {
  const cf = S.conflicts.get(pid);
  if (!cf || !isOpen()) return;
  const alts = (cf.alts || [cf.mine]).filter(v => v !== cf.theirs);
  const qty = pick === 'theirs' ? cf.theirs : alts[Number(pick.slice(1))];
  // 画面に出ている相手の版を見たうえでの答えとして送る
  await saveCount(pid, qty, { baseRev: cf.theirRev ?? S.counts.get(pid)?.rev ?? 0, resolves: cf.opId || 'yes' });
  if (S.count) { S.count.buf = ''; S.count.edit = null; }
  redraw();
}

function updateQtyView() {
  // キーを押すたびに画面全体を描き直さず、数字の部分だけを書き換える
  const c = S.count;
  const box = $app.querySelector('.qty');
  if (!c || !box) return;
  const saved = S.counts.get(c.list[c.idx].id);
  const num = box.querySelector('.num');
  const showBuf = c.buf !== '';
  box.className = 'qty ' + (showBuf ? 'editing' : saved?.qty != null ? 'saved' : '');
  num.className = 'num ' + (!showBuf && saved?.qty == null ? 'empty' : '');
  num.textContent = showBuf ? c.buf : (saved?.qty != null ? fmtQty(saved.qty) : '未入力');
}

function onKey(k) {
  const c = S.count;
  if (k === 'prev') return move(-1);
  if (k === 'next') return commitAndNext();
  if (!isOpen()) return toast('締め済みのため入力できません');
  const pid = c.list[c.idx].id;
  // 入力を始めた時点に見えていた値・版・食い違いを覚えておく（入力中に他の人の値が届いても、見ていない値を上書きしない）
  if (c.buf === '' && !c.edit) {
    const saved = S.counts.get(pid);
    c.edit = { pid, rev: saved?.rev ?? 0, qty: saved?.qty ?? null, conflict: S.conflicts.get(pid)?.opId || '' };
  }
  if (/^\d$/.test(k)) {
    if (c.buf === '0') c.buf = '';
    if (c.buf.replace('.', '').length >= 6) return;
    if (c.buf.includes('.') && c.buf.split('.')[1].length >= 2) return;
    c.buf += k;
  } else if (k === '.') {
    if (c.buf.includes('.')) return;
    c.buf = (c.buf || '0') + '.';
  } else if (k === 'bs') {
    c.buf = c.buf.slice(0, -1);
    if (c.buf === '') c.edit = null;
  }
  if (navigator.vibrate) navigator.vibrate(8);
  updateQtyView();
}

let committing = false;
async function commitAndNext() {
  if (committing) return;
  const c = S.count;
  const it = c.list[c.idx];
  if (c.buf !== '') {
    if (!isOpen()) {
      // 締められた後は保存しないが、打った数字は消さずに残す
      return toast(`締められたため保存できません。打った数字（${c.buf}）は画面に残しています。管理者に伝えてください。`);
    }
    const qty = parseFloat(c.buf);
    if (!Number.isFinite(qty)) { c.buf = ''; c.edit = null; return updateQtyView(); }
    if (looksWrong(qty, it.prevQty)) {
      committing = true;
      const ok = await confirmSheet(
        `「${it.name}」が ${fmtQty(qty)}${it.unit || ''} になっています（前回 ${it.prevQty == null ? 'なし' : fmtQty(it.prevQty) + (it.unit || '')}）。この数で合っていますか？`,
        'この数で確定', '直す');
      committing = false;
      if (!ok) return;
    }
    const edit = c.edit?.pid === it.id ? c.edit : { rev: S.counts.get(it.id)?.rev ?? 0, qty: S.counts.get(it.id)?.qty ?? null, conflict: S.conflicts.get(it.id)?.opId || '' };
    let base = edit.rev;
    const now = S.counts.get(it.id);
    // 入力中に他の人の値が届いていたら、上書きしてよいか確かめる（確かめたら、その版を見たうえでの入力になる）
    if (now && now.rev > edit.rev && now.deviceId !== S.me.deviceId && now.qty !== qty) {
      committing = true;
      const ok = await confirmSheet(
        `入力している間に ${now.by}さんが「${it.name}」を ${fmtQty(now.qty)}${it.unit || ''} にしました。あなたの ${fmtQty(qty)}${it.unit || ''} で上書きしますか？`,
        `${fmtQty(qty)} で上書き`, 'やめる');
      committing = false;
      if (!ok) return;
      base = now.rev;
    }
    c.buf = ''; c.edit = null;
    // 食い違いの出ている品目に数え直した数を入れたら、その食い違いへの答えとして送る
    saveCount(it.id, qty, { baseRev: base, resolves: edit.conflict });
  } else {
    c.edit = null;
  }
  // 次の未入力へ。後ろに無ければ先頭から探す
  const n = c.list.length;
  let next = -1;
  for (let step = 1; step < n; step++) {
    const j = (c.idx + step) % n;
    if (!hasQty(c.list[j].id)) { next = j; break; }
  }
  if (next === -1) {
    if (hasQty(it.id) || n === 1) return areaFinished();
    next = Math.min(n - 1, c.idx + 1);
  }
  c.idx = next;
  renderCount();
}

// エリアをすべて入力したら、送信を済ませて終了報告する
async function areaFinished() {
  const area = S.count.area;
  renderCount();
  if (!area) return toast('すべて入力済みです');
  const ok = await confirmSheet(`「${area}」はすべて入力しました。送信して終了報告しますか？`, '送信して終了報告', 'まだ見直す');
  if (!ok) return;
  // 未送信がなくなるまで送ってから、終了報告だけを別に送る（サーバー側でも未送信・食い違いが無いことを確かめる）
  for (let i = 0; i < 10; i++) {
    const left = (await db.outbox()).filter(o => o.sessionId === S.session.id).length;
    if (!left) break;
    await flush({ force: true });
    if (!S.online || S.syncError) break;
  }
  const left = (await db.outbox()).filter(o => o.sessionId === S.session.id).length;
  if (left) return toast(`まだ ${left} 件が送れていません。電波のよい場所でもう一度「次へ」を押してください。`);
  if (S.conflicts.size) return toast('食い違いの確認が残っています。先に確認してください。');
  const r = await flush({ force: true, doneArea: area });
  if (!r?.doneAccepted) return toast('終了報告を受け付けられませんでした。少し待ってもう一度お試しください。');
  toast(`「${area}」の終了を報告しました`);
  go('home');
}

function move(d) {
  const c = S.count;
  if (c.buf !== '') {
    // 打ちかけの数字があるときは、黙って捨てない
    return toast('打ちかけの数字があります。「次へ」で確定するか、⌫ で消してください。');
  }
  c.edit = null;
  c.idx = Math.min(c.list.length - 1, Math.max(0, c.idx + d));
  renderCount();
}

// ── 一覧・検索 ──
function renderList() {
  const L = S.list;
  const changed = setHtml(`<div class="screen">
    ${bar('一覧・検索', '<button class="btn-icon" data-act="home">戻る</button>')}
    <div class="search"><input id="q" type="search" placeholder="商品名で探す（ひらがな可）" enterkeyhint="search"></div>
    <div class="chips">
      <button class="chip ${!L.area ? 'on' : ''}" data-chip="">すべて</button>
      <button class="chip ${L.area === '__todo' ? 'on' : ''}" data-chip="__todo">未入力だけ</button>
      ${S.conflicts.size ? `<button class="chip ${L.area === '__conf' ? 'on' : ''}" data-chip="__conf">⚠ 確認 ${S.conflicts.size}</button>` : ''}
      ${S.areas.map(a => `<button class="chip ${L.area === a ? 'on' : ''}" data-chip="${esc(a)}">${esc(a)}</button>`).join('')}
    </div>
    <div class="list" id="rows"></div>
    ${isOpen() ? '<div style="padding:8px 12px calc(8px + env(safe-area-inset-bottom));border-top:1px solid var(--line)"><button class="btn ghost" style="width:100%" data-act="addItem">＋ 一覧にない品目を追加</button></div>' : ''}
  </div>`);
  if (changed) {
    bindActs();
    const q = document.getElementById('q');
    q.value = L.q;
    q.oninput = () => { L.q = q.value; drawRows(); };
    $app.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => { L.area = b.dataset.chip; renderList(); });
  }
  drawRows();
}

function drawRows() {
  const L = S.list;
  const nq = norm(L.q);
  let list = S.items;
  if (L.area === '__todo') list = list.filter(i => !hasQty(i.id));
  else if (L.area === '__conf') list = list.filter(i => S.conflicts.has(i.id));
  else if (L.area) list = list.filter(i => i.area === L.area);
  if (nq) list = list.filter(i => (i._n ||= norm(i.name)).includes(nq));
  const rows = [];
  let lastArea = null;
  for (const i of list.slice(0, 500)) {
    if (i.area !== lastArea) { rows.push(`<div class="group-head">${esc(i.area)}</div>`); lastArea = i.area; }
    const c = S.counts.get(i.id);
    const has = c?.qty != null;
    const cf = S.conflicts.has(i.id);
    rows.push(`<button class="row ${has ? 'done' : ''}" data-id="${esc(i.id)}">
      <span class="name">${cf ? '⚠ ' : ''}${esc(i.name)}${has ? `<span class="by">${esc(c.by)} ${hhmm(c.ts)}</span>` : ''}</span>
      <span class="val ${has ? '' : 'empty'}">${has ? fmtQty(c.qty) + esc(i.unit || '') : '未'}</span></button>`);
  }
  if (!list.length) rows.push('<p class="muted" style="padding:16px">見つかりません</p>');
  const el = document.getElementById('rows');
  const html = rows.join('');
  if (el.__html !== html) { el.innerHTML = html; el.__html = html; }
  el.onclick = e => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    const it = S.itemById.get(b.dataset.id);
    const area = L.area && !L.area.startsWith('__') ? L.area : it.area;
    go('count', { area, itemId: it.id });
  };
}

ACTS.addItem = async () => {
  const r = await formSheet('一覧にない品目を追加', [
    { name: 'name', label: '商品名', required: true },
    { name: 'unit', label: '単位（例: pc, 本, ㎏）', required: true },
    { name: 'area', label: 'エリア', options: S.areas, value: S.list.area && !S.list.area.startsWith('__') ? S.list.area : S.areas[0] },
  ], '追加');
  if (!r) return;
  try {
    const { item } = await api.call('addItem', { token: S.me.token, ...r });
    S.items.push(item);
    setItems(S.items);
    await db.putItem(item);
    toast('仮登録しました。単価は管理者が後で入れます。');
    go('count', { area: item.area, itemId: item.id });
  } catch (e) {
    toast(e instanceof NetError ? '圏外のため追加できません。電波のある場所で追加してください。' : e.message);
  }
};

// ── 管理 ──
function heldCard() {
  const h = S.held;
  if (!h.length) return '';
  const open = S.session?.status === 'open';
  return `<div class="card"><h2>保留（締めた後に届いた入力）${h.length} 件</h2>
    ${h.slice(0, 30).map(x => `<div class="muted">${esc(S.itemById.get(x.pid)?.name || x.pid)}: ${fmtQty(x.qty)} （${esc(x.by)} ${hhmm(x.ts)}）</div>`).join('')}
    ${open ? '<button class="btn" style="width:100%;margin-top:8px" data-act="applyHeld">保留を取り込む</button>'
      : '<p class="muted">取り込むには「締めを取り消す」を押してから「保留を取り込む」を押してください。取り込まない場合は、そのまま Excel を作れば反映されません（Excel の「保留」シートに一覧が出ます）。</p>'}
  </div>`;
}

function renderAdmin() {
  const s = S.session;
  const missing = S.items.filter(i => !hasQty(i.id));
  const parts = Object.values(S.participants);
  const conf = S.openConflicts;
  if (!setHtml(`<div class="screen">
    ${bar('管理', '<button class="btn-icon" data-act="home">戻る</button>')}
    <div class="page">
      ${S.lastArchivedHeld ? `<div class="card item-note">${esc(S.lastArchivedHeld.session.date)} の棚卸（完了済み）に、締めた後の入力が ${S.lastArchivedHeld.held.length} 件届いています。${s ? '次の棚卸が始まっているためアプリからは取り込めません。スプレッドシートの記録シート（状態=held）で確認してください。' : 'この回を開き直すと取り込めます。'}
        ${!s ? '<button class="btn ghost" style="width:100%;margin-top:8px" data-act="reopenLast">この回を開き直す</button>' : ''}</div>` : ''}
      ${!s ? `<div class="card"><h2>棚卸を始める</h2>
          <p class="muted">始めた時点の品目・単価・置き場所で固定されます。</p>
          <label class="field">実施日<input id="date" type="date" value="${S.adminDate || (S.adminDate = monthEndDefault())}"></label>
          <button class="btn" style="margin-top:12px;width:100%" data-act="start">この日付で始める</button></div>`
        : `<div class="card"><h2>${esc(s.date)} の棚卸（${s.status === 'open' ? '入力中' : '締め済み'}）</h2>
          <p class="muted">未入力 ${missing.length} か所 ・ 食い違い ${conf.length} 件${S.pending ? ` ・ この端末の未送信 ${S.pending}件` : ''}</p>
          <div style="display:flex;flex-direction:column;gap:8px">
            <button class="btn" data-act="export">Excel を作る</button>
            ${s.status === 'open'
              ? '<button class="btn ghost" data-act="close">締める（以後は入力不可）</button>'
              : '<button class="btn ghost" data-act="reopen">締めを取り消す</button><button class="btn ghost" data-act="finish">完了して次の棚卸へ</button>'}
          </div></div>
          <div class="card"><h2>参加者</h2>
            ${parts.length ? parts.map(p => `<div class="area-row"><span class="name">${esc(p.name)}<span class="who">最終同期 ${hhmm(p.lastSync)}${p.area ? ' ・ ' + esc(p.area) : ''}</span></span>
              <span class="count">${p.pending ? `<span style="color:var(--warn)">未送信 ${p.pending}</span>` : '未送信なし'}<br>${p.doneAreas?.length ? '終了: ' + esc(p.doneAreas.join('・')) : ''}</span></div>`).join('')
              : '<p class="muted">まだ誰も入力していません</p>'}
            <p class="muted">※ 未送信の数は各スマホの自己申告です。圏外のスマホの分は、そのスマホが次に通信するまで分かりません。</p>
          </div>
          ${heldCard()}
          ${conf.length ? `<div class="card"><h2>⚠ 食い違い</h2>${conf.map(cf => `<div class="muted">${esc(S.itemById.get(cf.pid)?.name || cf.pid)}: ${esc(cf.theirBy)} ${fmtQty(cf.theirs)} ／ ${esc(cf.mineBy)} ${fmtQty(cf.mine)}</div>`).join('')}
            <p class="muted">${esc(conf.map(c => c.mineBy).filter((v, i, a) => a.indexOf(v) === i).join('・'))}さんのスマホで、どちらかを選ぶと解消します。</p></div>` : ''}
          ${missing.length ? `<div class="card"><h2>未入力</h2>${missing.slice(0, 50).map(i => `<div class="muted">${esc(i.area)} ・ ${esc(i.name)}</div>`).join('')}${missing.length > 50 ? `<div class="muted">ほか ${missing.length - 50} か所</div>` : ''}</div>` : ''}`}
    </div></div>`)) return;
  bindActs();
  const d = document.getElementById('date');
  if (d) d.oninput = () => { S.adminDate = d.value; };
}

Object.assign(ACTS, {
  start: async () => {
    const date = document.getElementById('date').value;
    try {
      await api.call('startSession', { token: S.me.token, date });
      S.adminDate = null; // 次の棚卸では、また月末の日付から始める
      toast('棚卸を始めました');
      await refreshFromServer();
      go('home');
    } catch (e) { toast(e.message); }
  },
  close: async () => {
    await flush({ force: true });
    const missing = S.items.filter(i => !hasQty(i.id)).length;
    const waiting = Object.values(S.participants).filter(p => p.pending > 0).map(p => p.name);
    const lines = [
      waiting.length ? `${waiting.join('・')}さんのスマホに未送信の入力があります。` : '',
      missing ? `未入力が ${missing} か所あります（Excel ではオレンジ色になります）。` : '',
      '締めると入力できなくなります（後で取り消せます）。',
    ].filter(Boolean).join('\n');
    if (!await confirmSheet(lines, '締める')) return;
    try {
      const { session } = await api.call('closeSession', { token: S.me.token, sessionId: S.session.id });
      S.session = session; await db.set('session', session);
      renderAdmin();
    } catch (e) { toast(e.message); }
  },
  reopen: async () => {
    try {
      const { session } = await api.call('reopenSession', { token: S.me.token, sessionId: S.session.id });
      S.session = session; await db.set('session', session);
      flush({ force: true });
      renderAdmin();
    } catch (e) { toast(e.message); }
  },
  applyHeld: async () => {
    try {
      const r = await api.call('applyHeld', { token: S.me.token, sessionId: S.session.id });
      toast(`保留を取り込みました（採用 ${r.appliedCount} 件${r.conflictCount ? `・食い違い ${r.conflictCount} 件` : ''}）`);
      await refreshFromServer();
    } catch (e) { toast(e.message); }
  },
  reopenLast: async () => {
    try {
      await api.call('reopenSession', { token: S.me.token, sessionId: S.lastArchivedHeld.session.id });
      await refreshFromServer();
      toast('開き直しました。「保留を取り込む」を押してください。');
    } catch (e) { toast(e.message); }
  },
  finish: async () => {
    if (!await confirmSheet('この棚卸を完了にします。今回の数量が次回の「前回」になります。Excel は作りましたか？', '完了にする')) return;
    try {
      await api.call('archiveSession', { token: S.me.token, sessionId: S.session.id });
    } catch (e) { return toast(e.message); }
    await refreshFromServer();
    go('home');
  },
  // Excel はサーバーが受け取った数量と、開始時に固定した品目・単価から作る（端末の未送信分は混ぜない）
  export: async b => {
    b.disabled = true; b.textContent = '作成中…';
    try {
      await flush({ force: true });
      const data = await api.call('exportData', { token: S.me.token, sessionId: S.session.id });
      if (data.conflicts?.length && !await confirmSheet(`食い違いが ${data.conflicts.length} 件残っています。今の値で作りますか？`, '作る')) return;
      const { buildInventoryXlsx } = await import('./export.js');
      const counts = new Map(data.counts.map(c => [c.pid, c.qty]));
      const { blob, missing } = await buildInventoryXlsx({
        storeName: S.me.storeName, company: S.me.company, date: data.session.date, items: data.items, counts, held: data.held || [],
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `棚卸_${S.me.storeName}_${data.session.date}.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      const unsentNote = S.pending ? `（この端末の未送信 ${S.pending}件は含まれていません）` : '';
      toast((missing.length ? `作成しました（未入力 ${missing.length} 品目はオレンジ色）` : '作成しました') + unsentNote);
    } catch (e) {
      toast(e instanceof NetError ? 'サーバーにつながらないため作れません。電波のある場所でもう一度お試しください。' : e.message);
    } finally {
      b.disabled = false; b.textContent = 'Excel を作る';
    }
  },
});

// ── 共通部品 ──
let toastTimer = null;
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 5000);
}

function confirmSheet(msg, okLabel = 'OK', cancelLabel = 'やめる') {
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.className = 'sheet-backdrop';
    bg.innerHTML = `<div class="sheet"><div style="white-space:pre-line">${esc(msg)}</div><div class="actions">
      <button class="btn ghost" data-r="0">${esc(cancelLabel)}</button><button class="btn" data-r="1">${esc(okLabel)}</button></div></div>`;
    bg.onclick = e => {
      const r = e.target.dataset?.r;
      if (r == null && e.target !== bg) return;
      bg.remove();
      resolve(r === '1');
    };
    document.body.appendChild(bg);
  });
}

function formSheet(title, fields, okLabel = 'OK') {
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.className = 'sheet-backdrop';
    bg.innerHTML = `<form class="sheet"><b>${esc(title)}</b>
      ${fields.map(f => f.options
        ? `<label class="field">${esc(f.label)}<select name="${f.name}">${f.options.map(o => `<option ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`
        : `<label class="field">${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" ${f.required ? 'required' : ''}></label>`).join('')}
      <div class="actions"><button type="button" class="btn ghost" data-r="0">やめる</button><button class="btn" type="submit">${esc(okLabel)}</button></div></form>`;
    const form = bg.querySelector('form');
    form.onsubmit = e => {
      e.preventDefault();
      const out = Object.fromEntries(fields.map(f => [f.name, form[f.name].value.trim()]));
      bg.remove();
      resolve(out);
    };
    bg.querySelector('[data-r="0"]').onclick = () => { bg.remove(); resolve(null); };
    document.body.appendChild(bg);
  });
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
