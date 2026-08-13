# Установка dsh-browser-bridge на другой компьютер

Плагин **dsh-browser-bridge** даёт агентам DeepSeek Harness доступ к вашему
браузеру (аналог Kimi WebBridge / расширения Claude): инструменты `browser_*`
(открыть страницу, кликнуть, ввести текст, снять скриншот и т.д.) работают через
браузерное расширение, подключённое к серверу dsh по локальному WebSocket.

Установка состоит из двух частей:

1. **Плагин** — ставится в профиль dsh (на этом компьютере).
2. **Расширение** — загружается в ваш браузер (Chrome / Edge / Яндекс).

> Требования: на компьютере уже установлен и хотя бы один раз запускался
> `dsh web` (чтобы профиль был инициализирован), установлен Node.js.

---

## 1. Что нужно перенести

Скопируйте с машины, где плагин уже готов, папку целиком
(или распакуйте архив `dsh-browser-bridge-install.zip`):

```
dsh-browser-bridge/
├── install-plugin.ps1   # автоустановщик (рекомендуется)
├── lib/                 # код плагина (серверная часть)
├── package.json         # манифест пакета плагина
└── extension/           # браузерное расширение (Manifest V3)
    ├── manifest.json
    ├── background.js
    ├── content.js
    ├── popup.html / popup.js
    ├── options.html / options.js
    └── icons/
```

---

## 2. Установка плагина

### Способ А — автоматический (рекомендуется)

