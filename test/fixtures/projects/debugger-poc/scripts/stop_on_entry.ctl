// stop_on_entry.ctl
//
// Test script for DebugBreak() / stopOnEntry integration test.
//
// MUST be started with -dbg CTRL_DEBUGBREAK:
//   WCCOActrl -num 3 -f scripts/stop_on_entry.ctl -dbg CTRL_DEBUGBREAK
//
// Without that flag DebugBreak() is a no-op (safe for production).
//
// Expected flow:
//   1. Script starts and immediately calls DebugBreak().
//   2. Thread suspends — WinCC OA writes stop event to Result DPE.
//   3. Adapter connects with answer=true on Result DPE.
//   4. Adapter receives the already-written stop event => StoppedEvent.
//   5. User (or test) inspects variables and sends "cont".
//   6. Script resumes, computes result, prints it and exits.

main()
{
  int a = 10;
  int b = 32;

  DebugBreak();           // line 21 — thread pauses here (stopOnEntry)

  int result = a + b;     // result = 42
  DebugN("stop_on_entry: a=" + a + " b=" + b + " result=" + result);
}
