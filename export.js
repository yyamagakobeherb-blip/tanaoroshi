// 現行の「棚卸用紙」と同じ形の Excel を端末内で作る。
// 取引先（出力セクション）ごとに 60 行ずつのページに分け、ページごとに見出しと小計を付ける。
const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
const ROWS_PER_PAGE = 60;

function loadExcelJs() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = EXCELJS_URL;
    s.onload = () => resolve(window.ExcelJS);
    s.onerror = () => reject(new Error('Excel作成用の部品を読み込めませんでした。ネットにつながっているか確認してください。'));
    document.head.appendChild(s);
  });
}

const thin = { style: 'thin' };
const box = { top: thin, left: thin, bottom: thin, right: thin };

/**
 * @param {object} p
 * @param {string} p.storeName   在庫場所（例: レストラン厨房）
 * @param {string} p.company     会社名・事業所名（用紙右上）
 * @param {string} p.date        実施日 YYYY-MM-DD
 * @param {Array}  p.items       品目（section, sectionOrder, name, unit, price, supplier, delivered, expiry）
 * @param {Map}    p.counts      置場ID → 数量
 */
export async function buildInventoryXlsx({ storeName, company, date, items, counts, held = [] }) {
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  const [y, m, d] = date.split('-').map(Number);
  const ws = wb.addWorksheet(`${m}月`, {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: .4, right: .4, top: .5, bottom: .5, header: .2, footer: .2 } },
  });
  ws.columns = [
    { width: 5 }, { width: 44 }, { width: 11 }, { width: 6 }, { width: 9 },
    { width: 10 }, { width: 12 }, { width: 11 }, { width: 2 }, { width: 6 }, { width: 11 },
  ];

  // 同じ品目を複数の場所で数えた分は合計する。1か所でも未入力なら「未入力あり」として色を付ける
  const merged = new Map();
  for (const it of items) {
    const key = it.itemId || it.id;
    const q = counts.get(it.id);
    const m = merged.get(key);
    if (!m) merged.set(key, { ...it, qty: q ?? null, anyMissing: q == null, places: 1 });
    else {
      m.places++;
      if (q == null) m.anyMissing = true;
      else m.qty = (m.qty ?? 0) + q;
    }
  }

  // セクションごとにまとめる（並びは取り込み時の順）
  const sections = [];
  const bySection = new Map();
  [...merged.values()].sort((a, b) => (a.sectionOrder - b.sectionOrder) || (a.outOrder - b.outOrder)).forEach(it => {
    if (!bySection.has(it.section)) { bySection.set(it.section, []); sections.push(it.section); }
    bySection.get(it.section).push(it);
  });

  const totals = new Map(); // 区分 → 合計
  const missing = [];
  let r = 1;
  const breaks = [];

  for (const sec of sections) {
    const list = bySection.get(sec);
    for (let p = 0; p < list.length; p += ROWS_PER_PAGE) {
      const page = list.slice(p, p + ROWS_PER_PAGE);
      // 見出し
      ws.mergeCells(r, 1, r, 11);
      Object.assign(ws.getCell(r, 1), { value: '棚　卸　用　紙' });
      ws.getCell(r, 1).font = { size: 16, bold: true };
      ws.getCell(r, 1).alignment = { horizontal: 'center' };
      r++;
      ws.getCell(r, 10).value = company || '';
      r++;
      ws.getCell(r, 1).value = `実施日：${y}年${m}月${d}日`;
      r++;
      ws.getCell(r, 1).value = `在庫場所：${storeName}`;
      r++;
      ws.getCell(r, 2).value = `（${sec}）`;
      ws.getCell(r, 2).font = { bold: true };
      r++;
      const head = ['No.', '商品名', '納品日', '単位', '在庫数量', '原価単価', '原価合計', '仕入先', '', '監査', '賞味期限'];
      head.forEach((h, i) => {
        const c = ws.getCell(r, i + 1);
        c.value = h; c.border = box; c.font = { bold: true }; c.alignment = { horizontal: 'center' };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
      });
      r++;
      const first = r;
      page.forEach((it, i) => {
        const qty = it.qty == null ? null : Math.round(it.qty * 1000) / 1000;
        if (it.anyMissing) missing.push(it);
        const row = ws.getRow(r);
        row.values = [
          p + i + 1, it.name, it.delivered ? new Date(it.delivered) : null, it.unit,
          qty ?? null, it.price ?? null, null, it.supplier || '', null, null, it.expiry ? new Date(it.expiry) : null,
        ];
        row.getCell(7).value = { formula: `IF(OR(E${r}="",F${r}=""),"",E${r}*F${r})` };
        for (let c = 1; c <= 11; c++) row.getCell(c).border = box;
        row.getCell(3).numFmt = 'm/d';
        row.getCell(11).numFmt = 'yyyy/m/d';
        row.getCell(6).numFmt = '#,##0';
        row.getCell(7).numFmt = '#,##0';
        if (it.anyMissing) row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE0B2' } };
        r++;
      });
      ws.getCell(r, 2).value = '小計';
      ws.getCell(r, 7).value = { formula: `SUM(G${first}:G${r - 1})` };
      ws.getCell(r, 7).numFmt = '#,##0';
      ws.getCell(r, 2).font = ws.getCell(r, 7).font = { bold: true };
      const kind = page[0].category || '食品';
      totals.set(kind, [...(totals.get(kind) || []), `G${r}`]);
      breaks.push(r);
      r++;
    }
  }

  for (const [kind, cells] of totals) {
    ws.getCell(r, 2).value = `${storeName}合計（${kind}）`;
    ws.getCell(r, 7).value = { formula: cells.join('+') };
    ws.getCell(r, 7).numFmt = '#,##0';
    ws.getCell(r, 2).font = ws.getCell(r, 7).font = { bold: true };
    r++;
  }
  breaks.slice(0, -1).forEach(br => { ws.getRow(br).addPageBreak(); });

  // 締めた後に届いて採用しなかった入力（参考）
  if (held.length) {
    const hs = wb.addWorksheet('保留');
    hs.columns = [{ header: '商品名', width: 44 }, { header: '数量', width: 9 }, { header: '単位', width: 6 }, { header: '入力者', width: 12 }, { header: '入力日時', width: 18 }];
    const byPid = new Map(items.map(i => [i.id, i]));
    held.forEach(h => {
      const it = byPid.get(h.pid);
      hs.addRow([it?.name || h.pid, h.qty, it?.unit || '', h.by, new Date(h.ts)]);
    });
    hs.getColumn(5).numFmt = 'yyyy/m/d h:mm';
    hs.getRow(1).font = { bold: true };
  }

  const buf = await wb.xlsx.writeBuffer();
  return { blob: new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), missing };
}
