# npm-winccoa-debugger — Development Instructions

## Was ist dieses Repo?

**Paket**: `@winccoa-tools-pack/winccoa-debug-adapter`  
**Version**: `0.1.0`  
**Branch**: `feature/initial_setup`  
**Zweck**: TypeScript-Bibliothek + CLI, die als **Debug Adapter** für WinCC OA CTRL-Skripte
dient. Implementiert das Debug Adapter Protocol (DAP) und kommuniziert mit WinCC OA über
Datapoints (`_CtrlDebug_CTRL_N._CtrlDebug.Command/Result`).

> **Stand: April 2026**  
> Unit-Tests: ✅ vollständig grün (`npm run test:unit`)  
> Integration-Tests: Im VS Code Extension-Host (`vscode-winccoa-debugger` Repo, `npm run test:e2e:*`)  
> Aktiv offen: Library-BP feuert nicht (Details in Known Issues)

---

## Architektur

```text
src/
├── adapter/
│   ├── WinCCDebugSession.ts     # Haupt-DAP-Session (DebugSession-Subklasse)
│   ├── BreakpointManager.ts     # (reserviert — noch nicht aktiv genutzt)
│   ├── ThreadManager.ts         # (reserviert)
│   └── VariableManager.ts       # (reserviert)
├── connection/
│   └── DatapointClient.ts       # WinCC OA DP-Kommunikation (dpConnect/dpSet/sendCommand)
├── cli.ts                       # Einstiegspunkt: node debugAdapter.js
└── index.ts                     # Öffentliche Exporte
```

Die drei Manager-Klassen sind reserviert — die Logik liegt derzeit vollständig in
`WinCCDebugSession.ts`.

### Startmodus (Produktion via pmon)

```
node | once | 30 | 1 | 0 | debugAdapter.js
```

- WinCC OA startet den Adapter als `node`-Manager in der `progs`-Datei
- WinCC OA übergibt automatisch `-proj <name> -host <h> -port <p> -num <n>` als `process.argv`
- `cli.ts` startet TCP-Modus auf Port **7474**
- VS Code verbindet via `DebugAdapterServer(7474)`

---

## WinCC OA DP-Protokoll (WinCC OA 3.21, verifiziert)

### Kommunikationskanal

| Richtung | Datapoint | Inhalt |
|---|---|---|
| VS Code → WinCC OA | `_CtrlDebug_CTRL_N._CtrlDebug.Command` | JSON `{"id":"<uuid>","cmd":"..."}` |
| WinCC OA → VS Code | `_CtrlDebug_CTRL_N._CtrlDebug.Result` | `["<uuid>","OK",...]` (solicited) oder `["line: N",...]` (unsolicited BP-Hit) |

### Debug-Commands (korrekte Namen aus `CTRLdebugger.ctl`)

| Befehl | Funktion |
|---|---|
| `step over` | Step Over (nächste Zeile auf gleichem Level) |
| `step in` | Step Into (läuft bis zum nächsten **BP** — nicht Zeile für Zeile!) |
| `step out` | Step Out (kehrt zurück in Caller-Frame, stoppt an nächster Zeile) |
| `c` / `cont` | Continue |
| `b` / `break` | Pause (benötigt vorher `script N` + `thread N` Kontext) |
| `info scripts` | Registrierte Script-IDs ermitteln |
| `script N` | Aktiven Script-Kontext setzen |
| `thread N` | Aktiven Thread-Kontext setzen |
| `bt` | Backtrace / Call-Stack |
| `locals` | Lokale Variablen |
| `breakpoint {...}` | Breakpoint setzen (JSON: scriptId, scopeId, lib, line) |
| `delete-all` | Alle BPs löschen |

> ⚠️ **Frühere falsche Namen (deprecated)**: `next` → `step over`, `step` → `step in`,
> `finish` → `step out`

### Two-Phase Response-Protokoll (Step-Commands)

`step in`, `step out`, `step over` liefern **zwei** Responses mit derselben Command-ID:

1. **Phase 1**: `["<uuid>", "OK"]` — Bestätigung; Pending-Entry **nicht** auflösen
2. **Phase 2**: `["<uuid>", "line: N", "ScriptId: X", "ThreadId: Y (stopped)"]` — auflösen + StoppedEvent emittieren

`DatapointClient.ts` Konstanten:

```typescript
static readonly STEP_CMD_RE = /^(step in|step out|step over)/;
static readonly EXEC_CMD_RE = /^(cont|c|step in|step out|step over|b|break)/;
```

Phase 1 wird mit `return` (ohne resolve) behandelt; Phase 2 löst `clearTimeout + delete
pending + emit 'message' + resolve` aus.

### WinCC OA 3.21 Step-Semantik (verifiziert)

| Command | Verhalten |
|---|---|
| `step over` | Stoppt an **nächster Zeile** (auch ohne gesetzten BP) |
| `step in` | Läuft bis zum **nächsten gesetzten BP** — nicht Zeile für Zeile! |
| `step out` | Kehrt aus aktueller Funktion zurück, stoppt an **nächster Zeile** im Caller |

