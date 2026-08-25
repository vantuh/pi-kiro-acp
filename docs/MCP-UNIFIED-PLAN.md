# kiro-acp — ОБ'ЄДНАНИЙ план: модернізація MCP-транспорту

Зводить `MCP-MIGRATION-PLAN.md` (Фази 1–6) в один трек.
**Супроводжує його** — після затвердження старий можна видалити.

Мета: замінити триланковий tool-транспорт (`.mjs`-міст + tools-файл у /tmp + HTTP IPC)
на один in-process **Streamable HTTP MCP** сервер (протокол `2025-06-18`), зареєстрований
у `session/new` як `type:"http"`; взяти детермінований aliasing імен tools.
Не втратити фічі `kiro-acp`.

## Статус (2026-08-25)

Фази 0, 0b, 1, 2, 3, 4, 5, 6 — **зроблено**. Лишилась **Фаза 7** (прибирання мертвого коду
+ фінальний смоук). Рішення зафіксовані в `adr/0001-in-process-http-mcp-tool-transport.md`.
Відкриті пункти Фази 7: `tool-coordinator.ts` не використовується (Фаза 3 залишила
`pendingToolCalls` у `session.ts`) — видалити разом із його тестом; смоук на 2–3 моделях;
перевірка конкурентних сесій і портів на idle-prune та виході pi.

---

## Термінологія: два різні значення «MCP»

- **MCP #1 — внутрішній транспорт (`pi_host`).** Kiro в ACP уміє викликати зовнішні
  інструменти лише як MCP-сервер, тож розширення піднімає локальний MCP-сервер `pi_host`,
  щоб модель Kiro могла викликати **інструменти Pi-розширень** (напр. `peer_list`/`peer_send`).
  Це базова механіка, працює завжди коли треба, щоб Kiro-модель зверталась до pi-tools.
  **Уся ця міграція — про MCP #1.**
- **MCP #2 — passthrough користувацьких `mcp.json`-серверів.** Пересилання власних
  stdio-MCP-серверів користувача в модель Kiro. **Користувач цим НЕ користується →
  викинуто з плану** (колишня Фаза 2b). Не плутати з MCP #1.

**Рішення користувача:** виклик інструментів Pi-розширень з Kiro-моделей **потрібен** →
`pi_host`-міст лишається.

---

## Вимоги користувача (зафіксовано)

1. **Усі виконані моделлю tools видно в pi** — незалежно, виконує їх pi чи Kiro нативно.
2. **Швидко** — без зайвих round-trip'ів для частих операцій.
3. **Kiro бачить і викликає pi-зареєстровані extension-tools, а pi їх виконує** (і показує).

Наслідок = обране раніше **B1 + дзеркало** (див. Рішення B): швидкі нативні fs/bash — у Kiro
(з дзеркалом видимості, Фаза 4); pi extension-tools — через `pi_host`, виконує pi.

### Конкретний набір pi extension-tools (перевірено в середовищі)

Форвардяться в Kiro й виконуються pi:
- `web_search`, `source_check`, `fetch_content`, `get_search_content` — пакет `pi-web-access`
- `herdr_agent` — локальне розширення `herdr-agents`

Правила:
- Фільтр каталогу **динамічний** (`active && source ∉ {builtin, sdk}`) — ці 5 проходять,
  майбутні extension-tools підхопляться самі, без hardcode.
- **Дедуп нативних:** прибрати нативні Kiro `web_search`/`web_fetch` з `allowedTools`
  (перемагають pi-веб-тули); нативні `fs_*`/`execute_bash`/`glob`/`grep` лишити в Kiro.
- Verify (Фаза 5): тест підтверджує, що `sourceInfo.source` цих 5 тулів ≠ `builtin`/`sdk`
  (інакше фільтр їх помилково викине).

---

## Верифіковані факти (Фаза 0 — ЗЕЛЕНА)

Смоук на `kiro-cli 2.16.0` (ручний `initialize` + `session/new` з мок-HTTP-MCP):
- `session/new` з `mcpServers: [{ type:"http", name, url, headers:[Bearer] }]` **прийнято**.
- Kiro під'єднався і викликав `initialize` → `notifications/initialized` → `tools/list`
  на мок-сервері — **усі з `Authorization: Bearer`**.
- `initialize` віддає `agentCapabilities.mcpCapabilities = { http: true, sse: false }`
  → **є чистий feature-gate**, не потрібна сліпа довіра.
- Підтверджено також: `loadSession: true`, `promptCapabilities.image: true`.

