// お試しモード: サーバー（gas/Code.js）と同じ約束事を端末内(localStorage)で再現する。
// 本番の動きは gas/Code.js が正。ここは画面を試すための簡易版。
import { DEMO_ITEMS } from './demo-items.js';
import { NetError, ApiError } from './api.js';

const DEMO_KEY = 'tanaoroshi-demo-server-v3';

export class DemoBackend {
  load() {
    try {
      const s = JSON.parse(localStorage.getItem(DEMO_KEY));
      if (s) return s;
    } catch { /* 初回 */ }
    return { stores: [{ id: 'demo', name: 'お試し店舗' }], items: DEMO_ITEMS, sessions: [], logs: {}, snaps: {}, participants: {} };
  }
  save(s) { localStorage.setItem(DEMO_KEY, JSON.stringify(s)); }

  async call(action, p = {}) {
    await new Promise(r => setTimeout(r, 200)); // 通信の遅れを少しだけ再現
    if (DemoBackend.offline) throw new NetError('サーバーにつながりません');
    const s = this.load();
    const out = this[action](s, p);
    this.save(s);
    return JSON.parse(JSON.stringify({ ok: true, ...out }));
  }

  me(p) {
    if (!String(p.token || '').startsWith('demo-')) throw new ApiError('ログインし直してください', 'AUTH');
    return { isAdmin: p.token.startsWith('demo-admin'), name: p.token.split(':')[1] || '' };
  }
  admin(p) { if (!this.me(p).isAdmin) throw new ApiError('管理者だけが使える操作です', 'FORBIDDEN'); }

  stores(s) { return { stores: s.stores }; }

  login(s, p) {
    if (p.pass !== '1234' && p.pass !== 'admin') throw new ApiError('合言葉が違います', 'AUTH');
    const role = p.pass === 'admin' ? 'admin' : 'staff';
    return { token: `demo-${role}:${p.name}`, store: s.stores[0], isAdmin: role === 'admin', company: '（お試し）' };
  }

  state(s, sid) {
    const st = { current: {}, ops: {}, conflicts: {}, held: {}, rev: (s.logs[sid] || []).length + 1 };
    (s.logs[sid] || []).forEach((r, i) => this.applyRow(st, r, i + 2));
    return st;
  }
  applyRow(st, r, rev) {
    st.ops[r.opId] = r.status;
    if (r.status === 'held') { st.held[r.opId] = { opId: r.opId, pid: r.pid, qty: r.qty, by: r.by, deviceId: r.deviceId, ts: r.at, baseRev: r.baseRev || 0, heldRev: rev }; return; }
    if (r.opId.endsWith('~h')) delete st.held[r.opId.slice(0, -2)];
    // 同じ端末の古い食い違いだけを置き換える（他の人の食い違いは消さない）
    if (!r.opId.endsWith('~h')) for (const k in st.conflicts) if (st.conflicts[k].pid === r.pid && st.conflicts[k].mineDevice === r.deviceId) delete st.conflicts[k];
    if (r.status === 'ok') {
      st.current[r.pid] = { pid: r.pid, qty: r.qty, by: r.by, deviceId: r.deviceId, ts: r.at, rev };
    } else if (r.status === 'conflict') {
      st.conflicts[r.opId] = { opId: r.opId, pid: r.pid, mine: r.qty, mineBy: r.by, mineDevice: r.deviceId };
    }
  }
  judge(st, op) {
    const c = st.current[op.pid];
    const newerThanHeld = !!op.heldRev && !!c && c.rev > op.heldRev;
    const isConflict = !!c && c.qty !== op.qty && ((c.rev > (op.baseRev || 0) && c.deviceId !== op.deviceId) || newerThanHeld);
    return { opId: op.opId, pid: op.pid, qty: op.qty, by: op.by, deviceId: op.deviceId, at: Date.now(), status: isConflict ? 'conflict' : 'ok', resolves: op.resolves || '', baseRev: op.baseRev || 0 };
  }
  cinfo(st, c) {
    const cur = st.current[c.pid];
    return { ...c, theirs: cur?.qty ?? null, theirBy: cur?.by || '', theirRev: cur?.rev || 0, theirDevice: cur?.deviceId || '', theirTs: cur?.ts || 0 };
  }
  conflictList(st) { return Object.values(st.conflicts).map(c => this.cinfo(st, c)); }

