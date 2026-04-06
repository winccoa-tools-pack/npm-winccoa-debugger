// call_library_function.ctl
// Main script for library-breakpoint integration tests.
// Manager -num 3   Mode: always
// BP_MAIN_LINE = 14  (sum = add_two_integers call in while loop)

#uses "libs/debugger_lib"

main()
{
  int counter = 0;
  int sum = 0;
  while (true)
  {
    sum = add_two_integers(counter, 10);  // line 14 — BP_MAIN_LINE
    DebugN("call_library_function: sum = " + sum);
    counter++;
    delay(1);
  }
}
