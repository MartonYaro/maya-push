/* MAYA API client — thin wrapper over fetch with token + SSE.
   Exposes window.MayaAPI. */
(function () {
  const TOKEN_KEY = 'maya_token';
  const API_BASE = '/api';

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  async function request(method, path, body) {
    const headers = { 'Accept': 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const tok = getToken();
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error((data && data.error) || ('http_' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const api = {
    getToken, setToken,
    isAuthed: () => !!getToken(),

    // auth
    register: (email, password, name) => request('POST', '/auth/register', { email, password, name }),
    login:    (email, password)        => request('POST', '/auth/login',    { email, password }),
    me:       ()                        => request('GET',  '/auth/me'),

    // apps
    listApps:    ()       => request('GET',  '/apps'),
    createApp:   (data)   => request('POST', '/apps', data),
    getApp:      (id)     => request('GET',  '/apps/' + id),
    updateApp:   (id, p)  => request('PATCH','/apps/' + id, p),
    deleteApp:   (id)     => request('DELETE','/apps/' + id),
    syncApp:     (id)     => request('POST', '/apps/' + id + '/sync'),
    syncHistory: (id, days = 30) => request('POST', '/apps/' + id + '/sync-history?days=' + days),
    matrix:      (id, days = 30) => request('GET',  '/apps/' + id + '/matrix?days=' + days),
    suggestions: (id, withMetrics = false) =>
      request('GET', `/apps/${id}/suggestions${withMetrics ? '?withMetrics=1' : ''}`),

    // keywords
    createKeyword: (data) => request('POST', '/keywords', data),
    listByApp:     (appId)=> request('GET',  '/keywords/by-app/' + appId),
    updateKeyword: (id, p)=> request('PATCH','/keywords/' + id, p),
    deleteKeyword: (id)   => request('DELETE','/keywords/' + id),
    keywordPositions: (id, days = 30) => request('GET', `/keywords/${id}/positions?days=${days}`),
    keywordInstalls:  (id) => request('GET',  '/keywords/' + id + '/installs'),
    setInstalls:      (id, date, count) => request('POST', '/keywords/' + id + '/installs', { date, count }),

    // transactions
    listTransactions: () => request('GET', '/transactions'),
    topup:    (amount, method, comment) => request('POST', '/transactions/topup', { amount, method, comment }),
    confirmTx: (id) => request('POST', '/transactions/' + id + '/confirm'),

    // dashboard
    summary:  () => request('GET',  '/dashboard/summary'),
    tick:     () => request('POST', '/dashboard/tick'),

    // SSE
    openStream(handlers = {}) {
      const tok = getToken();
      if (!tok) return null;
      const url = `${API_BASE}/stream?token=${encodeURIComponent(tok)}`;
      const es = new EventSource(url);
      es.onerror = () => { /* auto-reconnect by browser */ };
      for (const [evt, fn] of Object.entries(handlers)) {
        es.addEventListener(evt, (e) => {
          let data = null;
          try { data = JSON.parse(e.data); } catch {}
          fn(data, e);
        });
      }
      return es;
    },
  };

  window.MayaAPI = api;
})();