Откройте PowerShell в папке `dsh-browser-bridge` и выполните:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-plugin.ps1
```

Скрипт сам:
- найдёт каталог профилей (`%USERPROFILE%\.dsh\profiles` или `$env:DSH_HOME`);
- скопирует пакет в `node_modules` профиля (туда же, где лежат `@deepseek-ai/*`);
- пропишет строку `browser-bridge` в `cordis.patch.yml` профиля `web`;
- добавит зависимость в `package.json` профиля (необязательно, но наглядно).

Скрипт безопасен для повторного запуска (идемпотентен).

### Способ Б — вручную

1. Найдите каталог профилей dsh:
   ```powershell
   $home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
   ```
2. Скопируйте пакет туда, где лежат остальные пакеты dsh
   (обычно `%USERPROFILE%\.dsh\profiles\node_modules`):
   ```powershell
   Copy-Item .\lib "$home\profiles\node_modules\dsh-browser-bridge" -Recurse
   Copy-Item .\package.json "$home\profiles\node_modules\dsh-browser-bridge"
   ```
   > Если на вашей машине пакеты лежат в `profiles\web\node_modules` — копируйте туда.
3. Зарегистрируйте плагин: откройте
   `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` и добавьте в конец:

   ```yaml
   - insert:
       - id: browser-bridge
         name: 'dsh-browser-bridge'
         config:
           path: /bridge
           commandTimeoutMs: 60000
   ```

   (Если файл всё ещё содержит пустой список `[]` — замените `[]` этим блоком.)

4. (Необязательно) в `%USERPROFILE%\.dsh\profiles\web\package.json` добавьте
   в `dependencies`: `"dsh-browser-bridge": "0.1.0"`.

---

## 3. Перезапуск сервера dsh

Плагин загружается при старте, поэтому **перезапустите `dsh web`**:
остановите текущий процесс и запустите заново:

```powershell
dsh web
```

Интерфейс вернётся на тот же адрес (по умолчанию http://127.0.0.1:3080).

---

## 4. Проверка, что плагин активен

1. HTTP-эндпоинт (отвечает сам плагин):
   ```powershell
   Invoke-WebRequest http://127.0.0.1:3080/bridge/info -UseBasicParsing
   ```
   Ожидаем:
   ```json
   {"name":"dsh-browser-bridge","protocol":1,"ws":"ws://127.0.0.1:3080/bridge","connected":false}
   ```
   Если порт другой (например, запускали с `--port 8080`) — подставьте его.

2. Состав профиля:
   ```powershell
   dsh --profile web --dump-config | Select-String -Pattern "browser-bridge"
   ```

3. В чате попросите агента: «Проверь связь с браузером» — он вызовет
   `browser_status` и сообщит, подключено ли расширение.

---

## 5. Установка расширения в браузер

Работает в Chromium-браузерах: **Chrome, Edge, Яндекс Браузер**.

1. Откройте страницу расширений:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Яндекс: `browser://extensions`
2. Включите **Режим разработчика** (переключатель в правом верхнем углу).
3. Нажмите **Загрузить распакованное расширение** и выберите папку
   `extension` из комплекта (именно папку с `manifest.json` внутри).
4. Нажмите на иконку расширения — попап должен показать
   **Connected to DeepSeek Harness** и адрес сервера.

Если dsh запущен на нестандартном порту: откройте **Options** расширения,
укажите адрес `ws://127.0.0.1:<порт>/bridge` и нажмите **Test connection**.

После этого в любом чате можно давать агенту команды вида:

> Открой example.com, прочитай страницу и кликни первую ссылку.

---

## 6. Как это работает (кратко)

```
┌──────────────────────────┐        WebSocket          ┌────────────────────────┐
│ DeepSeek Harness (dsh)   │   ws://127.0.0.1:3080/    │ Ваш браузер            │
│ browser_* инструменты    │        bridge             │ DSH Browser Bridge     │
│ (плагин, серверная часть)│ ◄───────────────────────► │ (расширение, MV3)      │
└──────────────────────────┘  команды / ответы          └────────────────────────┘
```

- Плагин открывает WebSocket-эндпоинт `/bridge` на веб-сервере dsh и
  регистрирует инструменты `browser_status`, `browser_navigate`,
  `browser_snapshot`, `browser_read_page`, `browser_click`, `browser_type`,
  `browser_press`, `browser_scroll`, `browser_wait`, `browser_list_tabs`,
  `browser_activate_tab`, `browser_screenshot`, `browser_eval`.
- Расширение держит соединение, исполняет команды в браузере
  (вкладки, DOM, клики, ввод, скриншоты) и возвращает результаты.
- Скриншоты сохраняются в `%USERPROFILE%\.dsh\browser-bridge\`.

---

## 7. Удаление

1. Удалите папку `%USERPROFILE%\.dsh\profiles\node_modules\dsh-browser-bridge`
   (или `...\profiles\web\node_modules\dsh-browser-bridge`).
2. Уберите блок `- insert:` с `id: browser-bridge` из
   `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`.
3. Перезапустите `dsh web`.
4. В браузере: `chrome://extensions` → удалите расширение DSH Browser Bridge.

---

## 8. Устранение неполадок

| Симптом | Причина и решение |
|---|---|
| `/bridge/info` не отвечает (404/ошибка) | Плагин не загрузился: проверьте шаг 3 (перезапуск), затем `dsh --profile web --dump-config` — строка `browser-bridge` должна быть в конце списка. |
| Агент говорит «browser not connected» | Расширение не загружено или не подключено: см. шаг 5; проверьте попап расширения (должен быть Connected). |
| Расширение не подключается, порт другой | В Options расширения укажите `ws://127.0.0.1:<порт>/bridge` и нажмите Test connection. |
| После перезапуска dsh расширение «отвалилось» | Нормально: расширение переподключается автоматически с задержкой до ~30 с (экспоненциальный backoff). |
| `browser_*` не работает на страницах `chrome://`, магазина, `about:` | Браузер запрещает расширениям доступ к служебным страницам — сначала откройте обычный сайт (`browser_navigate`). |
| Агент не видит инструменты `browser_*` | Инструменты регистрируются на хосте: убедитесь, что сервер перезапущен после установки плагина. |
| `dsh web` падает сразу после установки: `SyntaxError: Unexpected token '﻿' ... not valid JSON` в `readProfileManifest` | Установщик старой версии записал `package.json` профиля с BOM-символом (PowerShell 5.1 `Set-Content -Encoding UTF8` добавляет BOM, который `JSON.parse` не принимает). **Решение:** обновите `install-plugin.ps1` из репозитория (`git pull`) и запустите ещё раз — он сам уберёт BOM. Либо вручную откройте `%USERPROFILE%\.dsh\profiles\web\package.json` (и `cordis.patch.yml`) в редакторе (VS Code / Notepad++) и сохраните как «UTF-8 без BOM». |

---

## Заметки по безопасности

- Мост слушает только `127.0.0.1` и не имеет аутентификации: любой локальный
  процесс мог бы подключиться к `/bridge` и управлять браузером. Относитесь к
  нему как к доступу уровня оболочки.
- `browser_eval` выполняет JavaScript в страницах — давайте его только
  доверенным агентам.
- Расширение имеет разрешения `<all_urls>` (нужны для чтения URL вкладок и
  действий на любой странице), но общается **только** с настроенным локальным
  адресом `ws://127.0.0.1:.../bridge`.
