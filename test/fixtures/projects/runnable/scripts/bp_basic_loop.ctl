// bp_basic_loop.ctl
// Endless loop — target for basic breakpoint and spurious-stop regression tests.
// Manager -num 1   Mode: always
// BP_LINE = 13  (counter++)

main()
{
  int counter = 0;
  DebugN("bp_basic_loop: starting");

  while (true)
  {
    counter++;                // line 13 — BP target
    DebugN("bp_basic_loop: counter = " + counter);
    delay(1);
  }
}