`step in` verhält sich wie `cont` mit Function-Entry-Tracking. Im Test reicht es,
`reason === 'step'` und `stoppedLine > 0` zu prüfen.

### Stopp-Event-Format

```
msg[0] = "line: N"               — Zeile des Stopps
msg[1] = "lib: LibId: -1 ..."    — Lib-Info (libId=-1 = Hauptskript)
msg[2] = "ScriptId: N"           — numerische Script-ID
msg[3] = "ScopeId: N"            — Scope (0 = main)
msg[4] = "ThreadId: N (stopped)" — Thread-ID + Status
```

---

## WinCCDebugSession — Key Fields & Mechanismen

### Zustandsfelder

| Feld | Typ | Bedeutung |
|---|---|---|
| `stopState` | `{scriptId, threadId, scopeId, libId?}\|null` | Kontext des letzten Stopps |
| `pendingStopReason` | `'step'\|'pause'\|null` | In-Flight-Step/Pause → bypasses Spurious-Stop-Filter |
| `stopOnEntryPending` | `boolean` | DebugBreak() / stopOnEntry wartet noch auf configurationDone |
| `bpRegistry` | `Map<path, line[]>` | Alle aktiven BPs aus VS Code |
| `scriptIdToPath` | `Map<scriptId, path>` | Rückwärts-Mapping für Spurious-Stop-Filter |
| `libIndexCache` | `Map<basename, {scriptId, libIndex}>` | Cache für Library-BP-Probe-Ergebnisse |
| `pendingBpRequests` | `Map<path, [{bp, line}]>` | BPs die noch nicht gesetzt werden konnten |
| `pendingBpRetryTimer` | `ReturnType<setInterval>` | 500ms-Timer für BP-Retry |
| `pendingBpRetryInFlight` | `boolean` | Verhindert parallele Retry-Ausführungen |
| `bpOperationQueue` | `Promise<void>` | Serialisiert alle BP-Set-Operationen |
| `static MAX_LIB_PROBE` | `8` | Maximale Library-Index-Probe Tiefe |

### attachToStopContext()

Setzt `script N` + `thread N` vor jedem Step/Pause-Befehl:

```typescript
private async attachToStopContext(client: DatapointClient): Promise<void> {
    if (!this.stopState) return;
    await client.sendCommand(`script ${this.stopState.scriptId}`);
    await client.sendCommand(`thread ${this.stopState.threadId}`);
}
```

Aufgerufen vor: `step over`, `step in`, `step out`, `b` (pause).  
`continueRequest` löscht `stopState` **nicht** — Kontext bleibt nach Continue erhalten.

### DebugBreak() / Pause-Pattern

Für `pause` braucht WinCC OA einen etablierten `stopState` (script + thread Kontext).  
Zuverlässiges Pattern:

1. CTRL-Skript beginnt mit `DebugBreak()` + Manager-Flag `-dbg CTRL_DEBUGBREAK`
2. Test: `startManager` → 2s warten → `attach` mit `stopOnEntry:true`
3. `stopState` wird aus dem DebugBreak-Stop befüllt
4. `continue` → `pause` funktioniert zuverlässig

### Spurious-Stop-Filter

Bei Stopp-Events an nicht registrierten Zeilen (BP gelöscht, aber WinCC OA hat noch ein
queued Event):

- **Aktiv wenn**: `pendingStopReason === null` AND `libId < 0` AND `scriptIdToPath` kennt
  `scriptId`
- **Aktion**: automatisch `cont` senden, kein `StoppedEvent` an VS Code

### Breakpoint-Mechanismus

1. `setBreakPointsRequest`: `delete-all` + alle BPs aus `bpRegistry` neu setzen
2. `bpOperationQueue`: serialisiert concurrent VS Code Requests (eine Anfrage je Datei)
3. Wenn `findScriptId()` → `-1`: BP in `pendingBpRequests` ablegen
4. `retryPendingBreakpoints()`: aufgerufen bei jedem `stopped`-Event + alle 500ms via Timer
5. Library-BPs: Probe via `lib:0..MAX_LIB_PROBE` um korrekten libIndex zu finden
6. Library-BPs werden **nicht** durch `reapplyAllBreakpoints` gesetzt — nur via Retry-Pfad

---

## Test-Struktur

### Unit-Tests (`test/unit/`)

| Datei | Inhalt |
|---|---|
| `WinCCDebugSession.test.ts` | DAP-Handler mit gemocktem DatapointClient |
| `DatapointClient.test.ts` | DP-Kommunikation, Two-Phase-Response, Regex |
| `variable-parsing.test.ts` | WinCC OA 3.21 Variablen-Format-Parser inkl. Structs |

### Integration-Tests (`test/integration/`)

Laufen als Node-Prozess — kein VS Code Extension-Host erforderlich:

