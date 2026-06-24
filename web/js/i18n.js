/* Lightweight RU↔EN layer for the dashboard.
 * Templates render in Russian; in EN mode we translate text nodes,
 * placeholders and titles in place — including dynamically rendered content
 * (via a MutationObserver). Phrases not in the dictionary fall back to RU. */
(function () {
  // Keys are the Russian source, normalised: &nbsp; → space, whitespace collapsed, trimmed.
  const DICT = {
    "(в разработке)": "(in development)",
    "+ Добавить ключ": "+ Add keyword",
    "+ Добавить первое приложение": "+ Add your first app",
    "+ Добавить первый ключ": "+ Add your first keyword",
    "+ Добавить приложение": "+ Add app",
    "+ Добавить →": "+ Add →",
    "+ Запустить кампанию": "+ Launch campaign",
    "+ Ключ": "+ Keyword",
    "+ Ключ →": "+ Keyword →",
    "+ Мониторить": "+ Monitor",
    "+ Новое приложение": "+ New app",
    "+ Приложение": "+ App",
    ", чтобы внести количество установок за день. Списание идёт с баланса по тарифу выбранного ключа.": ", to enter the number of installs per day. Charges come from your balance at the selected keyword's rate.",
    "/ Исследование запросов · App Store": "/ Keyword research · App Store",
    "/ Пополнение · через менеджера": "/ Top-up · via manager",
    "/ установка": "/ install",
    "1 · Добавь приложение": "1 · Add an app",
    "100/день": "100/day",
    "14 дней": "14 days",
    "2 · Наблюдай": "2 · Track",
    "200/день": "200/day",
    "3 · Запусти кампанию": "3 · Launch a campaign",
    "30 дней": "30 days",
    "50/день": "50/day",
    "500/день": "500/day",
    "60 дней": "60 days",
    "7 дней": "7 days",
    "Telegram не загрузился — обнови страницу": "Telegram didn't load — refresh the page",
    "Σ день": "Σ day",
    "Активные пуши установок. Сколько крутится прямо сейчас, по каким ключам, на сколько хватит.": "Active install pushes. What's running right now, on which keywords, and how long the budget lasts.",
    "Аналитика": "Analytics",
    "Баланс": "Balance",
    "Баланс после": "Balance after",
    "Быстрый выбор": "Quick pick",
    "В топ-10": "In top-10",
    "Введи поисковый запрос — увидишь": "Enter a search query — you'll see",
    "Введите email": "Enter email",
    "Введите запрос": "Enter a query",
    "Введите сумму": "Enter an amount",
    "Введите сумму пополнения": "Enter the top-up amount",
    "Войти": "Sign in",
    "Войти →": "Sign in →",
    "Вопросы": "Questions",
    "Все": "All",
    "Все ключи": "All keywords",
    "Все →": "All →",
    "Всего ключей": "Total keywords",
    "Всего установок": "Total installs",
    "Вставь ссылку на App Store, перечисли ключи. Имя, иконка, рейтинг и текущие позиции подтянутся автоматически.": "Paste an App Store link, list the keywords. The name, icon, rating and current positions are pulled in automatically.",
    "Вставьте ссылку или App Store ID": "Paste a link or App Store ID",
    "Вся история →": "Full history →",
    "Вход в": "Sign in to",
    "Вход выполнен": "Signed in",
    "Вход через Google выполнен": "Signed in with Google",
    "Вход через Telegram выполнен": "Signed in with Telegram",
    "Выйти из аккаунта?": "Sign out?",
    "Гео": "Geo",
    "Главное": "Main",
    "Дата": "Date",
    "Дашборд": "Dashboard",
    "Действие": "Action",
    "День / Ключ": "Day / Keyword",
    "Динамика:": "Trend:",
    "Дневной кап": "Daily cap",
    "До какой позиции хотим поднять. По умолчанию топ-10.": "Target position to reach. Top-10 by default.",
    "Добавить": "Add",
    "Добавить ключ": "Add keyword",
    "Добавить ключевые слова": "Add keywords",
    "Добавить приложение": "Add app",
    "Добавить →": "Add →",
    "Добавь поисковые запросы — мы сразу подтянем текущие позиции и историю за 30 дней из App Store.": "Add search queries — we'll instantly pull current positions and 30-day history from the App Store.",
    "Добавьте приложение, укажите ключи и гео — мы запустим кампанию.": "Add an app, set keywords and geo — we'll launch the campaign.",
    "Добро пожаловать! Проверь почту — мы отправили ссылку для подтверждения.": "Welcome! Check your email — we sent a confirmation link.",
    "Добро пожаловать,": "Welcome,",
    "Если такой email существует": "If such an email exists",
    "Забыли?": "Forgot?",
    "Загружаем матрицу позиций…": "Loading the position matrix…",
    "Закрыть": "Close",
    "Запланировать": "Schedule",
    "Заплатить за установки и поднять позицию по нужному ключу. От $0.13 за установку.": "Pay for installs and lift your position on the chosen keyword. From $0.13 per install.",
    "Запрос": "Query",
    "Запустить кампанию": "Launch campaign",
    "Запустить →": "Launch →",
    "Заявка менеджеру": "Request to manager",
    "Здесь будут ваши приложения": "Your apps will appear here",
    "Здесь появятся пополнения и списания.": "Top-ups and charges will appear here.",
    "Имя / Никнейм": "Name / Nickname",
    "История": "History",
    "Итого": "Total",
    "Ищем в App Store…": "Searching the App Store…",
    "К приложениям": "To apps",
    "К списку": "To list",
    "К кампаниям →": "To campaigns →",
    "К матрице →": "To matrix →",
    "Как это работает.": "How it works.",
    "Кампании": "Campaigns",
    "Кампании пока не запущены": "No campaigns launched yet",
    "Кампания — это": "A campaign is",
    "Категория": "Category",
    "Кликни чип чтобы добавить запрос в список.": "Click a chip to add a query to the list.",
    "Кликните по ячейке": "Click a cell",
    "Ключ": "Keyword",
    "Ключ / запрос": "Keyword / query",
    "Ключ не найден": "Keyword not found",
    "Ключ удалён": "Keyword deleted",
    "Ключевые слова": "Keywords",
    "Ключевые слова для трекинга": "Keywords to track",
    "Ключей": "Keywords",
    "Ключей в работе": "Keywords in progress",
    "Комментарий менеджеру (необязательно)": "Comment to manager (optional)",
    "Лучший": "Best",
    "Матрица за 30 дней — где растём, где падаем, по каким ключам стоит толкать.": "30-day matrix — where you're rising, where you're dropping, which keywords to push.",
    "Минимум 8 символов, буква + цифра.": "At least 8 characters, a letter + a digit.",
    "Мои": "Mine",
    "Мои приложения": "My apps",
    "На странице приложения — матрица позиций по дням со стрелками тренда. Никаких лишних кликов.": "On the app page — a daily position matrix with trend arrows. No extra clicks.",
    "Наблюдения": "Observations",
    "Название, иконка, категория, рейтинг — подтянутся автоматически из App Store": "Name, icon, category, rating — pulled automatically from the App Store",
    "Напишите боту поддержки — ответит менеджер.": "Message the support bot — a manager will reply.",
    "Напр. 5": "e.g. 5",
    "Например: запуск Telegram в США по 5 ключам, нужно подключить тариф «Объём»": "e.g.: launch Telegram in the US on 5 keywords, need the “Volume” plan",
    "Не в топ-100": "Not in top-100",
    "Не нашли ответ?": "Didn't find an answer?",
    "Не удалось загрузить данные:": "Failed to load data:",
    "Не удалось создать счёт": "Failed to create the invoice",
    "Неверный формат Telegram. Пример: @yourname": "Invalid Telegram format. Example: @yourname",
    "Недостаточно средств на балансе": "Insufficient balance",
    "Нет данных для мониторинга": "No data to monitor",
    "Нет ключевых слов": "No keywords",
    "Нет отслеживаемых ключей": "No tracked keywords",
    "Нет приложений в выдаче по этому ключу.": "No apps ranking for this keyword.",
    "Ничего не найдено": "Nothing found",
    "Новый пароль": "New password",
    "Пароль": "Password",
    "Я согласен с": "I agree to the",
    "Нужна помощь?": "Need help?",
    "Можно несколько через запятую или с новой строки.": "You can list several, separated by commas or new lines.",
    "Войти через Telegram": "Sign in with Telegram",
    "Обновляем позиции из App Store…": "Refreshing positions from the App Store…",
    "Объём поиска": "Search volume",
    "Объём поиска и сложность — в разработке.": "Search volume and difficulty — in development.",
    "Операций пока нет": "No transactions yet",
    "Описание": "Description",
    "Оплатить криптой →": "Pay with crypto →",
    "Оплата криптой": "Pay with crypto",
    "300+ монет · моментальное зачисление · без минимума": "300+ coins · instant credit · no minimum",
    "Защищённая оплата через NOWPayments. Баланс зачислится автоматически после подтверждения сети.": "Secure payment via NOWPayments. Your balance is credited automatically after network confirmation.",
    "Открыть →": "Open →",
    "Отмена": "Cancel",
    "Отправить ещё раз": "Resend",
    "Отправить ссылку": "Send link",
    "Охват": "Reach",
    "Очистить": "Clear",
    "Ошибка": "Error",
    "Ошибка:": "Error:",
    "Период": "Period",
    "Письмо отправлено повторно. Проверь почту.": "Email resent. Check your inbox.",
    "План остаток": "Plan remaining",
    "По одному запросу на строку. Текущие позиции и история за 30 дней подтянутся сразу.": "One query per line. Current positions and 30-day history are pulled in instantly.",
    "Поддержка": "Support",
    "Поддержка → @MayaPush_bot": "Support → @MayaPush_bot",
    "Подключи ещё один app: ссылка + ключи, остальное MAYA сделает сама за ~5 секунд.": "Add another app: link + keywords, MAYA does the rest in ~5 seconds.",
    "Подключи ещё один поисковый запрос — позиция и история подтянутся за 5 секунд.": "Add another search query — position and history load in 5 seconds.",
    "Подтвердите email.": "Confirm your email.",
    "Поиск": "Search",
    "Поиск ключей": "Keyword search",
    "Поисковый запрос": "Search query",
    "Пополни баланс и закажи установки на ключ — поднимем позицию выше. Цена от $0.13 за установку.": "Top up your balance and order installs on a keyword — we'll lift your position. From $0.13 per install.",
    "Пополнить": "Top up",
    "Последние операции": "Recent transactions",
    "Посмотреть позиции": "View positions",
    "Посмотреть пример →": "See an example →",
    "Привет,": "Hi,",
    "Приложение": "App",
    "Приложение не найдено": "App not found",
    "Приложение удалено": "App deleted",
    "Приложений": "Apps",
    "Приложений в выдаче": "Apps ranking",
    "Приложения": "Apps",
    "Разработчик": "Developer",
    "Регистрация": "Sign up",
    "Рейтинг": "Rating",
    "Сброс пароля": "Password reset",
    "Сбросить фильтры": "Reset filters",
    "Сегодня": "Today",
    "Сейчас": "Now",
    "Сложность": "Difficulty",
    "Сменить пароль": "Change password",
    "Смотреть позиции →": "View positions →",
    "Сначала добавь приложение, чтобы трекать ключ": "Add an app first to track a keyword",
    "Сначала нужны ключи": "You need keywords first",
    "Сначала посмотреть позиции →": "View positions first →",
    "Создано": "Created",
    "Создать": "Create",
    "Создать и трекать →": "Create and track →",
    "Ссылка на App Store или ID": "App Store link or ID",
    "Ссылка недействительна.": "The link is invalid.",
    "Ссылка устарела. Запросите новую.": "The link expired. Request a new one.",
    "Статус": "Status",
    "Стоимость": "Cost",
    "Страна App Store": "App Store country",
    "Сумма": "Amount",
    "Сумма депозита, USD": "Deposit amount, USD",
    "Сумма пополнения": "Top-up amount",
    "Тариф": "Plan",
    "Тарифы": "Plans",
    "Тарифы →": "Plans →",
    "Тек. позиция": "Cur. position",
    "Текущая": "Current",
    "Текущая → Цель": "Current → Target",
    "Текущие позиции всех ключей по всем приложениям. Где топ-10, где упали, где надо толкать.": "Current positions of all keywords across all apps. Where you're top-10, where you dropped, where to push.",
    "Текущую позицию": "Current position",
    "Тип": "Type",
    "Тренд": "Trend",
    "Удалить": "Delete",
    "Удалить ключевое слово?": "Delete this keyword?",
    "Удалить приложение и все его ключи? Это действие нельзя отменить.": "Delete the app and all its keywords? This can't be undone.",
    "Укажите ваш Telegram — менеджер напишет с реквизитами": "Provide your Telegram — the manager will message you with payment details",
    "Укажите хотя бы один ключ": "Specify at least one keyword",
    "Управлять →": "Manage →",
    "Установить новый пароль": "Set a new password",
    "Установлено": "Delivered",
    "Установлено всего": "Delivered total",
    "Установок": "Installs",
    "Установок куплено": "Installs purchased",
    "Финансы": "Finance",
    "Целевая позиция в поиске": "Target position in search",
    "Цель": "Target",
    "Цена за установку": "Price per install",
    "Что дальше?": "What's next?",
    "Что это?": "What's this?",
    "Чтобы запустить кампанию — добавь хотя бы один поисковый запрос. После этого сможешь заказать установки на него.": "To launch a campaign, add at least one search query. Then you can order installs for it.",
    "активные пуши": "active pushes",
    "баланс": "balance",
    "без изменений": "no change",
    "близко": "close",
    "в цели": "on target",
    "в разработке": "in development",
    "вне топа": "out of top",
    "всего отслеживаем": "tracking in total",
    "далеко": "far",
    "дней": "days",
    "за всё время": "all time",
    "за позициями": "positions",
    "загружаем…": "loading…",
    "заказ установок": "install order",
    "и ответы": "and answers",
    "или": "or",
    "историю за 30 дней": "30-day history",
    "кабинет": "dashboard",
    "кампании": "campaigns",
    "ключей": "keywords",
    "не удалось загрузить": "failed to load",
    "недавние:": "recent:",
    "нет данных": "no data",
    "операций": "transactions",
    "оплачиваемое продвижение": "paid promotion",
    "отправить письмо повторно": "resend the email",
    "по этим ключам и": "on these keywords and",
    "по вашему приложению": "for your app",
    "подсказок нет — попробуй после добавления нескольких ключей": "no suggestions — try after adding a few keywords",
    "позиции по дням": "positions by day",
    "позиция выросла": "position rose",
    "поиск по ключу…": "search by keyword…",
    "политикой конфиденциальности": "privacy policy",
    "приложения": "apps",
    "сейчас в App Store": "now in the App Store",
    "средний топ": "mid top",
    "текущие позиции": "current positions",
    "текущие позиции всех ключей": "current positions of all keywords",
    "топ приложений": "top apps",
    "топ приложений в выдаче": "top apps in search",
    "топ-10": "top-10",
    "требуют пуша": "need a push",
    "упала": "dropped",
    "условиями использования": "terms of use",
    "установок за день": "installs per day",
    "число в ячейке = позиция в выдаче": "the number in a cell = search position",
    "— Личный кабинет MAYA Push —": "— MAYA Push dashboard —",
    "— менеджер напишет с реквизитами оплаты": "— the manager will message you with payment details",
    "← К приложениям": "← To apps",
    "↑ выросли": "↑ rose",
    "↓ упали": "↓ dropped",
    "↻ Обновить": "↻ Refresh",
    "⏸ Пауза": "⏸ Pause",
    "▶ Запустить": "▶ Start",
    "✓ Email подтверждён! Аккаунт активирован.": "✓ Email confirmed! Account activated.",
    "✓ Пароль обновлён, вход выполнен": "✓ Password updated, you're signed in",
    "✨ Предложения": "✨ Suggestions",
    "🇺🇸 США": "🇺🇸 USA",
    "🔍 Найти": "🔍 Find",
  };

  const REV = {};
  for (const k in DICT) REV[DICT[k]] = k;

  const norm = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const LS_KEY = 'mayaLang';
  let lang = localStorage.getItem(LS_KEY) || 'ru';
  let observer = null;

  function pick(text) {
    const t = norm(text);
    if (!t) return null;
    if (lang === 'en') return DICT[t] || null;
    return REV[t] || null; // restore RU
  }

  function translateEl(root) {
    // text nodes
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
        return n.nodeValue && /\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    for (let n = tw.nextNode(); n; n = tw.nextNode()) nodes.push(n);
    for (const n of nodes) {
      const repl = pick(n.nodeValue);
      if (repl != null) {
        const lead = (n.nodeValue.match(/^\s*/) || [''])[0];
        const trail = (n.nodeValue.match(/\s*$/) || [''])[0];
        n.nodeValue = lead + repl + trail;
      }
    }
    // placeholder + title attributes
    const els = root.querySelectorAll ? root.querySelectorAll('[placeholder],[title]') : [];
    els.forEach((el) => {
      ['placeholder', 'title'].forEach((attr) => {
        const v = el.getAttribute(attr);
        if (v) { const r = pick(v); if (r != null) el.setAttribute(attr, r); }
      });
    });
  }

  function apply() {
    if (!observer) { translate(); return; }
    observer.disconnect();
    translate();
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  function translate() { translateEl(document.body); }

  window.MayaI18n = {
    get lang() { return lang; },
    set(l) {
      if (l !== 'en' && l !== 'ru') return;
      if (l === lang) return;
      lang = l;
      localStorage.setItem(LS_KEY, l);
      document.documentElement.lang = l;
      // mark active button(s)
      document.querySelectorAll('[data-lang-btn]').forEach((b) =>
        b.classList.toggle('active', b.getAttribute('data-lang-btn') === l));
      apply();
    },
    apply,
  };

  function boot() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-lang-btn]').forEach((b) =>
      b.classList.toggle('active', b.getAttribute('data-lang-btn') === lang));
    let pending = null;
    observer = new MutationObserver(() => {
      if (lang === 'ru') return; // RU is the source; nothing to do
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        observer.disconnect();
        translate();
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }, 120);
    });
    if (lang === 'en') translate();
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
