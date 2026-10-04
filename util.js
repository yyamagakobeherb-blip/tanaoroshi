// 検索用の正規化: 全角半角・ひらがなカタカナ・大文字小文字・空白の違いを無視する
export function norm(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, '');
}

export function fmtQty(q) {
  if (q == null) return '';
  return Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000);
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function hhmm(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 入力ミスらしい数量か（前回の数量と比べて極端に違う）
export function looksWrong(qty, prev) {
  if (qty >= 1000) return true;
  if (prev == null || prev === 0) return qty >= 100;
  return qty >= 10 && qty >= prev * 10;
}

// 棚卸は月末に1回。実施日の初期値は今月末（月初の5日までなら先月末）
export function monthEndDefault(now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth();
  const end = now.getDate() <= 5 ? new Date(y, m, 0) : new Date(y, m + 1, 0);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
}
