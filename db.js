// 端末内の保存（IndexedDB）。画面はここだけを読み書きし、サーバーを待たない。
// 関連する書き込み（数量・送信待ち・食い違い・カーソル）は、1つのトランザクションでまとめて行う。
const DB_NAME = 'tanaoroshi';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv');
      db.createObjectStore('items', { keyPath: 'id' });
      // counts のキーは [棚卸回ID, 置場ID]（同じ品目を複数の場所に置ける）
      const counts = db.createObjectStore('counts', { keyPath: ['sessionId', 'pid'] });
      counts.createIndex('bySession', 'sessionId');
      // 送信待ち。opId は端末ID+時刻+連番で、同じものを2回送ってもサーバー側で1回分として扱う
      db.createObjectStore('outbox', { keyPath: 'opId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    Promise.resolve(fn(...storeNames.map(n => t.objectStore(n)))).then(r => { result = r; }, e => { try { t.abort(); } catch { /* 終了済み */ } reject(e); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const key = (sessionId, pid) => sessionId + '|' + pid;

export const db = {
  get: (k) => tx(['kv'], 'readonly', s => wrap(s.get(k))),
  set: (k, value) => tx(['kv'], 'readwrite', s => { s.put(value, k); }),

  allItems: () => tx(['items'], 'readonly', s => wrap(s.getAll())),
  replaceItems: (items) => tx(['items'], 'readwrite', s => {
    s.clear();
    items.forEach(i => s.put(i));
  }),
  putItem: (item) => tx(['items'], 'readwrite', s => { s.put(item); }),

  sessionCounts: (sessionId) => tx(['counts'], 'readonly', s => wrap(s.index('bySession').getAll(sessionId))),

  // 入力1件を保存し、同じトランザクションで送信待ちにも積む（片方だけ残ることがない）。
  // conflicts を渡すと食い違いの一覧も同時に書き換える（解決操作の取りこぼし防止）
  recordCount: (count, op, conflicts) => tx(['counts', 'outbox', 'kv'], 'readwrite', (c, o, kv) => {
    c.put(count);
    o.put(op);
    if (conflicts) kv.put(conflicts, 'conflicts');
  }),

  /**
   * 同期の結果をまとめて反映する。
   * - ack: サーバーが受け取った opId（送信待ちから消す）
   * - rows: サーバーの現在値。まだ送っていない自分の入力がある置場と、手元より古い版は取り込まない
   * - conflicts / rev: 食い違いの一覧と、受け取り済みの位置
   * 戻り値: 実際に取り込んだ行
   */
  applySync: ({ sessionId, ack = [], rows = [], conflicts, rev }) => tx(['counts', 'outbox', 'kv'], 'readwrite', async (c, o, kv) => {
    ack.forEach(id => o.delete(id));
    const pending = new Set((await wrap(o.getAll())).map(x => key(x.sessionId, x.pid)));
    const accepted = [];
    for (const r of rows) {
      const row = { ...r, sessionId };
      if (pending.has(key(sessionId, row.pid))) continue;
      const cur = await wrap(c.get([sessionId, row.pid]));
      if (cur && cur.rev > row.rev) continue; // 遅れて届いた古い値で巻き戻さない
      c.put(row);
      accepted.push(row);
    }
    if (conflicts) kv.put(conflicts, 'conflicts');
    if (rev != null) {
      const before = (await wrap(kv.get('rev'))) || 0;
      kv.put(Math.max(before, rev), 'rev');
    }
    return accepted;
  }),

  outbox: () => tx(['outbox'], 'readonly', s => wrap(s.getAll())),
};
