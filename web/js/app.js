/* MAYA dashboard app — replaces the old localStorage-based script.
   Keeps function names referenced by inline onclick handlers in the HTML:
     handleAuth, setAuthTab, handleLogout, goPage, openAddApp, submitAddApp,
     deleteApp, toggleAppStatus, openAddKw, submitAddKw, deleteKw,
     selectTopupPreset, submitTopup, openModal, closeModal, toggleSidebar,
     editAsoCell.

   Internally everything talks to MayaAPI. We keep a small client cache
   `data` shaped close to the original so render functions remain readable. */

const API = window.MayaAPI;

const colorPalette = [
  ['#3aff9f', '#1a9c5e'],
  ['#FC5200', '#d94800'],
  ['#0072CE', '#005ba8'],
  ['#e8a04a', '#b8842c'],
  ['#d44a3a', '#a23425'],
  ['#7c3aed', '#5b21b6'],
  ['#0891b2', '#0e7490'],
  ['#84cc16', '#65a30d'],
];

// country code → emoji + label
const COUNTRY_INFO = {
  us: { flag: '🇺🇸', label: 'США' },
  ru: { flag: '🇷🇺', label: 'Россия' },
  de: { flag: '🇩🇪', label: 'Германия' },
  fr: { flag: '🇫🇷', label: 'Франция' },
  gb: { flag: '🇬🇧', label: 'Великобритания' },
  es: { flag: '🇪🇸', label: 'Испания' },
  it: { flag: '🇮🇹', label: 'Италия' },
  br: { flag: '🇧🇷', label: 'Бразилия' },
  jp: { flag: '🇯🇵', label: 'Япония' },
  kr: { flag: '🇰🇷', label: 'Корея' },
  cn: { flag: '🇨🇳', label: 'Китай' },
  in: { flag: '🇮🇳', label: 'Индия' },
  tr: { flag: '🇹🇷', label: 'Турция' },
  ua: { flag: '🇺🇦', label: 'Украина' },
};
function geoLabel(code) {
  const c = (code || 'us').toLowerCase();
  const i = COUNTRY_INFO[c];
  return i ? `${i.flag} ${i.label}` : c.toUpperCase();
}

let data = {
  user: null,
  balance: 0,
  apps: [],            // mapped from API: id, name, url, category, country, geo, status, createdAt, colorA, colorB, keywords[]
  transactions: [],    // mapped from API: id, type, amount, status, description, createdAt
};

let _stream = null;

/* ─────── mappers ─────── */

function mapApp(a, idx) {
  const colors = colorPalette[(idx ?? 0) % colorPalette.length];
  return {
    id: String(a.id),
    apiId: a.id,
    name: a.name || 'Unnamed',
    url: a.url || '',
    category: a.category || 'App',
    country: a.country || 'us',
    geo: geoLabel(a.country),
    status: a.status || 'active',
    createdAt: a.created_at || Date.now(),
    colorA: colors[0],
    colorB: colors[1],
    iconUrl: a.icon_url || null,
    rating: typeof a.rating === 'number' ? a.rating : null,
    ratingCount: a.rating_count || null,
    developer: a.developer || null,
    subtitle: a.subtitle || null,
    storeId: a.store_id || null,
    keywords: [],
  };
}

function mapKeyword(k) {
  return {
    id: String(k.id),
    apiId: k.id,
    name: k.term,
    currentPos: k.current_pos,
    targetPos: k.target_pos,
    plan: 1500, // numeric volume goal used by progress UI (cosmetic)
    planTier: k.plan,
    dailyCap: k.daily_cap,
    status: k.status,
    totalInstalled: k.total_installed || 0,
    installs: {},  // filled lazily per app-detail page
  };
}

function mapTx(t) {
  return {
    id: String(t.id),
    type: t.type,
    amount: t.amount,
    status: t.status,
    description: t.description || '',
    createdAt: t.created_at,
  };
}

/* ─────── data loading ─────── */

async function reloadAll() {
  const [meRes, appsRes, txRes] = await Promise.all([
    API.me(),
    API.listApps(),
    API.listTransactions(),
  ]);
  data.user = meRes.user;
  data.balance = meRes.balance;
  data.transactions = (txRes.transactions || []).map(mapTx);
  data.apps = (appsRes.apps || []).map(mapApp);
  // keywords lazy-loaded when needed; but for dashboard/campaigns counters we
  // need keyword counts + totals — fetch a light per-app list in parallel.
  await Promise.all(data.apps.map(async (a) => {
    const r = await API.listByApp(a.apiId);
    a.keywords = (r.keywords || []).map(mapKeyword);
  }));
}

async function ensureAppKeywords(app) {
  const r = await API.getApp(app.apiId);
  app.keywords = (r.keywords || []).map(mapKeyword);
}

/* ═══════════════════════════════════════════════════
   AUTH
   ═══════════════════════════════════════════════════ */

let currentAuthTab = 'login';

function setAuthTab(tab) {
  currentAuthTab = tab;
  document.querySelectorAll('.auth-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.getElementById('nameRow').style.display = tab === 'register' ? 'flex' : 'none';
  document.getElementById('authTitle').innerHTML = tab === 'login'
    ? 'Вход в&nbsp;<span class="accent">кабинет</span>'
    : '<span class="accent">Создать</span> аккаунт';
  document.getElementById('authSub').textContent = tab === 'login'
    ? '— Личный кабинет MAYA Push —'
    : '— Регистрация в системе —';
  document.getElementById('authSubmitBtn').textContent = tab === 'login' ? 'Войти →' : 'Создать →';
  document.getElementById('authError').classList.remove('show');
}

async function handleAuth(e) {
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim().toLowerCase();
  const password = document.getElementById('authPassword').value;
  const name = document.getElementById('authName').value.trim();

  try {
    let res;
    if (currentAuthTab === 'register') {
      if (!name) return showAuthError('Укажите имя');
      res = await API.register(email, password, name);
    } else {
      res = await API.login(email, password);
    }
    API.setToken(res.token);
    await enterApp();
    toast(currentAuthTab === 'register' ? 'Добро пожаловать!' : 'Вход выполнен');
  } catch (err) {
    const map = {
      email_taken: 'Пользователь с таким email уже есть',
      invalid_credentials: 'Неверный email или пароль',
      password_too_short: 'Пароль слишком короткий (мин. 6)',
      missing_fields: 'Заполните все поля',
    };
    showAuthError(map[err.message] || ('Ошибка: ' + err.message));
  }
}

function showAuthError(msg) {
  const errorEl = document.getElementById('authError');
  errorEl.textContent = msg;
  errorEl.classList.add('show');
}

function handleLogout() {
  if (!confirm('Выйти из аккаунта?')) return;
  if (_stream) { _stream.close(); _stream = null; }
  API.setToken('');
  data = { user: null, balance: 0, apps: [], transactions: [] };
  document.getElementById('app').style.display = 'none';
  document.getElementById('authScreen').style.display = 'flex';
}

async function enterApp() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('app').style.display = 'grid';
  try {
    await reloadAll();
  } catch (e) {
    if (e.status === 401) { handleLogout(); return; }
    toast('Не удалось загрузить данные: ' + e.message, 'error');
  }
  refreshUserUI();
  routeFromHash();
  openLiveStream();
}

function refreshUserUI() {
  if (!data.user) return;
  document.getElementById('userName').textContent = data.user.name;
  document.getElementById('userEmail').textContent = data.user.email;
  document.getElementById('userAvatar').textContent = (data.user.name || 'U').slice(0, 1).toUpperCase();
  document.getElementById('balanceTop').textContent = '$' + formatNum(data.balance);
  document.getElementById('appsCountBadge').textContent = data.apps.length;
}

/* ═══════════════════════════════════════════════════
   LIVE STREAM (SSE)
   ═══════════════════════════════════════════════════ */

function openLiveStream() {
  if (_stream) _stream.close();
  _stream = API.openStream({
    'position.updated': (p) => {
      // update keyword in cache
      for (const a of data.apps) {
        const k = a.keywords.find(x => x.apiId === p.keyword_id);
        if (k) { k.currentPos = p.position; }
      }
      // soft re-render if on relevant page; reset matrix cache so it reloads
      const page = (location.hash || '#dashboard').slice(1).split('/')[0];
      if (page === 'app') { _matrixState.appId = null; routeFromHash(); }
      else if (page === 'campaigns' || page === 'dashboard') routeFromHash();
    },
    'transaction.updated': async () => { await refreshBalanceAndTx(); },
    'transaction.created': async () => { await refreshBalanceAndTx(); },
    'install.scheduled': () => { /* refreshed on demand */ },
  });
}

