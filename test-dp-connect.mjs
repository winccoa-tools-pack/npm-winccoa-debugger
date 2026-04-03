/**
 * Quick integration test: try dpConnect with different DP name formats
 * to find out which one works.
 *
 * Run: node test-dp-connect.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

// WinCC OA connection params - adapt if needed
const HOST = 'localhost';
const PORT = 4999;
const SYSTEM = 'DevEnv3.21';
const ADAPTER_NUM = 97;  // use 97 to avoid clashing with running adapter (99)
const CTRL_NUM = 1;

// Inject connection args before loading winccoa-manager singleton
process.argv = [
  'node', 'test-dp-connect',
  '-proj', SYSTEM,
  '-host', HOST,
  '-port', String(PORT),
  '-num', String(ADAPTER_NUM),
  '-m', 'jscript'
];

console.log('[test] process.argv:', process.argv.slice(2).join(' '));

const managerPath = `/opt/WinCC_OA/3.21/javascript/winccoa-manager/index.js`;

let api;
try {
  const mod = await import(managerPath);
  const { WinccoaManager } = 'default' in mod ? mod.default : mod;
  api = new WinccoaManager();
  console.log('[test] WinccoaManager created');
} catch (err) {
  console.error('[test] Failed to create WinccoaManager:', err.message);
  process.exit(1);
}

// Wait a moment for the connection to stabilize
await new Promise(r => setTimeout(r, 500));

// Test candidates — try both old (flat) and new (nested _CtrlDebug struct) paths
const candidates = [
  `_CtrlDebug_CTRL_${CTRL_NUM}._CtrlDebug.Result`,
  `_CtrlDebug_CTRL_${CTRL_NUM}._CtrlDebug.Command`,
  `_CtrlDebug_CTRL_${CTRL_NUM}.Result`,
  `_CtrlDebug_CTRL_${CTRL_NUM}.Command`,
];

console.log('\n[test] Testing dpConnect for each candidate...');

let anySuccess = false;
for (const dpe of candidates) {
  try {
    const id = api.dpConnect((values, names) => {
      console.log(`[test] ✓ CALLBACK for ${dpe}:`, values, names);
      anySuccess = true;
    }, dpe, true);  // answer=true triggers immediate value delivery
    console.log(`[test] dpConnect("${dpe}") → id=${id}`);
    if (id < 0) {
      console.log(`[test]   ↳ id<0 means ERROR`);
    } else {
      console.log(`[test]   ↳ id>=0 means SUCCESS`);
    }
  } catch (err) {
    console.log(`[test] dpConnect("${dpe}") → THREW: ${err.message}`);
  }
}

// Also try a dpGet to check if DP is readable
console.log('\n[test] Testing dpGet...');
for (const dpe of candidates.slice(0, 2)) {
  try {
    // dpGet is not async in all versions, try dpGetPeriod if available
    if (typeof api.dpGet === 'function') {
      const val = await api.dpGet(dpe);
      console.log(`[test] dpGet("${dpe}") → ${JSON.stringify(val)}`);
    }
  } catch (err) {
    console.log(`[test] dpGet("${dpe}") → THREW: ${err.message}`);
  }
}

// Wait 3s for callbacks
console.log('\n[test] Waiting 3s for callbacks...');
await new Promise(r => setTimeout(r, 3000));

console.log('\n[test] Done. anySuccess =', anySuccess);
process.exit(0);
