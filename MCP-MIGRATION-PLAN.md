# План: перенести круте з `pi-kiro-models` у `kiro-acp`

Мета: перейти на новий MCP-стандарт (in-process Streamable HTTP MCP замість
зовнішнього `.mjs`-моста + tools-файлу + HTTP IPC) і взяти прямий стрімінг
тексту з `pi-kiro-models`, не втрачаючи фіч `kiro-acp`.

## Поточна архітектура `kiro-acp` (те, що міняємо)

- Бінарник: `kiro-cli acp --agent <name> --trust-all-tools [--effort ...]` (`session.ts:344`)
- Інструменти передаються **не через `session/new`** (там `mcpServers: []`, рядки 476/502),
  а через **agent-config** (`writeAgentCfg`, ~1010), який оголошує **stdio** MCP-сервер:
  `node kiro-acp-bridge.mjs --tools <tools.json>`
- `.mjs` читає `tools-<id>.json` з `/tmp` і релеїть виклики назад через **HTTP IPC**
  у in-process сервер сесії (`/tool/pending`, bearer = `ipcSecret`)
- Форвардяться **всі** Pi-інструменти крім 3 meta (`Agent`, `get_subagent_result`, `steer_subagent`)

## Ціль (стиль `pi-kiro-models`)

- In-process **Streamable HTTP MCP** сервер (протокол `2025-06-18`), зареєстрований
  прямо в `session/new` як `{ type: "http", name: "pi_host", url, headers: [Bearer] }`
- Жодного `.mjs`-процесу, жодного tools-файлу, жодного файлового watcher-а

---

## Рішення до старту

### Рішення A — стрімінг і thinking-блоки

- **A1 (обрано):** взяти прямий forming тексту з `pi-kiro-models` (прибрати таймер
  coalescing на 24 мс), але **зберегти** гілку thinking-блоків. Простота + нижча
  латентність без втрати reasoning-UX.
- A2: повний порт — прибрати і coalescing, і thinking-стрім (регрес для reasoning).

### Рішення B — політика форварду інструментів

- **B1 (обрано):** перейти на модель `pi-kiro-models` — Kiro користується нативними
  інструментами (`fs_read/fs_write/execute_bash/...`), через `pi_host` йдуть лише
  **активні extension-tools** (виключити Pi-builtins). Узгоджено з ADR 0001.
- B2: зберегти поточну поведінку (форвардити все крім meta).

> Дефолт плану: **A1 + B1**. Підтвердити перед стартом.

---

## Фаза 0 — Верифікація (блокер)

Ризик: `pi-kiro-models` використовує `kiro-cli-chat` і кладе HTTP-MCP у `session/new`.
`kiro-acp` використовує `kiro-cli` і кладе MCP в agent-config. Довести, що
`kiro-cli acp` приймає `type: "http"` MCP-сервери в `session/new`.

- Крок: запустити `kiro-cli acp` вручну, зробити `initialize` + `session/new` з тестовим
  `{ type:"http", name:"pi_host", url, headers }` на локальний мок-MCP-сервер;
  перевірити, що `tools/list` доходить.
- verify: мок отримав `tools/list` з Bearer-заголовком.
- Fallback якщо не підтримується: лишити реєстрацію через agent-config, але вказати
  там **HTTP** MCP (`type:"http"`) замість stdio-моста. In-process сервер лишається,
  змінюється лише спосіб оголошення.

Без зеленого результату цієї фази решту не починати.

## Фаза 1 — Портувати інфраструктуру інструментів (ізольовано, з тестами)

Скопіювати й адаптувати три модулі під `kiro-acp/`:

- `tool-catalog.ts` — активний каталог, детерміновані аліаси (`pi_<hash>`) для
  несумісних імен, fingerprint, diagnostics. Адаптувати фільтрацію під Рішення B.
- `tool-bridge.ts` — in-process Streamable HTTP MCP (bearer, Origin/Accept-валідація,
  ліміт тіла 64KB, коди 401/403/406/413).
- `tool-coordinator.ts` — state-machine підвішеного ACP-промпту ↔ наступного ходу Pi.

Особливість: `kiro-acp` **багатосесійний**, тож `startToolBridge` + `KiroToolCoordinator`
створюються **на кожну `AcpSession`** (свій порт/токен).

- verify: юніт-тести `catalog`, `tool-bridge`, `tool-coordinator`, `framing` зелені.

## Фаза 2 — Замінити IPC + `.mjs` на in-process HTTP MCP у `session.ts`

Видалити:

- in-process IPC HTTP-сервер (`createServer`, `/tool/pending`, `ipcPort`, `ipcSecret`)
- `writeTools()` + tools-файл у `/tmp`
- stdio-міст у `writeAgentCfg()` (блок `mcpServers: { node kiro-acp-bridge.mjs }`)
- файл `kiro-acp-bridge.mjs`

Додати:

- на старті сесії: `startToolBridge({ catalog, onToolCall })`, зберегти `url`/`token`
- у `session/new` передати `mcpServers: [{ type:"http", name:"pi_host", url, headers:[Bearer] }]`
- `agent-config` спростити: лишити `@pi_host` у `tools`/`allowedTools`, прибрати stdio-`mcpServers`
- перепідключити потік: `tools/call` → `onToolCall` → `coordinator.beginCall` → стрім
  емітить `toolcall_*` → Pi виконує → `deliverToolResults` резолвить координатор

- verify: ручний смоук (Kiro викликає extension-tool, Pi виконує, Kiro продовжує);
  `lifecycle-cleanup` тест (respawn після kill) зелений.

## Фаза 3 — Портувати стрімінг тексту (Рішення A1)

- У `stream.ts` прибрати таймер coalescing (`STREAM_COALESCE_MS`, буфер, `flushCoalesced`),
  форвардити `agent_message_chunk` прямо як `text_delta`.
- **Зберегти** гілку `agent_thought_chunk` → thinking-блоки і переходи text↔thinking.
- Прибрати метрики coalescing (`avgEmittedTextChars` тощо), лишити TTFT-метрики.

- verify: `stream.test.ts` + `abort.test.ts` зелені; ручна перевірка reasoning-моделі
  (видно thinking) і швидкість першого токена.

## Фаза 4 — Тести

- Налаштувати запуск тестів через jiti з пакета pi.
- Портувати: `framing`, `catalog`, `tool-bridge`, `tool-coordinator`, `stream`, `abort`,
  `lifecycle-cleanup`, `transcript`/context (адаптувати під persistence `kiro-acp`).
- verify: увесь набір зелений однією командою.

## Фаза 5 — Документація

- Додати `docs/adr/0001-*.md` — зафіксувати перехід на in-process HTTP MCP і причини.
- Оновити `DEBUG-LOGGING.md` (прибрати `[mcp-bridge]`-логи `.mjs`).

## Фаза 6 — Прибирання й фінальна верифікація

- Видалити мертвий код: `kiro-acp-bridge.mjs`, гілки tools-файлу/IPC, невживані імпорти.
- Прогнати весь тест-набір + ручний смоук на 2-3 моделях (reasoning + швидка),
  перевірити конкурентні сесії й cleanup на виході Pi.

---

## Не чіпаємо (фічі `kiro-acp`, яких нема в `pi-kiro-models`)

Багатосесійність; персистентність сесій за fingerprint; `--effort` рівні;
обробка зображень у tool-результатах; kill дерева процесів.
