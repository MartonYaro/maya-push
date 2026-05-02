# MAYA Push — full stack

ASO-кабинет: лендинг + личный кабинет на API + воркер позиций.

## Структура

```
maya/
  server/                  # Node + Express + better-sqlite3
    src/
      index.js             # запуск, статика, cron
      db.js                # схема SQLite (миграция on boot)
      sse.js               # SSE-брокер (per-user)
      middleware/auth.js   # JWT
      routes/auth.js
      routes/apps.js
      routes/keywords.js
      routes/transactions.js
      routes/dashboard.js
      services/apptweak.js       # AppTweak клиент
      services/positionWorker.js # cron-воркер позиций
    .env                   # настройки (см. .env.example)
    data/maya.db           # SQLite (создаётся автоматически)
  web/
    index.html             # лендинг (бывший maya_v7.html)
    dashboard.html         # кабинет (бывший maya_dashboard.html, JS заменён)
    js/api.js              # клиент API + SSE
    js/app.js              # вся логика кабинета
```

## Запуск

```bash
cd maya/server
cp .env.example .env
# вставьте APPTWEAK_API_KEY и поменяйте JWT_SECRET
npm install
npm start
```

Откройте `http://localhost:3000/` (лендинг) и `http://localhost:3000/dashboard` (кабинет).

## Переменные окружения

| key | назначение |
| --- | --- |
| `PORT` | порт (3000) |
| `JWT_SECRET` | секрет JWT — **обязательно поменять на проде** |
| `DB_PATH` | путь к SQLite (`./data/maya.db`) |
| `APPTWEAK_API_KEY` | ключ AppTweak. Если пустой — позиции симулируются |
| `APPTWEAK_BASE_URL` | базовый URL (`https://api.apptweak.com`) |
| `POSITION_CRON` | cron-выражение тика позиций (`0 */6 * * *`) |
| `ALLOW_ORIGIN` | CORS origin (по умолчанию `*`) |

## Поток данных

1. Пользователь регистрируется → получает JWT (хранится в `localStorage` под `maya_token`).
2. Добавляет приложение по URL `https://apps.apple.com/.../id1234567890`. Сервер парсит ID, запрашивает AppTweak метаданные (название, иконка, категория) — если ключ есть.
3. Добавляет ключевые слова (`term`, `target_pos`, `plan`).
4. Каждые 6 часов (cron) `positionWorker`:
   - для каждого активного keyword делает `GET /ios/searches/keyword.json` в AppTweak,
   - находит позицию приложения в выдаче,
   - пишет в `keyword_positions` (time-series),
   - обновляет `keywords.current_pos`,
   - пушит SSE-событие `position.updated`.
5. Заказ установок: `POST /api/keywords/:id/installs {date,count}` создаёт запись в `installs` + транзакцию `spend`. Баланс пересчитывается как `SUM(transactions.amount WHERE status='done')`.
6. Top-up: `POST /api/transactions/topup` создаёт `pending`-транзакцию. Менеджер подтверждает через `POST /api/transactions/:id/confirm` (для демо фронт сам вызывает confirm через 3.5с).

## API кратко

```
POST   /api/auth/register {email,password,name}
POST   /api/auth/login    {email,password}
GET    /api/auth/me

GET    /api/apps
POST   /api/apps {url, name?, country?, category?}
GET    /api/apps/:id
PATCH  /api/apps/:id
DELETE /api/apps/:id

POST   /api/keywords {app_id, term, target_pos?, plan?, daily_cap?}
GET    /api/keywords/by-app/:appId
PATCH  /api/keywords/:id
DELETE /api/keywords/:id
GET    /api/keywords/:id/positions?days=30
GET    /api/keywords/:id/installs
POST   /api/keywords/:id/installs {date,count}    # заказать установки за день

GET    /api/transactions
POST   /api/transactions/topup {amount,method?,comment?}
POST   /api/transactions/:id/confirm

GET    /api/dashboard/summary
POST   /api/dashboard/tick           # ручной запуск воркера позиций

GET    /api/stream?token=<jwt>       # SSE: position.updated, transaction.*, keyword.*, install.scheduled
```

## Что прокинуть на прод

- **Postgres** вместо SQLite — поменять адаптер в `db.js` (`pg`), миграции одни и те же по схеме.
- **Redis + BullMQ** для очередей, если воркеров будет несколько.
- **httpOnly cookie + CSRF** вместо `Authorization: Bearer` (сейчас токен в localStorage — ок для MVP, но XSS-чувствительно).
- **Rate limiting** на `/api/auth/*` (`express-rate-limit`).
- **Менеджерская админка** — отдельный route + `users.role='admin'` для подтверждения top-up.
- **Логи в файл** (`pino`/`winston`) и health-check для оркестратора.

## Что осталось «на потом»

- Графики позиций по дням (uPlot) на странице приложения — данные уже отдаются `/api/keywords/:id/positions`.
- Bulk-import keywords (CSV).
- Email-нотификации при достижении target_pos.
- AppTweak fallback на iTunes Search API для метаданных (бесплатно).