  itemsFor(s, session, isAdmin) {
    const src = session ? s.snaps[session.id] : s.items;
    return src.map(i => {
      const o = { ...i };
      if (!isAdmin) { delete o.price; delete o.delivered; delete o.expiry; }
      return o;
    });
  }
  current(s) { return s.sessions.find(x => x.status === 'open' || x.status === 'closed') || null; }

  bootstrap(s, p) {
    const me = this.me(p);
    const session = this.current(s);
    let counts = [], rev = 0, conflicts = [], held = [];
    if (session) {
      const st = this.state(s, session.id);
      counts = Object.values(st.current); rev = st.rev; conflicts = this.conflictList(st);
      if (me.isAdmin) held = Object.values(st.held);
    }
    const last = s.sessions.filter(x => x.status === 'archived').pop();
    const lastHeld = last ? Object.values(this.state(s, last.id).held) : [];
    return {
      items: this.itemsFor(s, session, me.isAdmin), session, counts, rev, conflicts, held,
      lastArchivedHeld: me.isAdmin && lastHeld.length ? { session: last, held: lastHeld } : null,
      participants: session ? s.participants[session.id] || {} : {}, store: s.stores[0], company: '（お試し）', isAdmin: me.isAdmin,
    };
  }

  sync(s, p) {
    const me = this.me(p);
    const session = s.sessions.find(x => x.id === p.sessionId);
    if (!session) throw new ApiError('この棚卸は見つかりません', 'NO_SESSION');
    const st = this.state(s, session.id);
    const log = (s.logs[session.id] ||= []);
    const valid = new Set(s.snaps[session.id].map(i => i.id));
    const applied = [], conflicts = [], held = [];
    for (const op of (p.ops || []).slice(0, 200)) {
      if (st.ops[op.opId]) {
        applied.push(op.opId);
        if (st.ops[op.opId] === 'conflict' && st.conflicts[op.opId]) conflicts.push(this.cinfo(st, st.conflicts[op.opId]));
        continue;
      }
      if (!valid.has(op.pid) || op.opId.endsWith('~h')) { applied.push(op.opId); continue; }
      if (session.status !== 'open') {
        const row = { opId: op.opId, pid: op.pid, qty: op.qty, by: op.by, deviceId: p.deviceId, at: Date.now(), status: 'held', baseRev: op.baseRev || 0 };
        log.push(row); this.applyRow(st, row, log.length + 1);
        held.push(op.opId); applied.push(op.opId);
        continue;
      }
      const row = this.judge(st, { ...op, deviceId: p.deviceId });
      log.push(row);
      this.applyRow(st, row, log.length + 1);
      if (row.status === 'conflict') conflicts.push(this.cinfo(st, st.conflicts[op.opId]));
      applied.push(op.opId);
    }
    const remaining = Math.max(0, (p.pendingCount || 0) - applied.length);
    const mineConf = Object.values(st.conflicts).filter(c => c.mineDevice === p.deviceId).length;
    const mineHeld = Object.values(st.held).filter(h => h.deviceId === p.deviceId).length;
    const doneOk = !!p.doneArea && session.status === 'open' && remaining === 0 && !mineHeld && !mineConf;
    const parts = (s.participants[session.id] ||= {});
    const pt = (parts[p.deviceId] ||= { doneAreas: [] });
    Object.assign(pt, { name: p.by || me.name, lastSync: Date.now(), pending: remaining });
    if (p.area) { pt.area = p.area; pt.areaAt = Date.now(); }
    if (doneOk && !pt.doneAreas.includes(p.doneArea)) pt.doneAreas.push(p.doneArea);
    return {
      applied, conflicts, held, doneAccepted: doneOk, changes: Object.values(st.current).filter(c => c.rev > (p.since || 0)),
      rev: log.length + 1, session, participants: parts, openConflicts: this.conflictList(st),
      heldItems: me.isAdmin ? Object.values(st.held) : undefined,
    };
  }