| Datei | Beschreibung |
|---|---|
| `debugger-e2e.test.ts` | Grundlegender Attach-Test |
| `debugger-bp-cycle.test.ts` | BP set/hit/continue Zyklen |
| `debugger-stop-on-entry.test.ts` | stopOnEntry / DebugBreak()-Modus |
| `debugger-step-commands.test.ts` | step-next/into/out + pause |
| `debugger-library-bp.test.ts` | BPs in `#uses` Library-Dateien |
| `debugger-adapter-lib-bp-session.test.ts` | Adapter-level Lib-BP Regression |
| `debugger-adapter-race-condition.test.ts` | Race-Condition Regression |
| `debugger-spurious-stops.test.ts` | Spurious-Stop-Unterdrückung |
| `DatapointClient-integration.test.ts` | DatapointClient mit echter WinCC OA Verbindung |
| `cli-help.test.ts` | CLI `--help` / `--version` Smoke-Test |

**Ausführung**: `npm run test:integration` (benötigt laufenden WinCC OA)  
Die vollständigen E2E-Tests laufen im `vscode-winccoa-debugger` Repo.

### Fixture-Projekt (`test/fixtures/projects/runnable/`)

```
config/
  progs         # CTRL-Manager (-num 2..7) + node debugAdapter.js (once)
  config        # WinCC OA Projektkonfiguration
scripts/
  bp_basic_loop.ctl         # -num 2 | once | Endlosschleife mit delay(1)
  stop_on_entry.ctl         # -num 3 | once | DebugBreak() am Start (-dbg CTRL_DEBUGBREAK)
  call_library_function.ctl # -num 4 | once | #uses debugger_lib.ctl
  callstack_depth3.ctl      # -num 5 | once | Tiefe Callstack für step-Tests
  all_types.ctl             # -num 6 | once | Alle WinCC OA Basistypen
  pause_loop.ctl            # -num 7 | manual | DebugBreak() + Loop für pause-Test
  libs/
    debugger_lib.ctl        # Library für lib-BP-Tests
```

---

## Build & Scripts

```bash
npm run build              # CJS + ESM + types (dist/cjs/, dist/esm/, dist/*.d.ts)
npm run test               # style-check + build + unit-tests
npm run test:unit          # Nur Unit-Tests
npm run test:integration   # Integration-Tests (benötigt WinCC OA)
npm run style-check        # lint + format:check + lint:md
npm run style-fix          # Auto-fix lint + format + markdown
```

**Build Output**: `dist/cjs/` + `dist/esm/` + Types.  
VS Code Debugger linkt via Symlink: `vscode-winccoa-debugger/dist/adapter → dist/cjs/`  
Setup-Befehl im Extension-Repo: `npm run setup:e2e-links`

---

## Bekannte Probleme / Offene Punkte

### ❌ 1. Library-BP feuert nicht (AKTIV)

**Betroffene Tests**: `debugger-library-bp-e2e.test.ts`  
**Symptom**: Events: `initialized, continued, breakpoint` — aber kein `stopped` innerhalb 20s  
**Was passiert**:
- `retryPendingBreakpoints()` via 500ms-Timer findet `scriptId/libIndex` via Probe
- Erhält `breakpoint set` → `BreakpointEvent` an VS Code (BP verified)
- WinCC OA feuert den BP **nicht**

**Vermutung**: Probe findet `lib:0`, aber die Library liegt bei einem anderen Index —
oder `breakpoint set` ist ein False-Positive für ungültige lib-Indizes.  
**Nächster Schritt**: `info scripts`-Antwort bei laufendem `call_library_function.ctl`
analysieren — welche libIds erscheinen, und stimmen sie mit dem Probe-Ergebnis überein?

### ⚠️ 2. Race: info scripts leer bei frischem Manager-Start (teilweise gelöst)

**Symptom**: Kurz nach `startManager` ist `info scripts` noch leer → BPs pending.  
**Status**: 500ms-Retry-Timer löst es meistens (nach 1–3 Retries). Noch inkonsistent bei
sehr frischem Start (< 500ms bis erste BP-Anfrage).

### ✅ 3. Race Condition bei concurrent setBreakpoints (gelöst)

`bpOperationQueue` serialisiert alle BP-Set-Operationen. Kein Duplikat-Problem.

### ✅ 4. Two-Phase-Response für Step-Commands (gelöst)

`STEP_CMD_RE` + Phase-1-Guard — Phase 1 "OK" resolvet den Pending-Entry nicht.

### ✅ 5. WinCC OA 3.21 Command-Namen (gelöst)

Korrekte Commands: `step over` / `step in` / `step out` / `b` / `c`.

### ✅ 6. Pause ohne Kontext schlägt fehl (gelöst)

`attachToStopContext()` vor `b`; `stopState` bleibt nach Continue erhalten.
DebugBreak()-Pattern etabliert `stopState` zuverlässig beim Start.

---

## Abhängigkeiten

| Paket | Verwendung |
|---|---|
| `@winccoa-tools-pack/npm-winccoa-core` | PmonComponent, WinCC OA Versionsdetection |
| `@vscode/debugadapter` | DAP-Protokoll-Basisklassen |
| `@vscode/debugprotocol` | DAP-Typen |

Delivery: `npm install @winccoa-tools-pack/winccoa-debug-adapter`  
Aktuell per Symlink im E2E-Test-Setup verknüpft.