**Наслідок:** транспорт через `session/new`+`type:http` життєздатний. Fallback на
agent-config-реєстрацію **не потрібен** (але лишається як аварійний, гейт через
`mcpCapabilities.http`).

### Фаза 0b — форма ACP tool-апдейтів для нативних tools (ЗЕЛЕНА)

Смоук: `session/prompt` із проханням запустити `echo` через нативний bash. Kiro шле:
```jsonc
// session/update → update:
{ "sessionUpdate": "tool_call",
  "toolCallId": "tooluse_...",
  "title": "Running: echo hello-from-kiro",
  "kind": "execute",                       // execute|read|edit|... 
  "rawInput": { "command": "echo hello-from-kiro" },
  "_meta": { "kiro": { "toolName": "shell" } } }   // справжнє ім'я нативного tool
{ "sessionUpdate": "tool_call_update",
  "toolCallId": "tooluse_...",
  "content": [ { "type": "content", "content": { "type": "text", "text": "hello-from-kiro\n" } } ] }
```
Тобто для «дзеркала видимості» є все: `toolCallId` (кореляція), `title` (людський лейбл),
`kind`, `rawInput` (аргументи), `_meta.kiro.toolName` (ім'я), і результат у `tool_call_update.content`.
Зараз `stream.ts` ці апдейти **ігнорує** (слухає лише `agent_*_chunk`).

---

## Зафіксовані рішення

### A — стрімінг (обрано A1)
Прибрати таймер coalescing (`STREAM_COALESCE_MS`, буфер, `flushCoalesced` у `stream.ts`),
форвардити `agent_message_chunk` прямо як `text_delta`. **Зберегти** гілку
`agent_thought_chunk` → thinking-блоки. Простота + нижча латентність, без втрати reasoning-UX.

### B — філософія форварду tools (ОБРАНО: B1 + дзеркало видимості)
Ортогональна до транспорту: HTTP-MCP працює з будь-яким набором. Різниця лише у
фільтрі каталогу + `allowedTools` в agent-config.

Вимога користувача: **швидко І видно** («хто виконує — не важливо; важливо, щоб у pi
було видно, що йде робота»). Тому:

- **Виконання — B1:** Kiro на **нативних** tools (`fs_read/fs_write/execute_bash/glob/grep/web_*`),
  через `pi_host` — лише **активні extension-tools** (Pi-builtin виключені). Різко менше
  round-trip'ів → швидкість (б'є по `LATENCY-FIX-PLAN.md`).
- **Видимість — дзеркало (Фаза 4, вкінці):** нативні tool-виклики Kiro рендеряться в pi як
  **display-only** активність (з `tool_call`/`tool_call_update` — див. Фазу 0b). Pi їх **не
  виконує й не гейтить**, лише показує «що робиться».

Компроміс, який приймаємо свідомо: Pi **не гейтить** fs/bash (їх робить Kiro) — це зміна
безпекової моделі заради швидкості. Видимість зберігається через дзеркало.

Відхилено: **B2** (усі pi-tools через міст) — усе видно й гейтиться, але кожна fs/bash-операція
round-trip'иться (латентність). Технічно повернення тривіальне: фільтр у
`buildForwardedToolCatalog` + `allowedTools` + вимкнути дзеркало.

### C — aliasing (згорнуто в каталог)
Слайс B зі старого плану **скасовано**: aliasing уже є всередині портованого
`tool-catalog.ts` (`isKiroToolName`, `aliasFor`, `pi_<hash>`). Окремий `tool-names.ts`
**не створюємо** — уникаємо двох шарів aliasing (Симптом 3 з обговорення ризиків).

### Транспорт-реєстрація
Основний шлях — `session/new mcpServers: [{type:"http", name:"pi_host", url, headers:[Bearer]}]`,
під гейтом `agentCapabilities.mcpCapabilities.http === true`. Якщо капабіліті нема —
fallback: HTTP-запис у agent-config (in-process сервер той самий, змінюється лише оголошення).

---

## Фаза 1 — Стрімінг (A1) [РОБИМО ПЕРШИМ — низький ризик]

Незалежна від tool-роботи, суто `stream.ts`.

- У `stream.ts` прибрати coalescing (`STREAM_COALESCE_MS`, буфер, `flushCoalesced`),
  форвардити `agent_message_chunk` прямо як `text_delta`.
- Зберегти `agent_thought_chunk` → thinking-блоки і переходи text↔thinking.
- Прибрати метрики coalescing (`avgEmitted*Chars`), лишити TTFT.

