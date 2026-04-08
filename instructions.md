# npm-winccoa-debugger — Development Instructions

## Was ist dieses Repo?

**Paket**: `@winccoa-tools-pack/winccoa-debug-adapter`  
**Branch**: `feature/initial_setup`  
**Zweck**: TypeScript-Bibliothek + CLI, die als **Debug Adapter** für WinCC OA CTRL-Skripte
dient. Implementiert das Debug Adapter Protocol (DAP) und kommuniziert mit WinCC OA über
Datapoints (`_CtrlDebug_CTRL_N._CtrlDebug.Command/Result`).

---

## Architektur

```
src/
├── adapter/
│   ├── WinCCDebugSession.ts     # Haupt-DAP-Session (DebugSession-Subklasse)
│   ├── BreakpointManager.ts     # (reserviert / noch nicht aktiv genutzt)
│   ├── ThreadManager.ts         # (reserviert)
│   └── VariableManager.ts       # (reserviert)
├── connection/
│   └── DatapointClient.ts       # WinCC OA DP-Kommunikation (dpConnect, dpSet, sendCommand)
├── protocol/                    # DAP-Protokoll-Hilfstypen
├── cli.ts                       # Einstiegspunkt: node debugAdapter.js [--tcp-port N | --stdio | ...]
└── index.ts                     # Öffentliche Exporte
```

### Startmodus (Produktion via pmon)
```
node | once | ... | debugAdapter.js
```
- WinCC OA startet den Adapter als `node`-Manager in der `progs`-Datei mit `once`
- WinCC OA übergibt automatisch `-proj <name> -host <h> -port <p> -num <n>` als `process.argv`
- `cli.ts` erkennt, dass `--project` fehlt (WinCC OA hat die Connection bereits), startet TCP-Modus auf Port **7474**
- VS Code verbindet via `DebugAdapterServer(7474)`

### WinCC OA DP-Protokoll
| Richtung | DP | Inhalt |
|---|---|---|
| VS Code → WinCC OA | `_CtrlDebug_CTRL_N._CtrlDebug.Command` | JSON `{"id": "uuid", "cmd": "..."}` |
| WinCC OA → VS Code | `_CtrlDebug_CTRL_N._CtrlDebug.Result` | JSON `["uuid", "OK", ...]` (solicited) oder `["", "stopped", ...]` (unsolicited) |

### Breakpoint-Mechanismus
- `info scripts` → liefert `ScriptId: N; .../file.ctl` Einträge
- `breakpoint {"scriptId": N, "scopeId": 0, "lib": -1, "line": L}` → setzt BP
- `delete-all` + Reapply aller registrierten BPs bei jedem `setBreakpoints`-Request
- **Library-Dateien** (`#uses`) erscheinen NICHT in `info scripts` → Probe via `lib:0..MAX_LIB_PROBE`
- **PendingBpRequests**: BPs die während `setBreakpoints` nicht gesetzt werden konnten (Script noch nicht registriert)

---

## WinCCDebugSession — Wichtige Felder & Mechanismen

### pendingBpRequests + Retry-Timer
```
pendingBpRequests: Map<sourcePath, [{bp, line}]>
```
- Befüllt in `setBreakPointsRequest` wenn `findScriptId()` → `-1`
- `retryPendingBreakpoints()`: wird aufgerufen bei:
  1. **Jedem `stopped`-Event** (original)
  2. **Alle 500ms via `pendingBpRetryTimer`** (neu, seit letztem Commit) — bricht das Chicken-and-Egg-Problem wenn der CTRL-Manager zu frisch gestartet wurde
- `pendingBpRetryInFlight`: Verhindert parallele Retry-Ausführungen
- `startPendingBpRetryTimer()`: gestartet in `configurationDoneRequest` (nicht-stopOnEntry-Pfad)
- Timer wird gecancelt in `cleanupClient()` beim Disconnect

### bpOperationQueue
Serialisiert alle `setBreakpoints`-Operationen, da VS Code concurrent requests (je Datei eine)
schickt. Ohne Serialisierung: parallele `delete-all` + Reapply → Duplikate.

### libIndexCache
Cached `scriptId → libIndex` für Library-Dateien. Probe-Ergebnis wird gespeichert damit
nachfolgende BP-Setzungen für dieselbe Lib keine neue Probe brauchen.

