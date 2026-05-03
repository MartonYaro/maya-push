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
  data.user = { ...meRes.user, email_verified: !!meRes.email_verified };
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
  const isReg = tab === 'register';
  document.getElementById('nameRow').style.display = isReg ? 'flex' : 'none';
  document.getElementById('tosRow').style.display = isReg ? 'flex' : 'none';
  document.getElementById('authPasswordHelp').style.display = isReg ? 'block' : 'none';
  document.getElementById('forgotLink').style.display = isReg ? 'none' : 'inline';
  document.getElementById('authPassword').autocomplete = isReg ? 'new-password' : 'current-password';
  document.getElementById('authTitle').innerHTML = isReg
    ? '<span class="accent">Создать</span> аккаунт'
    : 'Вход в&nbsp;<span class="accent">кабинет</span>';
  document.getElementById('authSub').textContent = isReg
    ? '— Регистрация в системе —'
    : '— Личный кабинет MAYA Push —';
  document.getElementById('authSubmitBtn').textContent = isReg ? 'Создать →' : 'Войти →';
  document.getElementById('authError').classList.remove('show');
}

const AUTH_ERRORS = {
  invalid_email: 'Неверный формат email',
  invalid_name: 'Имя должно быть от 2 символов',
  email_taken: 'Пользователь с таким email уже зарегистрирован',
  invalid_credentials: 'Неверный email или пароль',
  password_too_short: 'Пароль должен быть минимум 8 символов',
  password_too_long: 'Пароль слишком длинный',
  password_needs_letter: 'Пароль должен содержать букву',
  password_needs_digit: 'Пароль должен содержать цифру',
  must_accept_tos: 'Нужно принять условия использования',
  missing_fields: 'Заполните все поля',
  rate_limited: 'Слишком много попыток. Подожди немного и попробуй снова.',
  invalid_token: 'Ссылка недействительна',
  expired_token: 'Срок действия ссылки истёк',
  email_verification_required: 'Подтверди email — мы отправили письмо со ссылкой',
  min_topup_1500: 'Минимальный депозит — $1500',
  max_topup_exceeded: 'Слишком большая сумма за раз',
  telegram_required: 'Укажите ваш Telegram — менеджер напишет с реквизитами',
  invalid_telegram: 'Неверный формат Telegram (4-32 символа: буквы, цифры, _)',
};

function authErrorMessage(err) {
  return AUTH_ERRORS[err.message] || ('Ошибка: ' + err.message);
}

async function handleAuth(e) {
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim().toLowerCase();
  const password = document.getElementById('authPassword').value;
  const name = document.getElementById('authName').value.trim();
  const acceptTos = document.getElementById('acceptTos').checked;
  const hp = document.getElementById('hpField').value;

  try {
    let res;
    if (currentAuthTab === 'register') {
      if (!name) return showAuthError('Укажите имя');
      if (!acceptTos) return showAuthError('Нужно принять условия использования');
      res = await API.register({ email, password, name, accept_tos: true, hp_field: hp });
      if (res.token === 'noop') return; // honeypot triggered, silent
    } else {
      res = await API.login(email, password);
    }
    API.setToken(res.token);
    await enterApp();
    if (currentAuthTab === 'register') {
      toast('Добро пожаловать! Проверь почту — мы отправили ссылку для подтверждения.');
    } else {
      toast('Вход выполнен');
    }
  } catch (err) {
    showAuthError(authErrorMessage(err));
  }
}

/* ─── Forgot password ─── */

function openForgotModal(ev) {
  if (ev) ev.preventDefault();
  document.getElementById('forgotEmail').value =
    document.getElementById('authEmail').value || '';
  document.getElementById('forgotResult').style.display = 'none';
  openModal('forgotModal');
  setTimeout(() => document.getElementById('forgotEmail')?.focus(), 50);
}

async function submitForgot() {
  const email = document.getElementById('forgotEmail').value.trim().toLowerCase();
  if (!email) return toast('Введите email', 'error');
  const btn = document.getElementById('forgotSubmit');
  btn.disabled = true; btn.textContent = 'Отправляем…';
  try {
    await API.forgot(email);
    const out = document.getElementById('forgotResult');
    out.style.display = 'block';
    out.innerHTML = '✉️ <b>Если такой email существует</b>, мы отправили ссылку для&nbsp;сброса пароля. Проверь почту (включая «Спам»).';
    btn.textContent = 'Отправлено';
  } catch (e) {
    toast(authErrorMessage(e), 'error');
    btn.disabled = false; btn.textContent = 'Отправить ссылку';
  }
}

/* ─── Reset password (when ?reset=TOKEN) ─── */

