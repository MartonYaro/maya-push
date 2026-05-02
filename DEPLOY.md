# Деплой на Render (бесплатно)

## Что получишь
- URL вида `https://maya-push.onrender.com` (можно кастомный домен позже)
- Авто-деплой при `git push origin main`
- HTTPS из коробки
- Free план: 750ч/мес, засыпает после 15мин неактивности (просыпается за ~30 сек на первый запрос)

## Шаги

### 1) Создай репозиторий на GitHub
- Зайди на https://github.com/new
- Имя: `maya-push` (или любое)
- Тип: Public **или** Private — оба работают
- НЕ ставь галочки «Add README / .gitignore / license» — у нас уже всё есть
- Жми «Create repository»
- Скопируй URL вида `https://github.com/<твой-логин>/maya-push.git`

### 2) Запушь код
```bash
cd "C:/Users/BeGraphics/Downloads/claude code/maya"
git remote add origin https://github.com/<твой-логин>/maya-push.git
git branch -M main
git push -u origin main
```
При первом пуше откроется окно авторизации GitHub — войди.

### 3) Подключи Render
- Зайди на https://render.com и войди через GitHub (одна кнопка)
- В дашборде жми **New → Blueprint**
- Выбери репозиторий `maya-push`
- Render увидит `render.yaml` и сам предложит создать сервис → жми **Apply**
- В блоке env vars вставь свой ключ AppTweak:
  - `APPTWEAK_API_KEY` = `TzbLxbxfPln9Pez7vZGeIr2dB04`
- Жми **Apply** ещё раз

### 4) Жди ~3–5 минут первой сборки
Когда статус станет «Live» — открой URL из шапки сервиса. Кабинет, лендинг, AppTweak, SSE — всё должно работать.

### 5) Кастомный домен (опционально)
Settings → Custom Domain → добавь свой → Render даст инструкции для DNS (CNAME).

## Известные ограничения free плана
- **SQLite сбрасывается** при каждом перезапуске/деплое (на free нет persistent disk).
  Для прода добавим Render Postgres (free 90 дней) — пишу в `db.js` адаптер, переключение через `DATABASE_URL`.
- Cold-start ~30 сек после 15 мин простоя.
- Один процесс, без масштабирования.

Этого хватает для «отдать людям поклацать». Когда будут реальные клиенты — апгрейд $7/мес + Postgres.

## Обновления
Любой `git push origin main` → Render автоматически собирает и деплоит.
