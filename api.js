// サーバーとの通信。API URL が未設定のときは端末内だけで動く「お試しモード」になる。

const TIMEOUT_MS = 20000;

export class GasBackend {
  constructor(url) { this.url = url; }

  async call(action, payload = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      // text/plain にして CORS のプリフライトを避ける（GAS は OPTIONS に応答できない）
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, ...payload }),
        signal: ctrl.signal,
        redirect: 'follow',
        keepalive: action === 'sync',
      });
      if (!res.ok) throw new NetError(`通信エラー (${res.status})`);
      const data = await res.json();
      if (!data.ok) throw new ApiError(data.error || 'サーバーでエラーが起きました', data.code);
      return data;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new NetError(e.name === 'AbortError' ? '通信がタイムアウトしました' : 'サーバーにつながりません');
    } finally {
      clearTimeout(timer);
    }
  }
}

export class NetError extends Error {}
export class ApiError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