verify: `stream.test.ts` + `abort.test.ts` зелені; ручна перевірка reasoning-моделі (видно thinking)
і TTFT.

---

> **Фази 2–5 нижче — це ризиковий tool-forwarding блок (`pi_host` + дзеркало, Рішення B1).**
> Робимо його **вкінці**, після того як стрімінг стабільний. До завершення блоку працює
> старий tool-транспорт (`.mjs`+IPC) — нічого не ламається.

## Фаза 2 — Портувати інфраструктуру tools (ізольовано, з тестами)

Скопіювати й адаптувати під `kiro-acp/`:
- `tool-catalog.ts` — активний каталог, детерміновані `pi_<hash>`-аліаси, fingerprint, diagnostics.
  Фільтр за Рішенням B (B1: лише extension-tools; B2: усі крім 3 meta).
- `tool-bridge.ts` — in-process Streamable HTTP MCP (bearer, Origin/Accept-валідація,
  ліміт тіла 64KB, коди 401/403/406/413, протокол `2025-06-18`).
- `tool-coordinator.ts` — state-machine підвішеного ACP-промпту ↔ наступного ходу Pi.

**Багатосесійна адаптація (критично — Симптом 6):**
- `startToolBridge` + `KiroToolCoordinator` створюються **на кожну `AcpSession`** (свій порт/токен).
- `AcpSession.stop()` і `pruneIdleSessions`/`stopAllSessions` (`session-manager.ts`) **мусять
  закривати** HTTP-сервер сесії → інакше витік портів.
- Зберегти інваріант матчингу: `piToolCallId` має нести префікс `${session.id}-`, щоб
  результат не пішов у чужу сесію (аналог поточного `findToolCallMatch`). Портований
  координатор community цього префікса не знає — **зшити**.

verify: юніт-тести `catalog`, `tool-bridge`, `tool-coordinator`, `framing` зелені.

## Фаза 3 — Замінити IPC+`.mjs` на in-process HTTP MCP у `session.ts`

Видалити:
- in-process IPC HTTP-сервер (`startIpcServer`, `handleIpcRequest`, `/tool/pending`, `ipcPort`, `ipcSecret`)
- `writeTools()` + tools-файл у /tmp
- stdio-міст у `writeAgentCfg()` (блок `mcpServers: { node kiro-acp-bridge.mjs }`)
- файл `kiro-acp-bridge.mjs`

Додати:
- на старті сесії: `startToolBridge({ catalog, onToolCall })`, зберегти `url`/`token`;
- у `session/new` (і в `tryRestorePersistedSession`!) передати
  `mcpServers: [{ type:"http", name:"pi_host", url, headers:[Bearer] }]` — обидва місця, де зараз `[]`;
- agent-config: `allowedTools` = нативні Kiro `fs_read/fs_write/execute_bash/glob/grep`
  (**без** `web_search`/`web_fetch` — їх дає pi через `pi_host`) + `@pi_host`;
  прибрати stdio-`mcpServers`;
- потік: `tools/call` → `onToolCall` → `coordinator.beginCall` → стрім емітить `toolcall_*`
  → Pi виконує → `deliverToolResults` резолвить координатор.

verify: ручний смоук (Kiro викликає extension-tool, Pi виконує, Kiro продовжує);
`lifecycle-cleanup` (respawn після kill) зелений; немає осиротілих портів після `stop`.

## Фаза 4 — Дзеркало видимості нативних tools Kiro (для вимоги «видно»)

Проблема: при B1 нативні fs/bash Kiro виконуються всередині Kiro й у pi **не видно**.

**Перевірено в SDK pi (`pi-ai`, `pi-coding-agent`):**
- Стрім-подій (`AssistantMessageEvent`) — лише `start | text_* | thinking_* | toolcall_* | done | error`.
  **Окремого status/notice/foreign-tool каналу в стрімі НЕМА.** `toolcall_*` прив'язаний до
  виконання (`done: toolUse` змушує pi виконати tool) → **через стрім дзеркало робити не можна**.
- Натомість `ExtensionAPI` дає **позастрімові** UI-канали (в `pi.ui` + `pi.sendMessage`):
  - `pi.ui.setWorkingMessage(msg?)` / `setStatus(key, text?)` / `setWorkingIndicator(...)` —
    транзієнтний індикатор «щось робиться» під час стріму (footer/loader-рядок).
  - `pi.ui.notify(msg, "info")` — сповіщення.
  - `pi.sendMessage({ customType, content, display, details })` (+ реєстрація `MessageRenderer`) —
    **персистентний кастомний запис у транскрипт** (найкраще для «історії» кожного нативного виклику).

