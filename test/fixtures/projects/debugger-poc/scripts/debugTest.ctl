// Debugger POC Test Script
// This script is used to test debug adapter functionality

main()
{
  int counter = 0;
  dyn_string items = makeDynString("apple", "banana", "cherry");

  DebugN("Starting debugger POC test script");

  for (int i = 1; i <= 10; i++)
  {
    counter += i;
    DebugN("Iteration " + i + ", counter = " + counter);

    if (i == 5)
    {
      DebugN("Halfway there!");
    }
  }

  testFunction(counter, items);

  DebugN("Test script completed with counter = " + counter);
}

void testFunction(int value, dyn_string data)
{
  DebugN("testFunction called with value = " + value);

  for (int i = 1; i <= dynlen(data); i++)
  {
    DebugN("Item[" + i + "] = " + data[i]);
  }

  int localVar = value * 2;
  DebugN("localVar = " + localVar);
}
