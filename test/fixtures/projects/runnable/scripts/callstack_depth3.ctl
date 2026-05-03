// callstack_depth3.ctl
// Nested call-stack and step-through integration test.
// Manager -num 4   Mode: always
//
// Call chain: main() → compute_outer(n) → compute_inner(n, factor) → multiply_and_add(x,y,z)
// A breakpoint at BP_LINE = 19 (inside multiply_and_add) lets tests verify:
//   - 3-frame call stack with distinct locals at each frame
//   - Step-over / step-into behaviour
//
// Frame locals when stopped at BP_LINE:
//   multiply_and_add : x=<counter>, factor=3, z=1
//   compute_inner    : n=<counter>, factor=3
//   compute_outer    : n=<counter>
//
// BP_LINE = 19  (int result = x * factor + z)

int multiply_and_add(int x, int factor, int z)
{
  int result = x * factor + z;   // line 19 — BP target
  return result;
}

int compute_inner(int n, int factor)
{
  int partial = multiply_and_add(n, factor, 1);
  return partial;
}

int compute_outer(int n)
{
  int value = compute_inner(n, 3);
  return value;
}

main()
{
  int counter = 1;
  DebugN("callstack_depth3: starting");

  while (true)
  {
    int total = compute_outer(counter);
    DebugN("callstack_depth3: total = " + total);
    counter++;
    delay(1);
  }
}