function checkResetTokenInUrl() {
  const params = new URLSearchParams(location.search);
  const t = params.get('reset');
  if (t) {
    window._resetToken = t;
    openModal('resetModal');
    setTimeout(() => document.getElementById('resetPassword')?.focus(), 100);
  }
  // Email verified redirect
  const v = params.get('verified');
  if (v === 'ok')      toast('✓ Email подтверждён! Аккаунт активирован.');
  if (v === 'expired') toast('Ссылка устарела. Запросите новую.', 'error');
  if (v === 'invalid') toast('Ссылка недействительна.', 'error');
  if (v) cleanResetUrl();
}

function cleanResetUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('reset');
  url.searchParams.delete('verified');
  history.replaceState(null, '', url.toString());
}

async function submitReset() {
  const password = document.getElementById('resetPassword').value;
  const errEl = document.getElementById('resetError');
  errEl.style.display = 'none';
  if (!password || password.length < 8) {
    errEl.textContent = 'Минимум 8 символов'; errEl.style.display = 'block';
    return;
  }
  const btn = document.getElementById('resetSubmit');
  btn.disabled = true; btn.textContent = 'Сохраняем…';
  try {
    const r = await API.resetPassword(window._resetToken, password);
    API.setToken(r.token);
    closeModal('resetModal');
    cleanResetUrl();
    await enterApp();
    toast('✓ Пароль обновлён, вход выполнен');
  } catch (e) {
    errEl.textContent = authErrorMessage(e);
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Сменить пароль';
  }
}

/* ─── Email verification banner ─── */

async function resendVerification() {
  try {
    await API.resendVerification();
    toast('Письмо отправлено повторно. Проверь почту.');
  } catch (e) {
    toast(authErrorMessage(e), 'error');
  }
}