async function refreshBalanceAndTx() {
  try {
    const [me, tx] = await Promise.all([API.me(), API.listTransactions()]);
    data.balance = me.balance;
    data.transactions = (tx.transactions || []).map(mapTx);
    refreshUserUI();
    const page = (location.hash || '#dashboard').slice(1).split('/')[0];
    if (page === 'history' || page === 'dashboard' || page === 'topup') routeFromHash();
  } catch {}
}

/* ═══════════════════════════════════════════════════
   ROUTING
   ═══════════════════════════════════════════════════ */

function goPage(page, params) {
  let hash = '#' + page;
  if (params) hash += '/' + params;
  if (location.hash === hash) routeFromHash();
  else location.hash = hash;
  closeSidebar();
}

async function routeFromHash() {
  if (!data.user) return;
  const hash = (location.hash || '#dashboard').slice(1);
  const [page, ...params] = hash.split('/');
  const pageContent = document.getElementById('pageContent');
  refreshUserUI();

  document.querySelectorAll('.sb-link[data-page]').forEach(l => {
    l.classList.toggle('active', l.dataset.page === page);
  });

  const titles = {
    dashboard: 'Дашборд',
    apps: 'Приложения',
    observations: 'Наблюдения за позициями',
    campaigns: 'Активные кампании',
    topup: 'Пополнить баланс',
    history: 'История операций',
    app: 'Приложение',
  };
  document.getElementById('pageTitle').textContent = titles[page] || 'Дашборд';

  // Render
  try {
    if (page === 'app') {
      const app = data.apps.find(a => a.id === params[0]);
      if (app) await ensureAppKeywords(app);
      const tab = params[1] || 'observations';
      pageContent.innerHTML = renderAppDetail(params[0], tab);
      // Lazy-load matrix when on observations tab
      if (tab === 'observations' && app && _matrixState.appId === params[0]) {
        if (_matrixState.data) paintMatrix();
        else loadMatrix();
      }
    } else {
      const renderers = {
        dashboard: renderDashboard,
        apps: renderApps,
        observations: renderObservations,
        campaigns: renderCampaigns,
        topup: renderTopup,
        history: renderHistory,
      };
      pageContent.innerHTML = (renderers[page] || renderDashboard)();
    }
  } catch (e) {
    console.error(e);
    pageContent.innerHTML = `<div class="page"><div class="card"><div class="card-body"><div class="empty"><div class="empty-title">Ошибка</div><div class="empty-text">${escapeHtml(e.message)}</div></div></div></div></div>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', routeFromHash);

/* ═══════════════════════════════════════════════════
   PAGES (mostly preserved from original)
   ═══════════════════════════════════════════════════ */

function renderDashboard() {
  const totalInstalls = data.apps.reduce((s, a) =>
    s + a.keywords.reduce((kk, k) => kk + (k.totalInstalled || 0), 0), 0);
  const activeApps = data.apps.filter(a => a.status !== 'paused').length;
  const totalKeywords = data.apps.reduce((s, a) => s + a.keywords.length, 0);
  const inTop10 = data.apps.reduce((s, a) =>
    s + a.keywords.filter(k => k.currentPos != null && k.currentPos <= 10).length, 0);
  const lastTopup = data.transactions
    .filter(t => t.type === 'topup' && t.status === 'done')
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const recentTxs = data.transactions.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);

  // Empty state for new users
  if (data.apps.length === 0) {
    return `
      <div class="page">
        <div class="page-header">
          <div>
            <div class="page-subtitle">/ ${formatDate(Date.now())}</div>
            <div class="page-title">Добро пожаловать, <span class="accent">${escapeHtml(data.user.name)}</span></div>
          </div>
        </div>

        <div class="hint">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          <div>
            <b>Как это работает.</b> Добавь приложение из&nbsp;App Store, укажи ключи которые хочешь продвинуть.
            Мы&nbsp;покажем <b>текущие позиции</b> по этим ключам и&nbsp;<b>историю за 30 дней</b>.
            Когда захочешь поднять позицию — запустишь кампанию установок (списания идут с&nbsp;баланса).
          </div>
        </div>

        <div class="qa-grid">
          <div class="qa-card" onclick="openAddApp()">
            <div class="qa-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></div>
            <div class="qa-title">1 · Добавь приложение</div>
            <div class="qa-desc">Вставь ссылку на App Store, перечисли ключи. Имя, иконка, рейтинг и текущие позиции подтянутся автоматически.</div>
            <div class="qa-arrow">+ Добавить →</div>
          </div>
          <div class="qa-card" onclick="goPage('observations')">
            <div class="qa-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><polyline points="7 14 11 10 15 13 21 7"/></svg></div>
            <div class="qa-title">2 · Наблюдай</div>
            <div class="qa-desc">На странице приложения — матрица позиций по дням со стрелками тренда. Никаких лишних кликов.</div>
            <div class="qa-arrow">Посмотреть пример →</div>
          </div>
          <div class="qa-card" onclick="goPage('topup')">
            <div class="qa-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div>
            <div class="qa-title">3 · Запусти кампанию</div>
            <div class="qa-desc">Пополни баланс и закажи установки на ключ — поднимем позицию выше. Цена от $0.13 за установку.</div>
            <div class="qa-arrow">Тарифы →</div>
          </div>
        </div>
      </div>`;
  }

  return `
    <div class="page">
      <div class="page-header">
        <div>
          <div class="page-subtitle">/ ${formatDate(Date.now())} · live</div>
          <div class="page-title">Привет, <span class="accent">${escapeHtml(data.user.name)}</span></div>
        </div>
        <div class="action-group">
          <button class="btn btn-ghost" onclick="openAddApp()">+ Приложение</button>
          <button class="btn btn-primary" onclick="goPage('topup')">Пополнить</button>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat-c">
          <div class="stat-c-lbl">Баланс</div>
          <div class="stat-c-val"><span class="accent">$${formatNum(data.balance)}</span></div>
          <div class="stat-c-sub">${lastTopup ? 'Последнее пополнение ' + formatDate(lastTopup.createdAt) : 'Пополнений ещё не было'}</div>
        </div>
        <div class="stat-c">
          <div class="stat-c-lbl">Приложений</div>
          <div class="stat-c-val">${data.apps.length}</div>
          <div class="stat-c-sub green">${activeApps} активных</div>
        </div>
        <div class="stat-c">
          <div class="stat-c-lbl">Ключей в работе</div>
          <div class="stat-c-val">${totalKeywords}</div>
          <div class="stat-c-sub green">${inTop10} в&nbsp;топ-10</div>
        </div>
        <div class="stat-c">
          <div class="stat-c-lbl">Установок куплено</div>
          <div class="stat-c-val">${formatNum(totalInstalls)}</div>
          <div class="stat-c-sub">за всё время</div>
        </div>
      </div>

      <div class="qa-grid">
        <div class="qa-card" onclick="goPage('observations')">
          <div class="qa-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><polyline points="7 14 11 10 15 13 21 7"/></svg></div>
          <div class="qa-title">Наблюдения</div>
          <div class="qa-desc">Текущие позиции всех ключей по всем приложениям. Где топ-10, где упали, где надо толкать.</div>
          <div class="qa-arrow">Смотреть позиции →</div>
        </div>
        <div class="qa-card" onclick="goPage('campaigns')">
          <div class="qa-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div>
          <div class="qa-title">Кампании</div>
          <div class="qa-desc">Активные пуши установок. Сколько крутится прямо сейчас, по каким ключам, на сколько хватит.</div>
          <div class="qa-arrow">К&nbsp;кампаниям →</div>
        </div>
        <div class="qa-card" onclick="openAddApp()">
          <div class="qa-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
          <div class="qa-title">+ Новое приложение</div>
          <div class="qa-desc">Подключи ещё один app: ссылка + ключи, остальное MAYA сделает сама за&nbsp;~5 секунд.</div>
          <div class="qa-arrow">Добавить →</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">Мои приложения <span class="badge">${data.apps.length}</span></div>
          <button class="btn btn-ghost btn-sm" onclick="goPage('apps')">Все →</button>
        </div>
        <div class="card-body dense">
          <div class="table-wrap"><table class="tbl"><thead><tr>
            <th>Приложение</th><th>Гео</th><th>Ключей</th><th>В&nbsp;топ-10</th><th>Установок</th><th></th>
          </tr></thead><tbody>${data.apps.slice(0, 5).map(a => {
            const inst = a.keywords.reduce((s, k) => s + (k.totalInstalled || 0), 0);
            const top10 = a.keywords.filter(k => k.currentPos != null && k.currentPos <= 10).length;
            return `<tr style="cursor:pointer" onclick="goPage('app', '${a.id}')">
              <td><div class="app-cell">
                ${a.iconUrl
                  ? `<img src="${escapeAttr(a.iconUrl)}" alt="" style="width:32px;height:32px;border-radius:7px;object-fit:cover;flex-shrink:0">`
                  : `<div class="app-icon-sm" style="--ico-a: ${a.colorA}; --ico-b: ${a.colorB};">${escapeHtml(a.name.slice(0,1).toUpperCase())}</div>`}
                <div class="app-cell-info">
                  <div class="app-cell-name">${escapeHtml(a.name)}</div>
                  <div class="app-cell-meta">${escapeHtml(a.category)}</div>
                </div>
              </div></td>
              <td class="mono">${escapeHtml(a.geo)}</td>
              <td class="num">${a.keywords.length}</td>
              <td class="num green">${top10}</td>
              <td class="num">${formatNum(inst)}</td>
              <td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();goPage('app', '${a.id}')">Открыть →</button></td>
            </tr>`;
          }).join('')}</tbody></table></div>
        </div>
      </div>

      ${recentTxs.length > 0 ? `
        <div class="card">
          <div class="card-head">
            <div class="card-title">Последние операции</div>
            <button class="btn btn-ghost btn-sm" onclick="goPage('history')">Вся история →</button>
          </div>
          <div class="card-body dense">
            <div class="table-wrap"><table class="tbl"><thead><tr>
              <th>Дата</th><th>Тип</th><th>Описание</th><th style="text-align:right">Сумма</th><th>Статус</th>
            </tr></thead><tbody>${recentTxs.map(t => txRow(t)).join('')}</tbody></table></div>
          </div>
        </div>` : ''}
    </div>`;
}

function txRow(t) {
  return `<tr>
    <td class="mono">${formatDate(t.createdAt)}</td>
    <td class="mono">${txTypeLabel(t.type)}</td>
    <td>${escapeHtml(t.description)}</td>
    <td class="num ${t.amount > 0 ? 'green' : t.amount < 0 ? 'red' : ''}" style="text-align:right">${
      t.amount === 0 ? '—' : (t.amount > 0 ? '+' : '') + '$' + formatNum(Math.abs(t.amount))}</td>
    <td>${statusPill(t.status)}</td>
  </tr>`;
}

function renderApps() {
  return `
    <div class="page">
      <div class="page-header">
        <div>
          <div class="page-subtitle">/ Apps · ${data.apps.length}</div>
          <div class="page-title">Мои <span class="accent">приложения</span></div>
        </div>
        <button class="btn btn-primary" onclick="openAddApp()">+ Добавить приложение</button>
      </div>
      ${data.apps.length === 0
        ? `<div class="card"><div class="card-body"><div class="empty">
            <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
            <div class="empty-title">Здесь будут ваши приложения</div>
            <div class="empty-text">Добавьте приложение, укажите ключи и&nbsp;гео — мы&nbsp;запустим кампанию.</div>
            <button class="btn btn-primary" onclick="openAddApp()">Добавить приложение</button>
          </div></div></div>`
        : `<div class="card"><div class="card-body dense"><div class="table-wrap"><table class="tbl">
            <thead><tr><th>Приложение</th><th>Гео</th><th>Ключей</th><th>Установок</th><th>Создано</th><th>Статус</th><th></th></tr></thead>
            <tbody>${data.apps.map(a => {
              const inst = a.keywords.reduce((s, k) => s + (k.totalInstalled || 0), 0);
              return `<tr>
                <td><div class="app-cell">
                  <div class="app-icon-sm" style="--ico-a: ${a.colorA}; --ico-b: ${a.colorB};">${escapeHtml(a.name.slice(0,1).toUpperCase())}</div>
                  <div class="app-cell-info">
                    <div class="app-cell-name">${escapeHtml(a.name)}</div>
                    <div class="app-cell-meta">${escapeHtml(a.category)}</div>
                  </div>
                </div></td>
                <td class="mono">${escapeHtml(a.geo)}</td>
                <td class="num">${a.keywords.length}</td>
                <td class="num green">${formatNum(inst)}</td>
                <td class="mono">${formatDate(a.createdAt)}</td>
                <td>${statusPill(a.status)}</td>
                <td><div class="action-group">
                  <button class="btn btn-ghost btn-sm" onclick="goPage('app', '${a.id}')">Открыть →</button>
                  <button class="btn btn-danger btn-sm" onclick="deleteApp('${a.id}')" title="Удалить">×</button>
                </div></td>
              </tr>`;
            }).join('')}</tbody></table></div></div></div>`}
    </div>`;
}

/**
 * НАБЛЮДЕНИЯ — все ключи всех приложений с текущими позициями.
 * Это «пассивный мониторинг»: смотришь как меняются ранги, ничего не платишь сверху.
 */
function renderObservations() {
  const rows = [];
  data.apps.forEach(a => a.keywords.forEach(k => rows.push({ app: a, kw: k })));

  // mini-stats
  const inTop10  = rows.filter(r => r.kw.currentPos != null && r.kw.currentPos <= 10).length;
  const inTop30  = rows.filter(r => r.kw.currentPos != null && r.kw.currentPos > 10 && r.kw.currentPos <= 30).length;
  const out      = rows.filter(r => r.kw.currentPos == null || r.kw.currentPos > 100).length;

  return `
    <div class="page">
      <div class="page-header">
        <div>
          <div class="page-subtitle">/ Мониторинг ранков · ${rows.length} запросов</div>
          <div class="page-title">Наблюдения <span class="accent">за позициями</span></div>
        </div>
        <button class="btn btn-ghost" onclick="goPage('apps')">К приложениям</button>
      </div>

      ${rows.length === 0 ? renderObservationsEmpty() : `
        <div class="stat-grid">
          <div class="stat-c"><div class="stat-c-lbl">Всего ключей</div><div class="stat-c-val">${rows.length}</div><div class="stat-c-sub">по ${data.apps.length} приложениям</div></div>
          <div class="stat-c"><div class="stat-c-lbl">В топ-10</div><div class="stat-c-val accent">${inTop10}</div><div class="stat-c-sub green">${rows.length ? Math.round(inTop10/rows.length*100) : 0}%</div></div>
          <div class="stat-c"><div class="stat-c-lbl">11–30</div><div class="stat-c-val">${inTop30}</div><div class="stat-c-sub">средний топ</div></div>
          <div class="stat-c"><div class="stat-c-lbl">Не в топ-100</div><div class="stat-c-val">${out}</div><div class="stat-c-sub">требуют пуша</div></div>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">Все ключи</div>
            <div style="font-family:'JetBrains Mono', monospace; font-size:11px; color:var(--ink-3); letter-spacing:0.08em;">
              кликни строку чтобы открыть приложение
            </div>
          </div>
          <div class="card-body dense">
            <div class="table-wrap"><table class="tbl">
              <thead><tr>
                <th>Приложение</th><th>Запрос</th><th>Гео</th>
                <th>Текущая</th><th>Цель</th><th>Статус</th>
              </tr></thead>
              <tbody>${rows.map(({app, kw}) => `
                <tr style="cursor:pointer" onclick="goPage('app', '${app.id}/observations')">
                  <td><div class="app-cell">
                    ${app.iconUrl
                      ? `<img src="${escapeAttr(app.iconUrl)}" alt="" style="width:32px;height:32px;border-radius:7px;object-fit:cover;flex-shrink:0">`
                      : `<div class="app-icon-sm" style="--ico-a: ${app.colorA}; --ico-b: ${app.colorB};">${escapeHtml(app.name.slice(0,1).toUpperCase())}</div>`}
                    <div class="app-cell-info">
                      <div class="app-cell-name">${escapeHtml(app.name)}</div>
                      <div class="app-cell-meta">${escapeHtml(app.category)}</div>
                    </div>
                  </div></td>
                  <td><b style="color:var(--ink)">${escapeHtml(kw.name)}</b></td>
                  <td class="mono">${escapeHtml(app.geo)}</td>
                  <td class="num ${posTextClass(kw.currentPos)}">${kw.currentPos != null ? '#' + kw.currentPos : '—'}</td>
                  <td class="num green">#${kw.targetPos || '—'}</td>
                  <td>${posStatusPill(kw.currentPos, kw.targetPos)}</td>
                </tr>`).join('')}</tbody>
            </table></div>
          </div>
        </div>
      `}
    </div>`;
}

function renderObservationsEmpty() {
  return `<div class="card"><div class="card-body"><div class="empty">
    <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v18h18"/><polyline points="7 14 11 10 15 13 21 7"/></svg>
    <div class="empty-title">Нет данных для мониторинга</div>
    <div class="empty-text">
      Здесь появятся <b>текущие позиции всех ключей</b> по всем приложениям. Начни с&nbsp;добавления приложения — мы&nbsp;сразу подтянем ранги из&nbsp;App Store.
    </div>
    <button class="btn btn-primary" onclick="openAddApp()">+ Добавить приложение</button>
  </div></div></div>`;
}

function posTextClass(pos) {
  if (pos == null) return '';
  if (pos <= 10) return 'green';
  if (pos > 100) return 'red';
  return '';
}

function posStatusPill(cur, target) {
  if (cur == null) return `<span class="status-pill">нет данных</span>`;
  if (cur <= (target || 10)) return `<span class="status-pill active">в цели</span>`;
  if (cur <= 30) return `<span class="status-pill">близко</span>`;
  if (cur <= 100) return `<span class="status-pill" style="color:var(--ochre);border-color:var(--ochre)">далеко</span>`;
  return `<span class="status-pill paused">вне топа</span>`;
}

/**
 * КАМПАНИИ — активные пуши установок.
 * Кампания = ключ с заплпнированными installs, по которому реально крутится трафик.
 */
function renderCampaigns() {
  // Активная кампания = ключ у которого есть установленные installs за последние 14 дней
  const rows = [];
  data.apps.forEach(a => a.keywords.forEach(k => {
    const installs = k.totalInstalled || 0;
    if (installs > 0 || k.dailyCap > 0) rows.push({ app: a, kw: k, installs });
  }));

  return `
    <div class="page">
      <div class="page-header">
        <div>
          <div class="page-subtitle">/ Активные пуши установок · ${rows.length}</div>
          <div class="page-title">Мои <span class="accent">кампании</span></div>
        </div>
        <button class="btn btn-primary" onclick="goPage('apps')">+ Запустить кампанию</button>
      </div>

      ${rows.length === 0 ? `
        <div class="card"><div class="card-body"><div class="empty">
          <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          <div class="empty-title">Кампании пока не запущены</div>
          <div class="empty-text">
            Кампания — это <b>оплачиваемое продвижение</b> ключевого слова через установки.
            Чтобы запустить: открой приложение → в&nbsp;матрице кликни на&nbsp;ключ → задай объём установок на&nbsp;день.
          </div>
          <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
            ${data.apps.length === 0
              ? `<button class="btn btn-primary" onclick="openAddApp()">+ Добавить первое приложение</button>`
              : `<button class="btn btn-primary" onclick="goPage('apps')">К приложениям</button>
                 <button class="btn btn-ghost" onclick="goPage('observations')">Сначала посмотреть позиции →</button>`}
          </div>
        </div></div></div>`
       : `
        <div class="card">
          <div class="card-body dense">
            <div class="table-wrap"><table class="tbl">
              <thead><tr>
                <th>Приложение</th><th>Ключ</th><th>Тариф</th>
                <th>Тек. позиция</th><th>Цель</th>
                <th>Установлено</th><th>Дневной кап</th>
                <th>Статус</th><th></th>
              </tr></thead>
              <tbody>${rows.map(({app, kw, installs}) => `
                <tr>
                  <td><div class="app-cell">
                    ${app.iconUrl
                      ? `<img src="${escapeAttr(app.iconUrl)}" alt="" style="width:32px;height:32px;border-radius:7px;object-fit:cover;flex-shrink:0">`
                      : `<div class="app-icon-sm" style="--ico-a: ${app.colorA}; --ico-b: ${app.colorB};">${escapeHtml(app.name.slice(0,1).toUpperCase())}</div>`}
                    <div class="app-cell-info">
                      <div class="app-cell-name">${escapeHtml(app.name)}</div>
                      <div class="app-cell-meta">${escapeHtml(app.geo)}</div>
                    </div>
                  </div></td>
                  <td><b style="color:var(--ink)">${escapeHtml(kw.name)}</b></td>
                  <td class="mono" style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--ink-2);">${escapeHtml(kw.planTier || 'standard')}</td>
                  <td class="num">${kw.currentPos != null ? '#' + kw.currentPos : '—'}</td>
                  <td class="num green">#${kw.targetPos || '—'}</td>
                  <td class="num green">${formatNum(installs)}</td>
                  <td class="num">${formatNum(kw.dailyCap || 0)}/день</td>
                  <td>${statusPill(kw.status)}</td>
                  <td><button class="btn btn-ghost btn-sm" onclick="goPage('app', '${app.id}/campaigns')">Управлять →</button></td>
                </tr>`).join('')}</tbody>
            </table></div>
          </div>
        </div>`}
    </div>`;
}

/* Тарифы — единая правда. Имя совпадает с keywords.plan на бэке. */
const PRICING_TIERS = [
  {
    id: 'standard', name: 'Стандарт',  pricePerInstall: 0.30,
    minDeposit: 1500,  installs: 5000,
    desc: 'Базовый темп: ~50–200 установок/день на ключ. Подойдёт для нишевых ключей и тестов.',
    badge: null,
  },
  {
    id: 'volume',   name: 'Объём',     pricePerInstall: 0.25,
    minDeposit: 5000,  installs: 20000,
    desc: 'Максимум объёма за минимум денег. Под запуски в США и крупные гео.',
    badge: 'популярный',
  },
  {
    id: 'scale',    name: 'Масштаб',   pricePerInstall: 0.13,
    minDeposit: 15000, installs: 115000,
    desc: 'Когда нужна по-настоящему большая воронка установок. Дедикейтед менеджер.',
    badge: null,
  },
  {
    id: 'enterprise', name: 'Enterprise', pricePerInstall: null,
    minDeposit: 50000, installs: null,
    desc: 'Кастомный объём, прайс по запросу, SLA на скорость отгрузки. Контракт.',
    badge: 'по запросу',
  },
];

function tierFromAmount(amount) {
  let pick = PRICING_TIERS[0];
  for (const t of PRICING_TIERS) if (amount >= t.minDeposit) pick = t;
  return pick;
}

function renderTopup() {
  const presets = PRICING_TIERS.map(t => t.minDeposit);
  const initialAmount = presets[1]; // start at "Объём"

  return `
    <div class="page">
      <div class="page-header">
        <div>
          <div class="page-subtitle">/ Пополнение · через менеджера</div>
          <div class="page-title">Пополнить <span class="accent">баланс</span></div>
        </div>
      </div>

      <div class="hint">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        <div>
          <b>Как это работает.</b> Чем больше депозит — тем дешевле каждая установка.
          После заявки менеджер свяжется в&nbsp;Telegram <a href="https://t.me/ojakos" style="color:var(--jade)">@ojakos</a>,
          вы оплачиваете удобным способом — баланс зачисляется сразу. Деньги невозвратные, но&nbsp;полностью откручиваются в&nbsp;установки.
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">Тарифы</div></div>
        <div class="card-body" style="padding: 0;">
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0;">
            ${PRICING_TIERS.map((t, i) => `
              <div class="tier-card" id="tier-${t.id}" onclick="selectTier('${t.id}')" style="
                padding: 22px 20px;
                ${i < PRICING_TIERS.length - 1 ? 'border-right: 1px solid var(--line);' : ''}
                cursor: pointer;
                position: relative;
                transition: background 0.15s;
              ">
                ${t.badge ? `<div style="
                  position: absolute; top: 14px; right: 14px;
                  font-family: 'JetBrains Mono', monospace; font-size: 9px;
                  letter-spacing: 0.1em; text-transform: uppercase;
                  padding: 2px 8px; background: var(--jade); color: var(--bg); font-weight: 700;
                ">${t.badge}</div>` : ''}
                <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--ink-3); letter-spacing: 0.12em; text-transform: uppercase;">${t.name}</div>
                <div style="font-size: 28px; font-weight: 800; margin-top: 8px; color: var(--ink);">
                  ${t.pricePerInstall != null ? '$' + t.pricePerInstall.toFixed(2) : '—'}
                  <span style="font-size: 12px; font-weight: 400; color: var(--ink-3);"> / установка</span>
                </div>
                <div style="margin-top: 10px; font-size: 13px; color: var(--ink-2);">
                  Депозит от&nbsp;<b style="color: var(--jade);">$${formatNum(t.minDeposit)}</b>
                </div>
                ${t.installs ? `<div style="font-size: 12px; color: var(--ink-3); margin-top: 4px; font-family: 'JetBrains Mono', monospace;">
                  ≈ ${formatNum(t.installs)} установок
                </div>` : ''}
                <div style="margin-top: 14px; font-size: 12px; color: var(--ink-3); line-height: 1.5;">${t.desc}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top: 24px;">
        <div class="card-head">
          <div class="card-title">Сумма пополнения</div>
          <div id="tierIndicator" style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--ink-3); letter-spacing: 0.1em; text-transform: uppercase;"></div>
        </div>
        <div class="card-body">
          <div class="form-row">
            <label class="form-label">Быстрый выбор</label>
            <div class="topup-presets" id="topupPresets">
              ${presets.map((p, i) => `
                <div class="topup-preset ${p === initialAmount ? 'active' : ''}" onclick="selectTopupPreset(this, ${p})">
                  <div class="topup-preset-amount">$${formatNum(p)}</div>
                  <div class="topup-preset-rate">${PRICING_TIERS[i].name}</div>
                </div>`).join('')}
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">Сумма депозита, USD</label>
            <input type="number" class="form-input" id="topupCustom"
              min="1500" step="100" value="${initialAmount}"
              oninput="onTopupAmountChange()" style="font-family: 'JetBrains Mono', monospace; font-size: 16px;">
            <div class="form-help" id="topupCalc"></div>
          </div>
          <div class="form-row">
            <label class="form-label">Комментарий менеджеру (необязательно)</label>
            <textarea class="form-textarea" id="topupComment" rows="3" placeholder="Например: запуск Telegram в США по 5 ключам, нужно подключить тариф «Объём»"></textarea>
          </div>
          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top: 8px;">
            <button class="btn btn-primary" onclick="submitTopup()">Создать заявку</button>
            <a href="https://t.me/ojakos" class="btn btn-ghost" target="_blank">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
              Telegram @ojakos
            </a>
          </div>
        </div>
      </div>

      <script>onTopupAmountChange();<\/script>
    </div>`;
}

function onTopupAmountChange() {
  const inp = document.getElementById('topupCustom');
  if (!inp) return;
  const amount = parseInt(inp.value, 10) || 0;
  const tier = tierFromAmount(amount);
  const indEl = document.getElementById('tierIndicator');
  const calcEl = document.getElementById('topupCalc');

  // Highlight active tier card
  document.querySelectorAll('.tier-card').forEach(el => {
    el.style.background = '';
    el.style.outline = '';
  });
  const activeCard = document.getElementById('tier-' + tier.id);
  if (activeCard) {
    activeCard.style.background = 'var(--jade-soft)';
    activeCard.style.outline = '1px solid var(--jade)';
  }
  if (indEl) indEl.textContent = '— тариф: ' + tier.name;
  if (calcEl) {
    if (amount < 1500) {
      calcEl.innerHTML = '<span style="color: var(--cinnabar);">Минимум $1500</span>';
    } else if (tier.pricePerInstall != null) {
      const installs = Math.floor(amount / tier.pricePerInstall);
      calcEl.innerHTML = `На&nbsp;${formatNum(amount)}&nbsp;USD получите примерно <b style="color:var(--jade)">${formatNum(installs)} установок</b> по&nbsp;тарифу «${tier.name}» ($${tier.pricePerInstall.toFixed(2)} за&nbsp;установку).`;
    } else {
      calcEl.innerHTML = 'Цена за&nbsp;установку — индивидуально, обсуждается с&nbsp;менеджером.';
    }
  }
}

function selectTier(id) {
  const tier = PRICING_TIERS.find(t => t.id === id);
  if (!tier) return;
  const inp = document.getElementById('topupCustom');
  if (inp) {
    inp.value = tier.minDeposit;
    onTopupAmountChange();
  }
  // sync presets row
  document.querySelectorAll('.topup-preset').forEach(p => p.classList.remove('active'));
  const idx = PRICING_TIERS.indexOf(tier);
  const presetEls = document.querySelectorAll('#topupPresets .topup-preset');
  if (presetEls[idx]) presetEls[idx].classList.add('active');
}

function renderHistory() {
  const txs = data.transactions.slice().sort((a, b) => b.createdAt - a.createdAt);
  return `
    <div class="page">
      <div class="page-header">
        <div>
          <div class="page-subtitle">/ Transactions · ${txs.length}</div>
          <div class="page-title">История <span class="accent">операций</span></div>
        </div>
      </div>
      <div class="card"><div class="card-body dense">
        ${txs.length === 0
          ? `<div class="empty"><div class="empty-title">Операций пока нет</div><div class="empty-text">Здесь появятся пополнения и&nbsp;списания.</div></div>`
          : `<div class="table-wrap"><table class="tbl"><thead><tr>
              <th>Дата</th><th>Тип</th><th>Описание</th><th style="text-align:right">Сумма</th><th>Статус</th>
            </tr></thead><tbody>${txs.map(t => txRow(t)).join('')}</tbody></table></div>`}
      </div></div>
    </div>`;
}

/* ─────────────────────────────────────────────────────
   APP DETAIL — AppBooster-style position matrix
   ───────────────────────────────────────────────────── */

let _matrixState = { appId: null, days: 30, traffic: 'all', data: null, loading: false };

function renderAppDetail(appId, tab = 'observations') {
  const app = data.apps.find(a => a.id === appId);
  if (!app) {
    return `<div class="page"><div class="card"><div class="card-body"><div class="empty">
      <div class="empty-title">Приложение не найдено</div>
      <button class="btn btn-primary" onclick="goPage('apps')">К списку</button>
    </div></div></div></div>`;
  }

  // Lazy-load matrix on first paint or when app/tab changes
  if (_matrixState.appId !== appId) {
    _matrixState = { appId, days: 30, traffic: 'all', data: null, loading: false };
    if (tab === 'observations') loadMatrix();
  }

  const ratingHtml = app.rating != null ? `
    <span class="app-rating" title="Рейтинг в App Store">
      <svg viewBox="0 0 24 24"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
      ${app.rating.toFixed(1)}
      ${app.ratingCount ? `<span class="app-rating-count">(${formatNum(app.ratingCount)})</span>` : ''}
    </span>` : '';

  const iconHtml = app.iconUrl
    ? `<img src="${escapeAttr(app.iconUrl)}" alt="" style="width:64px;height:64px;border-radius:14px;object-fit:cover;flex-shrink:0">`
    : `<div class="detail-head-icon" style="background: linear-gradient(135deg, ${app.colorA}, ${app.colorB})">${escapeHtml(app.name.slice(0,1).toUpperCase())}</div>`;

  const activeCampaigns = app.keywords.filter(k => (k.totalInstalled || 0) > 0).length;
  const inTop10 = app.keywords.filter(k => k.currentPos != null && k.currentPos <= 10).length;

  // Tab content
  let tabContent = '';
  if (tab === 'overview') {
    tabContent = renderAppOverview(app);
  } else if (tab === 'campaigns') {
    tabContent = renderAppCampaigns(app);
  } else { // observations (default)
    tabContent = renderAppObservations(app);
  }

  return `
    <div class="page">
      <a class="back-link" onclick="goPage('apps')">← К приложениям</a>

      <div class="detail-head">
        ${iconHtml}
        <div class="detail-head-info">
          <div class="detail-head-name">${escapeHtml(app.name)}</div>
          ${app.subtitle ? `<div style="color:var(--ink-2); font-size:13px; margin-top:2px;">${escapeHtml(app.subtitle)}</div>` : ''}
          <div class="detail-head-meta" style="margin-top:8px;">
            ${ratingHtml}
            ${app.developer ? `<span>· <b>${escapeHtml(app.developer)}</b></span>` : ''}
            <span>· ${escapeHtml(app.category)}</span>
            <span>· ${escapeHtml(app.geo)}</span>
            <span>· ${statusPill(app.status)}</span>
          </div>
        </div>
        <div class="action-group" style="margin-left:auto">
          <button class="btn btn-ghost btn-sm" onclick="syncAppNow('${app.id}')" title="Обновить позиции из AppTweak">↻ Обновить</button>
          ${app.status === 'paused'
            ? `<button class="btn btn-ghost btn-sm" onclick="toggleAppStatus('${app.id}')">▶ Запустить</button>`
            : `<button class="btn btn-ghost btn-sm" onclick="toggleAppStatus('${app.id}')">⏸ Пауза</button>`}
          <button class="btn btn-danger btn-sm" onclick="deleteApp('${app.id}')">Удалить</button>
        </div>
      </div>

      <div class="tabs">
        <button class="tab ${tab === 'overview' ? 'active' : ''}" onclick="goPage('app','${app.id}/overview')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          Обзор
        </button>
        <button class="tab ${tab === 'observations' ? 'active' : ''}" onclick="goPage('app','${app.id}/observations')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><polyline points="7 14 11 10 15 13 21 7"/></svg>
          Наблюдения
          ${app.keywords.length ? `<span class="tab-badge">${app.keywords.length}</span>` : ''}
        </button>
        <button class="tab ${tab === 'campaigns' ? 'active' : ''}" onclick="goPage('app','${app.id}/campaigns')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          Кампании
          ${activeCampaigns ? `<span class="tab-badge">${activeCampaigns}</span>` : ''}
        </button>
      </div>

      ${tabContent}
    </div>`;
}

function renderAppOverview(app) {
  const inTop10  = app.keywords.filter(k => k.currentPos != null && k.currentPos <= 10).length;
  const inTop30  = app.keywords.filter(k => k.currentPos != null && k.currentPos > 10 && k.currentPos <= 30).length;
  const out      = app.keywords.filter(k => k.currentPos == null || k.currentPos > 100).length;
  const totalInstalled = app.keywords.reduce((s, k) => s + (k.totalInstalled || 0), 0);

  return `
    <div class="stat-grid">
      <div class="stat-c"><div class="stat-c-lbl">Ключей в работе</div><div class="stat-c-val">${app.keywords.length}</div><div class="stat-c-sub">всего отслеживаем</div></div>
      <div class="stat-c"><div class="stat-c-lbl">В топ-10</div><div class="stat-c-val accent">${inTop10}</div><div class="stat-c-sub green">${app.keywords.length ? Math.round(inTop10/app.keywords.length*100) : 0}%</div></div>
      <div class="stat-c"><div class="stat-c-lbl">11–30</div><div class="stat-c-val">${inTop30}</div><div class="stat-c-sub">средний топ</div></div>
      <div class="stat-c"><div class="stat-c-lbl">Установок куплено</div><div class="stat-c-val">${formatNum(totalInstalled)}</div><div class="stat-c-sub">за всё время</div></div>
    </div>

    ${app.url ? `<div class="hint">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      <div>App Store: <a href="${escapeAttr(app.url)}" target="_blank" style="color:var(--jade); word-break:break-all;">${escapeHtml(app.url)}</a></div>
    </div>` : ''}

    <div class="card">
      <div class="card-head">
        <div class="card-title">Что дальше?</div>
      </div>
      <div class="card-body">
        <div class="qa-grid" style="margin-bottom:0;">
          <div class="qa-card" onclick="goPage('app', '${app.id}/observations')">
            <div class="qa-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><polyline points="7 14 11 10 15 13 21 7"/></svg></div>
            <div class="qa-title">Посмотреть позиции</div>
            <div class="qa-desc">Матрица за&nbsp;30 дней — где растём, где падаем, по&nbsp;каким ключам стоит толкать.</div>
            <div class="qa-arrow">К&nbsp;матрице →</div>
          </div>
          <div class="qa-card" onclick="openAddKw('${app.id}')">
            <div class="qa-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
            <div class="qa-title">Добавить ключ</div>
            <div class="qa-desc">Подключи ещё один поисковый запрос — позиция и&nbsp;история подтянутся за&nbsp;5&nbsp;секунд.</div>
            <div class="qa-arrow">+ Ключ →</div>
          </div>
          <div class="qa-card" onclick="goPage('app', '${app.id}/campaigns')">
            <div class="qa-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div>
            <div class="qa-title">Запустить кампанию</div>
            <div class="qa-desc">Заплатить за&nbsp;установки и&nbsp;поднять позицию по&nbsp;нужному ключу. От&nbsp;$0.13&nbsp;за&nbsp;установку.</div>
            <div class="qa-arrow">Запустить →</div>
          </div>
        </div>
      </div>
    </div>`;
}

function renderAppObservations(app) {
  return `
    <div class="card" style="padding:0;">
      <div class="matrix-toolbar">
        <div class="seg" role="tablist" aria-label="Период">
          <button class="${_matrixState.days === 7  ? 'active' : ''}" onclick="setMatrixDays(7)">7 дней</button>
          <button class="${_matrixState.days === 30 ? 'active' : ''}" onclick="setMatrixDays(30)">30 дней</button>
          <button class="${_matrixState.days === 60 ? 'active' : ''}" onclick="setMatrixDays(60)">60 дней</button>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openAddKw('${app.id}')">+ Добавить ключ</button>
        <span class="stat">Запросов: <b>${app.keywords.length}</b></span>
      </div>
      <div class="matrix-legend">
        <span>Цвет ячейки:</span>
        <span class="lg-chip"><span class="lg-sw top10"></span>топ-10</span>
        <span class="lg-chip"><span class="lg-sw top30"></span>11–30</span>
        <span class="lg-chip"><span class="lg-sw top100"></span>31–100</span>
        <span class="lg-chip"><span class="lg-sw deep"></span>101+</span>
        <span class="lg-chip"><span class="lg-sw none"></span>нет данных</span>
      </div>
      <div id="matrixBody">
        ${app.keywords.length === 0
          ? `<div class="empty">
              <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v18h18"/><polyline points="7 14 11 10 15 13 21 7"/></svg>
              <div class="empty-title">Нет отслеживаемых ключей</div>
              <div class="empty-text">Добавь поисковые запросы — мы&nbsp;сразу подтянем текущие позиции и&nbsp;историю за&nbsp;30&nbsp;дней из&nbsp;App Store.</div>
              <button class="btn btn-primary" onclick="openAddKw('${app.id}')">+ Добавить первый ключ</button>
            </div>`
          : `<div class="empty" style="padding:32px;color:var(--ink-3);">Загружаем матрицу позиций…</div>`}
      </div>
    </div>`;
}

function renderAppCampaigns(app) {
  const activeKw = app.keywords.filter(k => (k.totalInstalled || 0) > 0);
  const totalInstalled = app.keywords.reduce((s, k) => s + (k.totalInstalled || 0), 0);

  if (app.keywords.length === 0) {
    return `<div class="card"><div class="card-body"><div class="empty">
      <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
      <div class="empty-title">Сначала нужны ключи</div>
      <div class="empty-text">Чтобы запустить кампанию — добавь хотя&nbsp;бы один поисковый запрос. После этого сможешь заказать установки на&nbsp;него.</div>
      <button class="btn btn-primary" onclick="openAddKw('${app.id}')">+ Добавить ключ</button>
    </div></div></div>`;
  }

  return `
    <div class="hint">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <div>
        <b>Что это?</b> Кампания — это <b>заказ установок</b> по&nbsp;конкретному ключу для поднятия позиции в&nbsp;App Store.
        Цена зависит от&nbsp;твоего тарифа (см. «Пополнить»).
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title">
          ${activeKw.length > 0
            ? `Активные кампании <span class="badge">${activeKw.length}</span>`
            : 'Запустить кампанию'}
        </div>
        <button class="btn btn-primary btn-sm" onclick="openAddKw('${app.id}')">+ Добавить ключ</button>
      </div>
      <div class="card-body dense">
        <div class="table-wrap"><table class="tbl">
          <thead><tr>
            <th>Ключ</th>
            <th>Тек. позиция</th>
            <th>Цель</th>
            <th>Установлено</th>
            <th>Тариф</th>
            <th>Действие</th>
          </tr></thead>
          <tbody>${app.keywords.map(k => `
            <tr>
              <td><b style="color:var(--ink)">${escapeHtml(k.name)}</b></td>
              <td class="num ${posTextClass(k.currentPos)}">${k.currentPos != null ? '#' + k.currentPos : '—'}</td>
              <td class="num green">#${k.targetPos || '—'}</td>
              <td class="num ${(k.totalInstalled||0) > 0 ? 'green' : ''}">${formatNum(k.totalInstalled || 0)}</td>
              <td class="mono" style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--ink-2);">${escapeHtml(k.planTier || 'standard')}</td>
              <td>
                ${(k.totalInstalled||0) > 0
                  ? `<button class="btn btn-ghost btn-sm" onclick="openInstallsForKw('${k.id}')">Управлять →</button>`
                  : `<button class="btn btn-primary btn-sm" onclick="openInstallsForKw('${k.id}')">▶ Запустить</button>`}
              </td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>
    </div>

    ${totalInstalled > 0 ? `
      <div class="stat-grid">
        <div class="stat-c">
          <div class="stat-c-lbl">Установлено всего</div>
          <div class="stat-c-val accent">${formatNum(totalInstalled)}</div>
          <div class="stat-c-sub">по&nbsp;${activeKw.length} ${activeKw.length === 1 ? 'ключу' : 'ключам'}</div>
        </div>
        <div class="stat-c">
          <div class="stat-c-lbl">Баланс</div>
          <div class="stat-c-val">$${formatNum(data.balance)}</div>
          <div class="stat-c-sub">${data.balance > 0 ? 'хватит на&nbsp;запуски' : 'нужно пополнить'}</div>
        </div>
      </div>` : ''}`;
}

async function loadMatrix() {
  if (_matrixState.loading) return;
  const app = data.apps.find(a => a.id === _matrixState.appId);
  if (!app) return;
  _matrixState.loading = true;
  try {
    const r = await API.matrix(app.apiId, _matrixState.days);
    _matrixState.data = r;
    paintMatrix();
  } catch (e) {
    const el = document.getElementById('matrixBody');
    if (el) el.innerHTML = `<div class="empty"><div class="empty-text" style="color:var(--cinnabar)">Ошибка: ${escapeHtml(e.message)}</div></div>`;
  } finally {
    _matrixState.loading = false;
  }
}

function setMatrixDays(d) {
  _matrixState.days = d;
  // re-paint toolbar + reload
  document.querySelectorAll('.matrix-toolbar .seg button').forEach(b => b.classList.remove('active'));
  const btn = [...document.querySelectorAll('.matrix-toolbar .seg button')]
    .find(b => b.textContent.startsWith(String(d)));
  if (btn) btn.classList.add('active');
  document.getElementById('matrixBody').innerHTML = '<div class="empty" style="padding:32px;color:var(--ink-3);">Загружаем матрицу позиций…</div>';
  loadMatrix();
}

function paintMatrix() {
  const el = document.getElementById('matrixBody');
  if (!el || !_matrixState.data) return;
  const { dates, keywords } = _matrixState.data;
  if (!keywords.length) {
    el.innerHTML = `<div class="empty" style="padding:48px 24px;"><div class="empty-title">Нет ключевых слов</div></div>`;
    return;
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  // header date row
  const head = `
    <tr>
      <th class="col-key">Ключ / запрос</th>
      <th class="col-meta">Сейчас</th>
      <th class="col-meta">Цель</th>
      <th class="col-meta">Лучший</th>
      <th class="col-meta">Тренд</th>
      ${dates.map(d => {
        const dt = new Date(d + 'T00:00:00Z');
        return `<th class="col-day ${d === todayStr ? 'today' : ''}">
          <span class="dom">${String(dt.getUTCDate()).padStart(2,'0')}</span>
          <span class="mon">${dt.toLocaleDateString('ru-RU', { month: 'short' })}</span>
        </th>`;
      }).join('')}
    </tr>`;

  const rows = keywords.map(k => {
    const cells = dates.map((d, i) => {
      const v = k.byDate[d];
      const cls = posClass(v);
      const prev = i > 0 ? k.byDate[dates[i-1]] : null;
      const delta = (v != null && prev != null) ? (prev - v) : null; // positive = improved
      const arrow = delta == null || delta === 0
        ? ''
        : `<span class="delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}</span>`;
      const today = d === todayStr ? ' today' : '';
      return `<td class="pos-cell ${cls}${today}" title="${d}${v != null ? ' · #' + v : ' · нет данных'}">${
        v != null ? '#' + v : '—'
      }${arrow}</td>`;
    }).join('');

    const trendPill = renderTrendPill(k.trend);
    return `<tr onclick="openInstallsForKw('${k.id}')" style="cursor:pointer">
      <td class="col-key">
        ${escapeHtml(k.term)}
        <span class="kw-sub">${k.status === 'active' ? 'трекается' : escapeHtml(k.status)}</span>
      </td>
      <td class="col-meta-cell">${k.current_pos != null ? '#' + k.current_pos : '—'}</td>
      <td class="col-meta-cell target">#${k.target_pos}</td>
      <td class="col-meta-cell">${k.best != null ? '#' + k.best : '—'}</td>
      <td class="col-trend">${trendPill}</td>
      ${cells}
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix-tbl">
        <thead>${head}</thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function posClass(pos) {
  if (pos == null) return 'none';
  if (pos <= 10) return 'top10';
  if (pos <= 30) return 'top30';
  if (pos <= 100) return 'top100';
  return 'deep';
}

function renderTrendPill(trend) {
  if (trend == null) return `<span class="trend-pill flat">—</span>`;
  // trend = last - first; negative = rank improved (smaller rank is better)
  if (trend === 0) return `<span class="trend-pill flat">= 0</span>`;
  if (trend < 0)   return `<span class="trend-pill up">↑ ${Math.abs(trend)}</span>`;
  return `<span class="trend-pill down">↓ ${trend}</span>`;
}

async function syncAppNow(appId) {
  const app = data.apps.find(a => a.id === appId);
  if (!app) return;
  toast('Обновляем позиции из AppTweak…');
  try {
    const r = await API.syncApp(app.apiId);
    // refresh keyword cache
    const lr = await API.listByApp(app.apiId);
    app.keywords = (lr.keywords || []).map(mapKeyword);
    Object.assign(app, mapApp(r.app, data.apps.indexOf(app)));
    toast(`✓ Обновлено: ${r.keywords_updated} ключей`);
    _matrixState.appId = null; // force reload
    routeFromHash();
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
}

function openInstallsForKw(kwId) {
  // Placeholder for future installs scheduler modal
  toast('Планировщик установок — в разработке. Используйте matrix для мониторинга.');
}

function renderAsoTable(app, days) {
  const totalInstalled = app.keywords.reduce((s, k) => s + (k.totalInstalled || 0), 0);
  const todayInstalled = app.keywords.reduce((s, k) => s + getInstallsForDay(k, todayKey()), 0);
  const totalPlan = app.keywords.reduce((s, k) => s + (k.plan || 0), 0);
  const remaining = Math.max(0, totalPlan - totalInstalled);
  const dayLabels = getDayLabels(days);

  let body = '';
  let dayTotals = new Array(days).fill(0);
  let kwTotals = app.keywords.map(() => 0);
  for (let d = 0; d < days; d++) {
    const dKey = dayLabels[d].key;
    let row = `<tr><td class="day-num">${dayLabels[d].label}</td>`;
    app.keywords.forEach((k, ki) => {
      const v = getInstallsForDay(k, dKey);
      dayTotals[d] += v; kwTotals[ki] += v;
      const cls = v === 0 ? 'cell empty' : (v >= 200 ? 'cell full' : 'cell has');
      row += `<td class="${cls}" data-app="${app.id}" data-kw="${k.id}" data-day="${dKey}" onclick="editAsoCell(this)">${v || ''}</td>`;
    });
    row += `<td class="total">${dayTotals[d]}</td></tr>`;
    body += row;
  }
  return `
    <div class="aso-info">
      <div class="aso-info-c"><div class="aso-info-lbl">Период</div><div class="aso-info-val">${days}<span style="font-size:12px;color:var(--ink-3)"> дней</span></div><div class="aso-info-sub">${dayLabels[0].label} → ${dayLabels[days-1].label}</div></div>
      <div class="aso-info-c"><div class="aso-info-lbl">Сегодня</div><div class="aso-info-val accent">${formatNum(todayInstalled)}</div><div class="aso-info-sub">установок за&nbsp;день</div></div>
      <div class="aso-info-c"><div class="aso-info-lbl">Установлено всего</div><div class="aso-info-val">${formatNum(totalInstalled)}</div><div class="aso-info-sub">по&nbsp;${app.keywords.length} ключам</div></div>
      <div class="aso-info-c"><div class="aso-info-lbl">План остаток</div><div class="aso-info-val ${remaining > 0 ? '' : 'accent'}">${formatNum(remaining)}</div><div class="aso-info-sub">из&nbsp;${formatNum(totalPlan)}</div></div>
    </div>
    <div class="aso-wrap"><table class="aso-tbl">
      <thead><tr><th class="key-col">День / Ключ</th>${app.keywords.map(k => `<th>${escapeHtml(k.name)}</th>`).join('')}<th>Σ день</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td>Итого</td>${kwTotals.map(t => `<td>${t}</td>`).join('')}<td class="grand-total">${kwTotals.reduce((s, x) => s + x, 0)}</td></tr></tfoot>
    </table></div>
    <div class="hint" style="margin-top:24px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      <div><b>Кликните по ячейке</b>, чтобы внести количество установок за&nbsp;день. Списание идёт с&nbsp;баланса по&nbsp;тарифу выбранного ключа.</div>
    </div>`;
}

/* ═══════════════════════════════════════════════════
   ASO TABLE EDIT  (POSTs to API)
   ═══════════════════════════════════════════════════ */

function todayKey() { return new Date().toISOString().slice(0, 10); }

function getDayLabels(days) {
  const labels = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    labels.push({ key, label });
  }
  return labels;
}

function getInstallsForDay(kw, dayKey) {
  if (!kw.installs) kw.installs = {};
  return kw.installs[dayKey] || 0;
}

function editAsoCell(td) {
  if (td.querySelector('input')) return;
  const current = parseInt(td.textContent, 10) || 0;
  td.innerHTML = `<input type="number" value="${current || ''}" min="0" placeholder="0">`;
  const input = td.querySelector('input');
  input.focus(); input.select();

  const finish = async () => {
    if (td._saving) return;
    td._saving = true;
    const val = Math.max(0, parseInt(input.value, 10) || 0);
    const appId = td.dataset.app;
    const kwId = td.dataset.kw;
    const dKey = td.dataset.day;
    const app = data.apps.find(a => a.id === appId);
    if (!app) return;
    const kw = app.keywords.find(k => k.id === kwId);
    if (!kw) return;
    try {
      const r = await API.setInstalls(kw.apiId, dKey, val);
      if (val === 0) delete kw.installs[dKey]; else kw.installs[dKey] = r.install.count;
      kw.totalInstalled = Object.values(kw.installs).reduce((s, x) => s + x, 0);
      data.balance = r.balance;
      refreshUserUI();
      routeFromHash();
    } catch (e) {
      if (e.message === 'insufficient_balance') {
        toast('Недостаточно средств на балансе', 'error');
      } else {
        toast('Ошибка: ' + e.message, 'error');
      }
      routeFromHash();
    }
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = current || ''; input.blur(); }
  });
}

/* ═══════════════════════════════════════════════════
   APP / KW CRUD (via API)
   ═══════════════════════════════════════════════════ */

function openAddApp() {
  document.getElementById('newAppUrl').value = '';
  document.getElementById('newAppKeywords').value = '';
  document.getElementById('newAppCountry').value = 'us';
  openModal('addAppModal');
  setTimeout(() => document.getElementById('newAppUrl')?.focus(), 50);
}

async function submitAddApp() {
  const url = document.getElementById('newAppUrl').value.trim();
  const country = document.getElementById('newAppCountry').value || 'us';
  const kwRaw = document.getElementById('newAppKeywords').value;
  const keywords = kwRaw.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
  if (!url) { toast('Вставьте ссылку или App Store ID', 'error'); return; }

  const btn = document.getElementById('addAppSubmit');
  if (btn) { btn.disabled = true; btn.textContent = 'Загружаем из AppTweak…'; }
  try {
    const res = await API.createApp({ url, country, keywords });
    const idx = data.apps.length;
    const mapped = mapApp(res.app, idx);
    mapped.keywords = (res.keywords || []).map(mapKeyword);
    data.apps.unshift(mapped);
    refreshUserUI();
    closeModal('addAppModal');
    toast(`✓ ${mapped.name} добавлено${keywords.length ? `, ${keywords.length} ключ(ей) трекаются` : ''}`);

    // Подтянуть исторические ранги в фоне (отдельный bulk-вызов).
    if (keywords.length) {
      API.syncHistory(mapped.apiId, 30).catch(() => {});
    }
    goPage('app', mapped.id);
  } catch (e) {
    const map = {
      app_not_found_in_apptweak: 'Приложение не найдено. Проверь ссылку и страну.',
      invalid_app_id: 'Не получилось распознать App Store ID в ссылке.',
    };
    toast(map[e.message] || ('Ошибка: ' + e.message), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Создать и трекать →'; }
  }
}

async function deleteApp(appId) {
  if (!confirm('Удалить приложение и все его ключи? Это действие нельзя отменить.')) return;
  const app = data.apps.find(a => a.id === appId);
  if (!app) return;
  try {
    await API.deleteApp(app.apiId);
    data.apps = data.apps.filter(a => a.id !== appId);
    refreshUserUI();
    toast('Приложение удалено');
    goPage('apps');
  } catch (e) { toast('Ошибка: ' + e.message, 'error'); }
}

async function toggleAppStatus(appId) {
  const app = data.apps.find(a => a.id === appId);
  if (!app) return;
  const next = app.status === 'paused' ? 'active' : 'paused';
  try {
    const r = await API.updateApp(app.apiId, { status: next });
    app.status = r.app.status;
    toast(app.status === 'paused' ? 'Кампания на паузе' : 'Кампания возобновлена');
    routeFromHash();
  } catch (e) { toast('Ошибка: ' + e.message, 'error'); }
}

let _addKwAppId = null;
function openAddKw(appId) {
  _addKwAppId = appId;
  document.getElementById('newKw').value = '';
  document.getElementById('newKwPos').value = '';
  document.getElementById('newKwTarget').value = '5';
  openModal('addKwModal');
}

async function submitAddKw() {
  const name = document.getElementById('newKw').value.trim();
  const target = parseInt(document.getElementById('newKwTarget').value, 10) || 5;
  if (!name) { toast('Укажите ключевое слово', 'error'); return; }
  const app = data.apps.find(a => a.id === _addKwAppId);
  if (!app) return;
  try {
    const r = await API.createKeyword({ app_id: app.apiId, term: name, target_pos: target });
    app.keywords.unshift(mapKeyword(r.keyword));
    closeModal('addKwModal');
    toast('Ключ добавлен. Тянем позицию из AppTweak…');
    // Подтянуть текущую позицию + историю
    API.syncApp(app.apiId)
      .then(() => API.syncHistory(app.apiId, 30))
      .then(() => API.listByApp(app.apiId))
      .then(lr => {
        app.keywords = (lr.keywords || []).map(mapKeyword);
        _matrixState.appId = null;
        routeFromHash();
      })
      .catch(() => {});
    routeFromHash();
  } catch (e) { toast('Ошибка: ' + e.message, 'error'); }
}

async function deleteKw(appId, kwId) {
  if (!confirm('Удалить ключевое слово?')) return;
  const app = data.apps.find(a => a.id === appId);
  if (!app) return;
  const kw = app.keywords.find(k => k.id === kwId);
  if (!kw) return;
  try {
    await API.deleteKeyword(kw.apiId);
    app.keywords = app.keywords.filter(k => k.id !== kwId);
    toast('Ключ удалён');
    routeFromHash();
  } catch (e) { toast('Ошибка: ' + e.message, 'error'); }
}

/* ═══════════════════════════════════════════════════
   TOPUP
   ═══════════════════════════════════════════════════ */

function selectTopupPreset(el, amount) {
  document.querySelectorAll('.topup-preset').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('topupCustom').value = amount;
  onTopupAmountChange();
}

async function submitTopup() {
  const amount = parseInt(document.getElementById('topupCustom').value, 10) || 0;
  const comment = document.getElementById('topupComment').value.trim();
  if (amount < 1500) { toast('Минимальный депозит — $1500', 'error'); return; }
  try {
    const r = await API.topup(amount, 'manager', comment);
    data.transactions.unshift(mapTx(r.transaction));
    toast('Заявка создана. Менеджер свяжется в Telegram.');
    // Демо-подтверждение через 3.5с (в проде — админка менеджера).
    setTimeout(async () => {
      try {
        const c = await API.confirmTx(r.transaction.id);
        data.balance = c.balance;
        // refresh tx list
        const tl = await API.listTransactions();
        data.transactions = (tl.transactions || []).map(mapTx);
        refreshUserUI();
        toast('💰 Оплата подтверждена менеджером (+$' + formatNum(amount) + ')');
        const page = (location.hash || '#dashboard').slice(1).split('/')[0];
        if (page === 'topup') goPage('history'); else routeFromHash();
      } catch {}
    }, 3500);
    goPage('history');
  } catch (e) { toast('Ошибка: ' + e.message, 'error'); }
}

/* ═══════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════ */

function formatNum(n) { return Math.round(n || 0).toLocaleString('en-US').replace(/,/g, ' '); }
function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' +
    d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function escapeAttr(s) { return escapeHtml(s); }
function statusPill(status) {
  const map = { active: ['active', 'Активна'], paused: ['paused', 'Пауза'], done: ['done', 'Готово'], pending: ['pending', 'Ожидает'], scheduled: ['pending', 'Запланировано'] };
  const [cls, label] = map[status] || ['done', status || '—'];
  return `<span class="status-pill ${cls}">${label}</span>`;
}
function txTypeLabel(t) { return ({ topup: 'Пополнение', spend: 'Списание', system: 'Система' })[t] || t; }
function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
function toast(msg, type) {
  const wrap = document.getElementById('toastWrap');
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'error' ? ' error' : '');
  t.innerHTML = `<span class="toast-dot"></span><span>${escapeHtml(msg)}</span>`;
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity 0.3s, transform 0.3s';
    t.style.opacity = '0'; t.style.transform = 'translateX(50%)';
    setTimeout(() => t.remove(), 300);
  }, 4000);
}
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sbOverlay').classList.toggle('show');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sbOverlay').classList.remove('show');
}

document.querySelectorAll('.modal-bg').forEach(bg => {
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.classList.remove('show'); });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-bg.show').forEach(m => m.classList.remove('show'));
});

/* ═══════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════ */

(async function init() {
  if (API.isAuthed()) {
    try { await enterApp(); }
    catch { document.getElementById('authScreen').style.display = 'flex'; }
  } else {
    document.getElementById('authScreen').style.display = 'flex';
  }
})();