---

## Bekannte Probleme / Offene Punkte

### 1. Library-BP feuert nicht (AKTIV)
**Symptom**: `breakpoint`-Event kommt (BP verified), aber `stopped` kommt nie.  
**Vermutung**: `retryPendingBreakpoints()` findet den korrekten `scriptId/libIndex` via Probe
und erhält `breakpoint set` — aber der BP landet möglicherweise an der falschen Stelle
(falscher lib-Index, unterschiedliche `#uses`-Reihenfolge je WinCC OA Version).  
**Nächster Schritt**: Adapter-Logs bei `retryPendingBreakpoints` analysieren — was gibt
`info scripts` zurück, welcher `scriptId/libIndex` wird probiert?

### 2. Race: info scripts leer bei frischem Manager-Start (AKTIV)
**Symptom**: `setBreakpoints` → `info scripts` leer → BPs pending → Timer startet → 
BP kommt irgendwann, aber `stopped` kommt nicht (bei Test 2 `libbp` gar kein `breakpoint`-Event).  
**Status**: Timer läuft, aber das Ergebnis ist noch inkonsistent.

### 3. Library-Probe-Logik — Duplikat-Risiko
Der erste BP wird via Probe gesetzt (Probe = "breakpoint set"-Antwort ist der echte Setzbefehl).
Wenn danach `reapplyAllBreakpoints` läuft, kann ein zweiter Duplikat-BP entstehen.  
→ Deshalb: Library-BPs werden BEWUSST nicht via `reapplyAllBreakpoints` gesetzt, nur via
`retryPendingBreakpoints`. Bei Disconnect/Reattach muss das sauber gecleant sein.

---

## Test-Struktur

```
test/
├── unit/
│   ├── WinCCDebugSession.test.ts   # Unit-Tests mit gemocktem DatapointClient
│   └── DatapointClient.test.ts     # Unit-Tests für DP-Kommunikation
└── integration/
    ├── debugger-e2e.test.ts                   # Grundlegender Attach-Test
    ├── debugger-bp-cycle.test.ts              # BP set/hit/continue Zyklen
    ├── debugger-stop-on-entry.test.ts         # stopOnEntry-Modus
    ├── debugger-step-commands.test.ts         # step-next/into/out + pause
    ├── debugger-library-bp.test.ts            # BPs in #uses Library-Dateien
    ├── debugger-adapter-lib-bp-session.test.ts # Adapter-level Lib-BP Regression
    ├── debugger-adapter-race-condition.test.ts # Race Condition Regression
    └── debugger-spurious-stops.test.ts        # Spurious-Stop Unterdrückung
```

### Fixture-Projekt
```
test/fixtures/projects/runnable/
├── config/
│   ├── progs         # CTRL managers (manual), node adapter (once)
│   └── config        # WinCC OA Projektkonfiguration
└── scripts/
    ├── bp_basic_loop.ctl         # Endlosschleife mit delay(1) — für BP-Tests
    ├── stop_on_entry.ctl         # stopOnEntry via -dbg CTRL_DEBUGBREAK
    ├── call_library_function.ctl # Ruft debugger_lib.ctl via #uses auf
    ├── callstack_depth3.ctl      # Tiefe Callstack für step-Tests
    └── libs/
        └── debugger_lib.ctl     # Library für lib-BP-Tests
```

### Test-Ausführung
```bash
npm run test:unit           # Unit-Tests (kein WinCC OA nötig)
npm run test:integration    # Integration-Tests (WinCC OA Docker erforderlich)
npm run build               # CJS + ESM + Types bauen
```

---

## Wichtige Commands & Build

```bash
npm run build           # Alles bauen (types + cjs + esm)
npm run test:unit       # Unit-Tests
npm run test:integration  # Braucht laufenden WinCC OA Docker-Container
```

**Build Output**: `dist/cjs/` + `dist/esm/` + Types.  
Der VS Code Debugger linkt via Symlink: `vscode-winccoa-debugger/dist/adapter → dist/cjs/`

---

## Delivery-Ziel: `vscode-winccoa-debugger` nutzt dieses Paket via:
```
npm install @winccoa-tools-pack/winccoa-debug-adapter
```
Aktuell per Symlink im E2E-Test-Setup verknüpft.
