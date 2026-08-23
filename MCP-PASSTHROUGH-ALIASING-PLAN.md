# kiro-acp — план портування: user `mcp.json` passthrough + tool-name aliasing

Джерело ідей: `omp/.omp/agent/extensions/pi-kiro-models/` (community). Портуємо адаптовано
під архітектуру `kiro-acp` (агент-конфіг + stdio-MCP міст, а не in-process HTTP MCP).

**Problem:** `kiro-acp` не форвардить користувацькі `mcp.json`-сервери в Kiro і не аліасить
Kiro-несумісні імена tools (може мовчки ламатись на іменах із `.`/`/`).

---

## Слайс A — passthrough user `mcp.json`

Ключова відмінність від community: `kiro-acp` під'єднує свій pi-tools-міст **не** через
`session/new mcpServers` (там `[]` — див. `ensureBackendSession`, `tryRestorePersistedSession`),
а через `mcpServers`-мапу в тимчасовому агент-конфізі (`writeAgentCfg`, `session.ts`),
з `includeMcpJson: false`. Тому user-сервери додаємо **тим самим механізмом** — в агент-конфіг,
а не в `session/new`. Один механізм, менше сюрпризів.

### Зміни
1. Новий файл `mcp-discovery.ts` — портувати `discoverMcpServers(cwd)` з `pi-kiro-models/index.ts`:
   - читає `~/.config/kiro/settings/mcp.json`, `~/.kiro/settings/mcp.json`, `<cwd>/.kiro/settings/mcp.json`;
   - union by name (workspace перекриває global), пропуск `disabled:true` і не-stdio (без `command`);
   - повертає `{name, command, args, env}`.
2. `session.ts` → `writeAgentCfg`:
   - викликати `discoverMcpServers(this.cwd)`;
   - у `config.mcpServers` додати кожен сервер поряд із bridge: `{ [name]: {command, args, env, cwd: this.cwd} }`
     (env як обʼєкт — формат Kiro-агента, не ACP-масив);
   - додати `@<name>` у `config.tools` і `config.allowedTools` поряд із `@${mcpName}`.
3. Лог у `ensureStarted`: скільки user-серверів форварднуто (для smoke-діагностики).

### Рішення щодо env
Агент-конфіг Kiro бере `env` як обʼєкт `{KEY: "val"}` (як у самій `mcp.json`), не як
ACP-масив `[{name,value}]`. Тобто в `discoverMcpServers` env лишаємо сирим обʼєктом,
конвертацію не робимо (на відміну від community, що готує ACP-формат для `session/new`).

### Простіша альтернатива (варта одного smoke перед реалізацією)
Виставити `includeMcpJson: true` в `writeAgentCfg` — тоді `kiro-cli` нативно підхопить mcp.json.
Ризик: агент стартує з `cwd: agentRootPath` (temp-дир), тож workspace-`mcp.json` з реального
`cwd` може не зчитатись; `allowedTools` теж доведеться розширити. Через цю невизначеність
основним лишаємо явний discovery, а `includeMcpJson` перевіримо як швидкий шлях.

---

## Слайс B — aliasing Kiro-несумісних імен tools

Потік у `kiro-acp`: `writeTools` (session.ts) пише `name: t.name` у tools.json → міст `.mjs`
віддає їх Kiro і форвардить `tools/call` на IPC `/tool/pending` з `toolName: <імʼя від Kiro>` →
`handleIpcRequest` кладе `PendingToolCall.toolName` → `findToolCallMatch` звіряє з `tr.toolName`
(pi-імʼя). Отже аліас треба ввести в `writeTools` і **розгорнути назад** на вході IPC.

### Зміни
1. Новий файл `tool-names.ts` — портувати з `tool-catalog.ts`:
   `isKiroToolName` (regex `^[A-Za-z0-9_-]+$`, ≤64), `aliasFor(piName, used)`
   (sha256 → `pi_<hex>`, розширення довжини при колізії).
2. `session.ts`, поле класу: `private toolAliases = new Map<string, string>()  // kiroName → piName`.
3. `writeTools`:
   - після фільтра `EXCLUDED_TOOLS` побудувати мапу: валідні імена лишаються, невалідні → `aliasFor`;
   - у JSON писати `name: kiroName`;
   - заповнити `this.toolAliases` (kiroName→piName); валідні теж кладемо (identity) для однакового шляху.
4. `handleIpcRequest` `/tool/pending`: `const toolName = this.toolAliases.get(rawToolName) ?? rawToolName;`
   — далі як зараз (pi отримає pi-імʼя, `findToolCallMatch` збіжиться, `stream.ts` емітить правильний
   `toolCall.name`).

### Інваріант
Детермінований sha256-аліас критичний: `writeTools` викликається на кожен reuse/ensureStarted,
мапа мусить бути стабільною між перезаписами.

Зауваж: більшість pi-tools уже валідні (snake_case), тож це запобіжник для імен із `.`/`/`
(напр. деякі MCP-tools). Ризик реального бага малий, але мовчазний злам на несумісному
імені — саме те, що community закриває.

---

## Слайс C — тести (закриваємо «нуль тестів»)

`kiro-acp` не має тест-інфри. Додаємо `test/` з запуском через pi-bundled `jiti`.
- `test/tool-names.test.ts` — чисті функції: валідні лишаються, невалідні → стабільний `pi_*`,
  колізії розводяться. Fail-on-bug, детермінізм.
- `test/mcp-discovery.test.ts` — union/override, пропуск `disabled` і не-stdio; на тимчасових
  fixture-файлах.

Обидва — чисті, ізольовані, без спавну `kiro-cli`. Runtime-логіку (session/stream) не покриваємо:
занадто зчеплено, потребує мок-ACP — поза обсягом цих двох фіч.

---

## Верифікація (smoke, не лише юніти)
1. Прописати тестовий stdio-сервер у `~/.kiro/settings/mcp.json`, запустити `pi` з kiro-моделлю,
   у логах (`PI_KIRO_ACP_DEBUG=1`) побачити форвард N серверів; попросити модель викликати його tool.
2. Тимчасово зареєструвати pi-extension-tool із крапкою в імені → підтвердити, що Kiro бачить
   `pi_<hex>`, а виклик виконується pi-інструментом (лог `delivering tool result`, без `UNMATCHED`).

Прибрати тестові конфіги після.

---

## Порядок і обсяг
A і B незалежні → можна паралельно (окремі файли, точки дотику в `session.ts` не перетинаються:
`writeAgentCfg` vs `writeTools`/`handleIpcRequest`). C залежить від A/B.

Bump MCP-протоколу до `2025-06-18` та Origin/Accept-валідація мосту навмисно **не** включені —
це окрема робота по мосту, не потрібна для цих двох фіч.

### Файли
- новий `mcp-discovery.ts`
- новий `tool-names.ts`
- зміни в `session.ts` (`writeAgentCfg`, `writeTools`, `handleIpcRequest`, поле `toolAliases`)
- новий `test/`