function updateVerifyBanner() {
  const b = document.getElementById('verifyBanner');
  if (!b || !data.user) return;
  if (data.user.email_verified) {
    b.style.display = 'none';
  } else {
    b.style.display = 'flex';
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
  updateVerifyBanner();
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
    'install.updated': (inst) => {
      if (!inst) return;
      // Show toast on completion / partial / failure
      const st = inst.status;
      const labels = {
        delivered: '✅ Установки доставлены',
        partial:   '⚠ Частично доставлено — возврат на баланс',
        failed:    '❌ Заказ не выполнен — возврат на баланс',
        cancelled: 'Заказ отменён',
        in_progress: '🚀 Заказ передан в работу',
      };
      if (labels[st]) toast(labels[st], st === 'failed' ? 'error' : undefined);
      refreshBalanceAndTx();
    },
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
    explorer: 'Поиск ключей',
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
        explorer: renderExplorer,
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
  // Текущий тариф юзера: лучший по сумме его реальных пополнений за всё время
  const totalToppedUp = data.transactions
    .filter(t => t.type === 'topup' && t.status === 'done')
    .reduce((s, t) => s + (t.amount > 0 ? t.amount : 0), 0);
  const userTier = tierFromAmount(totalToppedUp || 0);
  const userPrice = userTier.pricePerInstall;
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
        <div class="stat-c" title="Активный тариф зависит от суммы ваших пополнений. Чем больше депозит — тем дешевле установка.">
          <div class="stat-c-lbl">Цена за&nbsp;установку</div>
          <div class="stat-c-val"><span class="accent">${userPrice != null ? '$' + userPrice.toFixed(2) : '—'}</span></div>
          <div class="stat-c-sub">тариф «${escapeHtml(userTier.name)}»${userPrice != null && data.balance > 0 ? ` · хватит на&nbsp;~${formatNum(Math.floor(data.balance / userPrice))} установок` : ''}</div>
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
            <label class="form-label">
              Ваш Telegram <span style="color:var(--red);">*</span>
              <span class="form-help" style="display:inline; margin-left:6px;">— менеджер напишет с реквизитами оплаты</span>
            </label>
            <input type="text" class="form-input" id="topupTelegram"
              placeholder="@username" value="${data.user && data.user.telegram ? '@' + escapeAttr(data.user.telegram) : ''}"
              style="font-family: 'JetBrains Mono', monospace;">
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

/* ─────────────────────────────────────────────────────
   KEYWORD EXPLORER
   ───────────────────────────────────────────────────── */

let _explorer = {
  keyword: '',
  country: 'us',
  loading: false,
  data: null,
  error: null,
  recent: [],   // last searched keywords for quick re-pick
};

function renderExplorer() {
  // Try to restore recent from localStorage on first render
  if (!_explorer.recent.length) {
    try {
      const r = JSON.parse(localStorage.getItem('maya_recent_kw') || '[]');
      if (Array.isArray(r)) _explorer.recent = r.slice(0, 8);
    } catch {}
  }

  const countryOptions = Object.entries(COUNTRY_INFO)
    .map(([code, info]) => `<option value="${code}" ${code === _explorer.country ? 'selected' : ''}>${info.flag} ${info.label}</option>`)
    .join('');

  return `
    <div class="page">
      <div class="page-header">
        <div>
          <div class="page-subtitle">/ Исследование запросов · AppTweak</div>
          <div class="page-title">Поиск <span class="accent">ключей</span></div>
        </div>
      </div>

      <div class="hint">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        <div>
          <b>Что это?</b> Введи поисковый запрос — увидишь его <b>объём поиска</b>, <b>сложность</b>,
          сколько приложений ранжируется, и <b>топ-10 приложений</b> которые сейчас стоят на этом ключе.
          Используй для&nbsp;разведки перед запуском кампании.
        </div>
      </div>

      ${data.user && data.user.email_verified === false ? `
      <div class="hint" style="border-color: var(--warn, #f59e0b); background: rgba(245,158,11,0.08);">
        <span style="font-size:18px;">🔒</span>
        <div>
          <b>Поиск ключей доступен после подтверждения email.</b>
          Каждый запрос стоит нам ~13 кредитов AppTweak — мы открываем эту функцию только верифицированным пользователям.
          <a href="#" onclick="event.preventDefault(); resendVerification();" style="color:var(--acc); text-decoration:underline;">Отправить письмо повторно</a>.
        </div>
      </div>` : ''}

      <div class="card">
        <div class="card-body">
          <form onsubmit="event.preventDefault(); doExplorerSearch();">
            <div style="display:grid; grid-template-columns: 1fr 220px auto; gap:10px; align-items:end;">
              <div class="form-row" style="margin:0;">
                <label class="form-label">Поисковый запрос</label>
                <input type="text" class="form-input" id="explorerInput" placeholder="messenger, fitness, weather..."
                  value="${escapeAttr(_explorer.keyword)}" autofocus
                  style="font-family:'JetBrains Mono', monospace; font-size:14px;">
              </div>
              <div class="form-row" style="margin:0;">
                <label class="form-label">Страна App Store</label>
                <select class="form-select" id="explorerCountry">${countryOptions}</select>
              </div>
              <button class="btn btn-primary" type="submit" style="height: 42px;">🔍 Найти</button>
            </div>
          </form>
          ${_explorer.recent.length ? `
            <div style="margin-top:14px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
              <span style="font-family:'JetBrains Mono', monospace; font-size:10px; color:var(--ink-3); letter-spacing:0.1em; text-transform:uppercase;">недавние:</span>
              ${_explorer.recent.map(k => `<span class="kw-chip" onclick="repeatExplorerSearch('${escapeAttr(k)}')">${escapeHtml(k)}</span>`).join('')}
            </div>` : ''}
        </div>
      </div>

      <div id="explorerResults">${renderExplorerResults()}</div>
    </div>`;
}

function renderExplorerResults() {
  if (_explorer.loading) {
    return `<div class="card"><div class="card-body"><div class="empty" style="padding:32px;">
      <div class="empty-text" style="color:var(--ink-3); font-family:'JetBrains Mono', monospace;">Запрашиваем AppTweak…</div>
    </div></div></div>`;
  }
  if (_explorer.error) {
    return `<div class="card"><div class="card-body"><div class="empty">
      <div class="empty-title">Ошибка</div>
      <div class="empty-text" style="color:var(--cinnabar);">${escapeHtml(_explorer.error)}</div>
    </div></div></div>`;
  }
  if (!_explorer.data) return '';

  const { keyword, country, metrics, totalApps, topApps } = _explorer.data;
  const m = metrics || {};
  const flag = (COUNTRY_INFO[country] && COUNTRY_INFO[country].flag) || '';

  return `
    <div class="page-subtitle" style="margin: 6px 0 12px;">
      / Insights for <span style="color:var(--ink); font-weight:700;">«${escapeHtml(keyword)}»</span> · ${flag} ${escapeHtml((COUNTRY_INFO[country]||{}).label||country.toUpperCase())}
    </div>

    <div class="stat-grid">
      <div class="stat-c" title="Сколько раз в день этот запрос ищут (шкала 0–100)">
        <div class="stat-c-lbl">Объём поиска</div>
        <div class="stat-c-val ${m.volume != null && m.volume >= 50 ? 'accent' : ''}">${m.volume != null ? m.volume : '—'}</div>
        <div class="stat-c-sub">${m.volume != null ? volumeLabel(m.volume) : 'нет данных'}</div>
      </div>
      <div class="stat-c" title="Шкала 0–100. Выше — труднее пробиться в топ.">
        <div class="stat-c-lbl">Сложность</div>
        <div class="stat-c-val ${m.difficulty != null && m.difficulty >= 70 ? '' : 'green'}" style="${m.difficulty != null && m.difficulty >= 70 ? 'color:var(--cinnabar);' : ''}">${m.difficulty != null ? m.difficulty : '—'}</div>
        <div class="stat-c-sub">${m.difficulty != null ? difficultyLabel(m.difficulty) : 'нет данных'}</div>
      </div>
      <div class="stat-c">
        <div class="stat-c-lbl">Максимальный охват</div>
        <div class="stat-c-val">${m.max_reach != null ? formatNum(m.max_reach) : '—'}</div>
        <div class="stat-c-sub">пользователей увидят</div>
      </div>
      <div class="stat-c">
        <div class="stat-c-lbl">Приложений по&nbsp;запросу</div>
        <div class="stat-c-val">${formatNum(totalApps || m.results || 0)}</div>
        <div class="stat-c-sub">всего ранжируется</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title">Топ-${topApps.length} приложений в&nbsp;поиске <span class="badge">live</span></div>
        <div style="font-family:'JetBrains Mono', monospace; font-size:11px; color:var(--ink-3); letter-spacing:0.06em;">
          именно так выглядит выдача в App Store
        </div>
      </div>
      <div class="card-body dense">
        ${topApps.length === 0 ? `
          <div class="empty"><div class="empty-text">Нет приложений в выдаче по этому ключу.</div></div>
        ` : `
          <div class="table-wrap"><table class="tbl">
            <thead><tr>
              <th>#</th><th>Приложение</th><th>Разработчик</th><th>Категория</th><th>Рейтинг</th><th></th>
            </tr></thead>
            <tbody>${topApps.map(a => `
              <tr>
                <td class="num" style="color:var(--jade); font-weight:700;">#${a.position}</td>
                <td><div class="app-cell">
                  ${a.icon_url
                    ? `<img src="${escapeAttr(a.icon_url)}" alt="" style="width:40px;height:40px;border-radius:9px;object-fit:cover;flex-shrink:0">`
                    : `<div class="app-icon-sm" style="--ico-a:#3aff9f;--ico-b:#1a9c5e;">${escapeHtml((a.name||'?').slice(0,1).toUpperCase())}</div>`}
                  <div class="app-cell-info">
                    <div class="app-cell-name">${escapeHtml(a.name || ('App #' + a.store_id))}</div>
                    ${a.subtitle ? `<div class="app-cell-meta">${escapeHtml(a.subtitle)}</div>` : ''}
                  </div>
                </div></td>
                <td class="mono" style="font-size:11px; color:var(--ink-2);">${escapeHtml(a.developer || '—')}</td>
                <td class="mono" style="font-size:11px; color:var(--ink-2);">${escapeHtml(a.category || '—')}</td>
                <td class="num">${a.rating != null
                  ? `<span style="color:var(--gold)">★ ${a.rating.toFixed(1)}</span>`
                  : '—'}</td>
                <td><a href="https://apps.apple.com/app/id${a.store_id}" target="_blank" class="btn btn-ghost btn-sm">App Store ↗</a></td>
              </tr>`).join('')}</tbody>
          </table></div>
        `}
      </div>
    </div>

    <div style="margin-top:18px; text-align:center;">
      <button class="btn btn-ghost" onclick="addExplorerKeywordToApp()">+ Добавить «${escapeHtml(keyword)}» в трекинг</button>
    </div>`;
}

function volumeLabel(v) {
  if (v >= 80) return 'очень высокий';
  if (v >= 50) return 'высокий';
  if (v >= 30) return 'средний';
  if (v >= 10) return 'низкий';
  return 'почти не ищут';
}

function difficultyLabel(d) {
  if (d >= 80) return 'очень тяжело';
  if (d >= 60) return 'тяжело';
  if (d >= 40) return 'средне';
  if (d >= 20) return 'легко';
  return 'очень легко';
}

async function doExplorerSearch() {
  const inp = document.getElementById('explorerInput');
  const ctrySel = document.getElementById('explorerCountry');
  const keyword = (inp.value || '').trim();
  const country = ctrySel ? ctrySel.value : 'us';
  if (!keyword) { toast('Введите запрос', 'error'); return; }

  _explorer.keyword = keyword;
  _explorer.country = country;
  _explorer.loading = true;
  _explorer.error = null;
  _explorer.data = null;
  document.getElementById('explorerResults').innerHTML = renderExplorerResults();

  try {
    const r = await API.researchKeyword(keyword, country, 10);
    _explorer.data = r;
    // Add to recent
    _explorer.recent = [keyword, ..._explorer.recent.filter(k => k !== keyword)].slice(0, 8);
    try { localStorage.setItem('maya_recent_kw', JSON.stringify(_explorer.recent)); } catch {}
  } catch (e) {
    if (e.message === 'apptweak_not_configured') {
      _explorer.error = 'AppTweak не настроен на сервере';
    } else if (e.message === 'email_verification_required') {
      _explorer.error = '🔒 Подтверди email, чтобы пользоваться поиском ключей';
    } else {
      _explorer.error = authErrorMessage(e);
    }
  } finally {
    _explorer.loading = false;
    document.getElementById('explorerResults').innerHTML = renderExplorerResults();
  }
}

function repeatExplorerSearch(keyword) {
  _explorer.keyword = keyword;
  document.getElementById('explorerInput').value = keyword;
  doExplorerSearch();
}

function addExplorerKeywordToApp() {
  const kw = _explorer.keyword;
  if (!kw) return;
  if (data.apps.length === 0) {
    toast('Сначала добавь приложение, чтобы трекать ключ', 'error');
    return;
  }
  if (data.apps.length === 1) {
    _addKwAppId = data.apps[0].id;
    openAddKw(data.apps[0].id);
    setTimeout(() => {
      const ta = document.getElementById('newKw');
      if (ta) { ta.value = kw; ta.focus(); }
    }, 80);
    return;
  }
  // Multiple apps — ask which
  const which = prompt(
    'В какое приложение добавить ключ «' + kw + '»?\n\n' +
    data.apps.map((a, i) => (i + 1) + ') ' + a.name).join('\n') +
    '\n\nВведи номер:'
  );
  const idx = parseInt(which, 10) - 1;
  if (idx >= 0 && data.apps[idx]) {
    openAddKw(data.apps[idx].id);
    setTimeout(() => {
      const ta = document.getElementById('newKw');
      if (ta) { ta.value = kw; ta.focus(); }
    }, 80);
  }
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

let _matrixState = { appId: null, days: 30, filter: 'all', search: '', data: null, loading: false };

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
    _matrixState = { appId, days: 30, filter: 'all', search: '', data: null, loading: false };
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
        <div class="filter-chips">
          <button class="filter-chip ${_matrixState.filter==='all'?'active':''}" onclick="setMatrixFilter('all')">Все</button>
          <button class="filter-chip ${_matrixState.filter==='top10'?'active':''}" onclick="setMatrixFilter('top10')">топ-10</button>
          <button class="filter-chip ${_matrixState.filter==='top30'?'active':''}" onclick="setMatrixFilter('top30')">11–30</button>
          <button class="filter-chip ${_matrixState.filter==='top100'?'active':''}" onclick="setMatrixFilter('top100')">31–100</button>
          <button class="filter-chip ${_matrixState.filter==='out'?'active':''}" onclick="setMatrixFilter('out')">вне топа</button>
          <button class="filter-chip ${_matrixState.filter==='improved'?'active':''}" onclick="setMatrixFilter('improved')">↑ выросли</button>
          <button class="filter-chip ${_matrixState.filter==='dropped'?'active':''}" onclick="setMatrixFilter('dropped')">↓ упали</button>
        </div>
        <div class="search-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="search" placeholder="поиск по ключу…" value="${escapeAttr(_matrixState.search)}" oninput="setMatrixSearch(this.value)">
        </div>
        <button class="btn btn-primary btn-sm" onclick="openAddKw('${app.id}')">+ Ключ</button>
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

function setMatrixFilter(f) {
  _matrixState.filter = f;
  document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
  const btn = [...document.querySelectorAll('.filter-chip')]
    .find(b => b.getAttribute('onclick')?.includes(`'${f}'`));
  if (btn) btn.classList.add('active');
  paintMatrix();
}

let _matrixSearchTimer = null;
function setMatrixSearch(q) {
  clearTimeout(_matrixSearchTimer);
  _matrixSearchTimer = setTimeout(() => {
    _matrixState.search = (q || '').trim().toLowerCase();
    paintMatrix();
  }, 150);
}

function applyMatrixFilters(keywords) {
  const { filter, search } = _matrixState;
  return keywords.filter(k => {
    if (search && !String(k.term).toLowerCase().includes(search)) return false;
    const cur = k.current_pos;
    switch (filter) {
      case 'top10':    return cur != null && cur <= 10;
      case 'top30':    return cur != null && cur > 10 && cur <= 30;
      case 'top100':   return cur != null && cur > 30 && cur <= 100;
      case 'out':      return cur == null || cur > 100;
      case 'improved': return k.trend != null && k.trend < 0;
      case 'dropped':  return k.trend != null && k.trend > 0;
      default:         return true;
    }
  });
}

function paintMatrix() {
  const el = document.getElementById('matrixBody');
  if (!el || !_matrixState.data) return;
  const { dates } = _matrixState.data;
  const allKeywords = _matrixState.data.keywords;
  const keywords = applyMatrixFilters(allKeywords);

  if (!allKeywords.length) {
    el.innerHTML = `<div class="empty" style="padding:48px 24px;"><div class="empty-title">Нет ключевых слов</div></div>`;
    return;
  }
  if (!keywords.length) {
    el.innerHTML = `<div class="empty" style="padding:48px 24px;">
      <div class="empty-title">Ничего не найдено</div>
      <div class="empty-text">Под фильтр «${escapeHtml(_matrixState.filter)}»${_matrixState.search ? ` и поиск «${escapeHtml(_matrixState.search)}»` : ''} нет ни&nbsp;одного ключа.</div>
      <button class="btn btn-ghost btn-sm" onclick="setMatrixFilter('all'); setMatrixSearch('')">Сбросить фильтры</button>
    </div>`;
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

/* ─────────────────────────────────────────────────────
   INSTALL SCHEDULER MODAL
   ───────────────────────────────────────────────────── */

let _scheduler = {
  appId: null, kwId: null, kw: null, app: null,
  days: 7,             // окно в днях
  perDay: {},          // {date: count}
  existing: {},        // {date: {count,status}} — то что уже было
};

async function openInstallsForKw(kwId) {
  // find the keyword + parent app
  let app = null, kw = null;
  for (const a of data.apps) {
    const found = a.keywords.find(k => k.id === kwId);
    if (found) { app = a; kw = found; break; }
  }
  if (!app || !kw) return toast('Ключ не найден', 'error');

  _scheduler = { appId: app.id, kwId: kw.id, kw, app, days: 7, perDay: {}, existing: {} };
  // Pull existing scheduled installs from API
  try {
    const r = await API.keywordInstalls(kw.apiId);
    for (const row of (r.installs || [])) {
      _scheduler.existing[row.date] = { count: row.count, status: row.status };
    }
  } catch {}
  paintScheduler();
  openModal('installsModal');
}

function paintScheduler() {
  const { kw, app, days, perDay, existing } = _scheduler;
  const tier = PRICING_TIERS.find(t => t.id === (kw.planTier || 'standard')) || PRICING_TIERS[0];
  const price = tier.pricePerInstall || 0.30;

  document.getElementById('installsTitle').textContent = `Кампания: ${kw.name}`;

  // dates window: starting today
  const dates = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const todayStr = today.toISOString().slice(0, 10);

  const totalNew = Object.values(perDay).reduce((s, x) => s + (parseInt(x, 10) || 0), 0);
  const totalCost = +(totalNew * price).toFixed(2);

  const body = `
    <div class="sched-head">
      <div>
        <div class="sh-title">${escapeHtml(kw.name)}</div>
        <div class="sh-meta">${escapeHtml(app.name)} · ${escapeHtml(app.geo)} · тариф: ${escapeHtml(tier.name)} · $${price.toFixed(2)} / установка</div>
      </div>
      <div class="sh-pos">
        <div class="lab">Текущая → Цель</div>
        <div class="val">${kw.currentPos != null ? '#' + kw.currentPos : '—'} → <span class="green">#${kw.targetPos}</span></div>
      </div>
    </div>

    <div style="margin-bottom: 14px; font-size: 13px; color: var(--ink-2);">
      Сколько установок раздать каждый день? Можешь воспользоваться быстрыми кнопками или вписать своё число в&nbsp;каждый день.
    </div>

    <div class="sched-presets">
      <div class="sched-preset" onclick="schedFill(0)">Очистить</div>
      <div class="sched-preset" onclick="schedFill(50)">50/день</div>
      <div class="sched-preset" onclick="schedFill(100)">100/день</div>
      <div class="sched-preset" onclick="schedFill(200)">200/день</div>
      <div class="sched-preset" onclick="schedFill(500)">500/день</div>
      <div class="sched-preset" onclick="schedSetWindow(7)" style="${days===7 ? 'background:var(--bg-3)':''}">7 дней</div>
      <div class="sched-preset" onclick="schedSetWindow(14)" style="${days===14 ? 'background:var(--bg-3)':''}">14 дней</div>
      <div class="sched-preset" onclick="schedSetWindow(30)" style="${days===30 ? 'background:var(--bg-3)':''}">30 дней</div>
    </div>

    <div class="sched-grid">
      ${dates.map(d => {
        const dt = new Date(d + 'T00:00:00Z');
        const dow = dt.getUTCDay();
        const isWk = (dow === 0 || dow === 6);
        const ex = existing[d];
        const val = perDay[d] != null ? perDay[d] : (ex ? ex.count : '');
        const label = dt.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
        return `<div class="sched-day ${val ? 'has-value' : ''} ${isWk ? 'weekend' : ''} ${d === todayStr ? 'today' : ''}">
          <div class="sd-date">${label}${ex ? ` · ${ex.status === 'done' ? 'выполнено' : 'запланировано'}` : ''}</div>
          <input type="number" min="0" max="9999" class="sd-input" data-date="${d}"
            value="${val}" placeholder="0"
            oninput="schedDayChange('${d}', this.value)">
        </div>`;
      }).join('')}
    </div>

    <div class="sched-summary">
      <div class="ss-c">
        <div class="ss-lbl">Всего установок</div>
        <div class="ss-val">${formatNum(totalNew)}</div>
      </div>
      <div class="ss-c">
        <div class="ss-lbl">Стоимость</div>
        <div class="ss-val ${totalCost > data.balance ? 'red' : 'green'}">$${formatNum(totalCost)}</div>
      </div>
      <div class="ss-c">
        <div class="ss-lbl">Баланс после</div>
        <div class="ss-val ${(data.balance - totalCost) < 0 ? 'red' : ''}">$${formatNum(Math.max(0, data.balance - totalCost))}</div>
      </div>
    </div>
  `;
  document.getElementById('installsBody').innerHTML = body;

  const submit = document.getElementById('installsSubmit');
  submit.disabled = totalNew === 0 || totalCost > data.balance;
  if (totalCost > data.balance) {
    submit.textContent = 'Недостаточно баланса';
  } else if (totalNew === 0) {
    submit.textContent = 'Укажи количество';
  } else {
    submit.textContent = `Запланировать на $${formatNum(totalCost)}`;
  }
  document.getElementById('installsCost').textContent = `$${price.toFixed(2)} × ${formatNum(totalNew)} = $${formatNum(totalCost)}`;
}

function schedDayChange(date, value) {
  const v = parseInt(value, 10);
  if (!v || v <= 0) delete _scheduler.perDay[date];
  else _scheduler.perDay[date] = v;
  paintScheduler();
  // restore focus
  setTimeout(() => {
    const el = document.querySelector(`.sd-input[data-date="${date}"]`);
    if (el) { el.focus(); const len = el.value.length; el.setSelectionRange(len, len); }
  }, 10);
}

function schedFill(count) {
  const today = new Date();
  for (let i = 0; i < _scheduler.days; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    if (count > 0) _scheduler.perDay[key] = count;
    else delete _scheduler.perDay[key];
  }
  paintScheduler();
}

function schedSetWindow(days) {
  _scheduler.days = days;
  paintScheduler();
}

async function submitInstalls() {
  const entries = Object.entries(_scheduler.perDay).filter(([_, v]) => v > 0);
  if (!entries.length) return;
  const submit = document.getElementById('installsSubmit');
  submit.disabled = true;
  submit.textContent = 'Создаём…';

  let okCount = 0, fail = 0;
  for (const [date, count] of entries) {
    try {
      const r = await API.setInstalls(_scheduler.kw.apiId, date, count);
      data.balance = r.balance;
      okCount++;
    } catch (e) {
      fail++;
      if (e.message === 'insufficient_balance') break;
    }
  }
  refreshUserUI();
  closeModal('installsModal');
  if (okCount) {
    toast(`✓ Кампания запущена: ${okCount} ${okCount === 1 ? 'день' : 'дней'}`);
  }
  if (fail) toast(`Не удалось создать ${fail} записей`, 'error');

  // refresh keyword data
  try {
    const lr = await API.listByApp(_scheduler.app.apiId);
    _scheduler.app.keywords = (lr.keywords || []).map(mapKeyword);
  } catch {}
  routeFromHash();
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
  document.getElementById('newKwTarget').value = '10';
  // Reset suggestions
  document.getElementById('kwSuggestRow').style.display = 'none';
  document.getElementById('kwSuggestList').innerHTML =
    '<span style="font-size:12px; color:var(--ink-3);">загружаем…</span>';
  openModal('addKwModal');
  setTimeout(() => document.getElementById('newKw')?.focus(), 50);
  loadKwSuggestions(appId);
}

async function loadKwSuggestions(appId) {
  const app = data.apps.find(a => a.id === appId);
  if (!app) return;
  const row = document.getElementById('kwSuggestRow');
  const list = document.getElementById('kwSuggestList');
  try {
    const r = await API.suggestions(app.apiId);
    const items = (r.suggestions || []).slice(0, 18);
    if (!items.length) {
      list.innerHTML = '<span style="font-size:12px; color:var(--ink-3);">подсказок нет — попробуй после добавления нескольких ключей</span>';
      row.style.display = 'block';
      return;
    }
    list.innerHTML = items.map(s => `
      <span class="kw-chip" data-kw="${escapeAttr(s.keyword)}" onclick="addKwFromChip(this)">
        ${escapeHtml(s.keyword)}
        ${s.volume ? `<span class="kw-vol">vol&nbsp;${s.volume}</span>` : ''}
      </span>
    `).join('');
    row.style.display = 'block';
  } catch (e) {
    if (e && e.message === 'email_verification_required') {
      list.innerHTML = `<span style="font-size:12px; color:var(--warn, #f59e0b);">
        🔒 Подсказки доступны после подтверждения email.
        <a href="#" onclick="event.preventDefault(); resendVerification();" style="color:var(--acc); text-decoration:underline;">отправить письмо повторно</a>
      </span>`;
    } else {
      list.innerHTML = '<span style="font-size:12px; color:var(--ink-3);">не удалось загрузить</span>';
    }
    row.style.display = 'block';
  }
}

function addKwFromChip(el) {
  if (el.classList.contains('added')) return;
  const kw = el.dataset.kw;
  const ta = document.getElementById('newKw');
  const cur = ta.value.trim();
  // Don't duplicate
  const has = cur.split(/[\n,;]+/).map(s => s.trim().toLowerCase()).includes(kw.toLowerCase());
  if (!has) {
    ta.value = cur ? cur + ', ' + kw : kw;
  }
  el.classList.add('added');
  ta.focus();
}

async function submitAddKw() {
  const raw = document.getElementById('newKw').value;
  const target = parseInt(document.getElementById('newKwTarget').value, 10) || 10;
  const terms = raw.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
  if (!terms.length) { toast('Укажите хотя бы один ключ', 'error'); return; }
  const app = data.apps.find(a => a.id === _addKwAppId);
  if (!app) return;
  try {
    const r = await API.createKeyword({ app_id: app.apiId, terms, target_pos: target });
    const created = r.keywords || [];
    const skipped = r.skipped || 0;
    if (created.length) {
      for (const kw of created) app.keywords.unshift(mapKeyword(kw));
      let msg = `Добавлено ${created.length} ${created.length === 1 ? 'ключ' : 'ключей'}.`;
      if (skipped) msg += ` Пропущено ${skipped} (уже трекаются).`;
      msg += ' Тянем позиции…';
      toast(msg);
      // Pull fresh ranks + history
      API.syncApp(app.apiId)
        .then(() => API.syncHistory(app.apiId, 30))
        .then(() => API.listByApp(app.apiId))
        .then(lr => {
          app.keywords = (lr.keywords || []).map(mapKeyword);
          _matrixState.appId = null;
          routeFromHash();
        })
        .catch(() => {});
    } else if (skipped) {
      toast(`Эти ключи уже трекаются (${skipped})`, 'error');
    }
    closeModal('addKwModal');
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
  const tgRaw = (document.getElementById('topupTelegram').value || '').trim();
  if (amount < 1500) { toast('Минимальный депозит — $1500', 'error'); return; }

  // Normalise telegram input: strip @, t.me/, https://t.me/
  const telegram = tgRaw
    .replace(/^@/, '')
    .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '')
    .trim();
  if (!telegram) {
    toast('Укажите ваш Telegram — менеджер напишет с реквизитами', 'error');
    document.getElementById('topupTelegram')?.focus();
    return;
  }
  if (!/^[a-zA-Z0-9_]{4,32}$/.test(telegram)) {
    toast('Неверный формат Telegram. Пример: @yourname', 'error');
    document.getElementById('topupTelegram')?.focus();
    return;
  }

  try {
    const r = await API.topup(amount, 'manager', comment, telegram);
    data.transactions.unshift(mapTx(r.transaction));
    if (data.user) data.user.telegram = telegram;
    toast(`Заявка создана. Менеджер напишет в Telegram @${telegram} с реквизитами.`);
    goPage('history');
  } catch (e) {
    const map = {
      telegram_required: 'Укажите ваш Telegram — менеджер напишет с реквизитами',
      invalid_telegram: 'Неверный формат Telegram. Пример: @yourname',
      min_topup_1500: 'Минимальный депозит — $1500',
      max_topup_exceeded: 'Слишком большая сумма за раз',
    };
    toast(map[e.message] || ('Ошибка: ' + e.message), 'error');
  }
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
  checkResetTokenInUrl();
  if (API.isAuthed()) {
    try { await enterApp(); }
    catch { document.getElementById('authScreen').style.display = 'flex'; }
  } else {
    document.getElementById('authScreen').style.display = 'flex';
  }
})();