  exportData(s, p) {
    this.admin(p);
    const session = s.sessions.find(x => x.id === p.sessionId);
    const st = this.state(s, session.id);
    return { session, items: this.itemsFor(s, session, true), counts: Object.values(st.current), conflicts: this.conflictList(st), held: Object.values(st.held) };
  }

  applyHeld(s, p) {
    this.admin(p);
    const session = s.sessions.find(x => x.id === p.sessionId);
    if (session?.status !== 'open') throw new ApiError('締めを取り消してから取り込んでください', 'STATE');
    const st = this.state(s, session.id);
    const log = s.logs[session.id];
    let ok = 0, ng = 0;
    Object.values(st.held).sort((a, b) => a.ts - b.ts).forEach(h => {
      const row = this.judge(st, { ...h, opId: h.opId + '~h' });
      log.push(row); this.applyRow(st, row, log.length + 1);
      if (row.status === 'ok') ok++; else ng++;
    });
    return { appliedCount: ok, conflictCount: ng };
  }

  startSession(s, p) {
    this.admin(p);
    if (this.current(s)) throw new ApiError('この店舗には、まだ終わっていない棚卸があります', 'OPEN_EXISTS');
    const session = { id: 'S' + Date.now().toString(36), storeId: 'demo', date: p.date, status: 'open' };
    s.sessions.push(session);
    s.logs[session.id] = [];
    s.snaps[session.id] = JSON.parse(JSON.stringify(s.items));
    return { session };
  }

  setStatus(s, p, from, to, check) {
    this.admin(p);
    const session = s.sessions.find(x => x.id === p.sessionId);
    if (!session || !from.includes(session.status)) throw new ApiError('この操作は今の状態ではできません', 'STATE');
    if (check) check(session);
    session.status = to;
    return { session };
  }
  closeSession(s, p) {
    return this.setStatus(s, p, ['open'], 'closed', () => {
      const n = Object.keys(this.state(s, p.sessionId).conflicts).length;
      if (n) throw new ApiError(`食い違いが ${n} 件残っています。先に確認してください`, 'CONFLICTS');
    });
  }
  reopenSession(s, p) {
    return this.setStatus(s, p, ['closed', 'archived'], 'open', ses => {
      const cur = this.current(s);
      if (cur && cur.id !== ses.id) throw new ApiError('次の棚卸が始まっているため戻せません', 'STATE');
    });
  }
  archiveSession(s, p) {
    const r = this.setStatus(s, p, ['closed'], 'archived');
    // 前回数量を更新（品目ごとの合計）
    const cur = this.state(s, p.sessionId).current;
    const tot = {};
    s.snaps[p.sessionId].forEach(i => { const q = cur[i.id]?.qty; if (q != null) tot[i.itemId] = (tot[i.itemId] || 0) + q; });
    s.items.forEach(i => { i.prevQty = tot[i.itemId] ?? null; });
    return r;
  }

  addItem(s, p) {
    this.me(p);
    const n = Date.now().toString(36);
    const area = p.area || '未設定';
    const areaOrder = s.items.find(i => i.area === area)?.areaOrder ?? 999;
    const item = { id: 'P' + n, itemId: 'T' + n, name: p.name, unit: p.unit, area, areaOrder, sort: 9999, section: '仮登録', sectionOrder: 999, outOrder: 0, category: '食品', supplier: '', prevQty: null, provisional: true };
    s.items.push(item);
    const cur = this.current(s);
    if (cur?.status === 'open') s.snaps[cur.id].push(item);
    return { item };
  }
}