**Рішення дзеркала (без стріму):**
- Захопити `pi: ExtensionAPI` при реєстрації (`index.ts`) і прокинути в сесію/стрім (зараз
  `streamKiroAcp` його не отримує).
- На `tool_call` (форма — Фаза 0b): `pi.ui.setWorkingMessage("🔧 " + title)` (транзієнтно) і/або
  `pi.sendMessage({ customType: "kiro_native_tool", display: true, content: title, details: rawInput })`.
- На `tool_call_update`: дописати результат (`content[].content.text`) у той самий запис
  (кореляція за `toolCallId`), очистити working-message.
- **НЕ** емітити `toolcall_start/end` у стрім — це наказ pi «виконай» і зламає цикл (Ризик 7).
- Дзеркало — за прапорцем (вимкнув → чистий B1 без візуалізації; або перемкнув на B2).

verify: ручний смоук — Kiro-модель робить `execute_bash`/`fs_read`; у pi TUI видно активність
(working-message + кастомний запис із результатом); pi tool **не** виконує (немає зайвого
`toolcall`-циклу).

## Фаза 5 — Тести (tool-блок)

- Запуск через pi-bundled `jiti`.
- Портувати/написати: `catalog` (вкл. aliasing + фільтр B), `tool-bridge`,
  `tool-coordinator`, `framing`, `lifecycle-cleanup`,
  `transcript`/context (адаптувати під persistence `kiro-acp`).
- Додати тест на **per-session ізоляцію** координатора/порту (Симптом 6).

verify: увесь набір зелений однією командою.

## Фаза 6 — Документація

- `docs/adr/0001-*.md` — зафіксувати in-process HTTP MCP, feature-gate `mcpCapabilities.http`,
  рішення A1/B.
- Оновити `DEBUG-LOGGING.md` (прибрати `[mcp-bridge]`-логи `.mjs`, додати логи `pi_host`).
- Видалити застарілий `MCP-MIGRATION-PLAN.md`.

## Фаза 7 — Прибирання й фінальна верифікація

- Видалити мертвий код: `kiro-acp-bridge.mjs`, гілки tools-файлу/IPC, невживані імпорти
  (перевірити, що `index.ts` вантажиться — інакше зникне весь провайдер, Симптом 2).
- Прогнати весь тест-набір + ручний смоук на 2–3 моделях (reasoning + швидка).
- Перевірити конкурентні сесії, cleanup портів на idle-prune і на виході Pi.

---

## Реєстр ризиків (із мітигаціями)

| # | Ризик | Мітигація |
|---|---|---|
| 1.1 | `kiro-cli acp` не бере `type:http` | **Знято Фазою 0**; гейт `mcpCapabilities.http` + fallback agent-config |
| 1.2 | tools не видно (забутий `@name` в `allowedTools`) | Фаза 3: додати `@pi_host` у `allowedTools`; тест |
| 2 | extension не вантажиться (висячі імпорти після видалення) | Фаза 7 гейт: підтвердити завантаження `index.ts`; чистий cutover |
| 3 | подвійний aliasing | **Знято**: Слайс B скасовано, aliasing лише в `tool-catalog.ts` |
| 4 | осиротілий stdio-запис на видалений `.mjs` | Фаза 3 видаляє блок повністю |
| 5 | B1 знімає pi-гейт над fs/bash | Свідоме рішення B (швидкість); видимість повертає дзеркало (Фаза 4) |
| 6 | крос-сесійне змішування tool-викликів / витік портів | Per-session bridge+coordinator; префікс `${id}-`; close на stop/prune |
| 7 | дзеркало помилково емітить `toolcall_*` → pi намагається виконати | Дзеркало йде **позастрімово** (`pi.ui`/`pi.sendMessage`), НЕ через `toolcall_*`; за прапорцем |

## Не чіпаємо (фічі `kiro-acp`, яких нема в community)
Багатосесійність; персистентність за fingerprint (`session-persistence.ts`); `--effort`;
обробка зображень у tool-результатах (`cancelAndStartFollowUp`); kill дерева процесів (`process-utils.ts`).

---

## Порядок виконання
**Стрімінг першим, ризиковий tool-forwarding — вкінці:**
Фаза 1 (стрімінг, незалежна) → 2 → 3 → 4 → 5 → 6 → 7.
Фази 2–5 — це `pi_host` tool-блок (B1); до їх завершення працює старий `.mjs`+IPC транспорт.
Блокер знято (Фази 0/0b), старт можливий одразу з Фази 1.
