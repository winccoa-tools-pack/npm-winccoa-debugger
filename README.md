# @winccoa-tools-pack/winccoa-debug-adapter

Debug Adapter Protocol (DAP) implementation for WinCC OA CTRL debugging.

## Status

🚧 **Initial Setup** - Feature branch `feature/initial_setup`

## Overview

This package provides a Debug Adapter for debugging WinCC OA CTRL scripts from VS Code. It implements the [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) and communicates with WinCC OA via the Datapoint API.

## Architecture

```
src/
├── adapter/           # Debug Adapter Protocol handlers
│   ├── WinCCDebugSession.ts
│   ├── BreakpointManager.ts
│   ├── ThreadManager.ts
│   └── VariableManager.ts
├── protocol/          # Protocol translation (DAP ↔ WinCC OA)
│   ├── CommandEncoder.ts
│   ├── ResponseParser.ts
│   └── DAPHandler.ts
├── connection/        # WinCC OA communication
│   ├── DatapointClient.ts
│   └── TcpConnection.ts
├── utils/             # Utilities
│   ├── Logger.ts
│   └── TypeMapper.ts
└── types/             # TypeScript definitions
```

## Next Steps

1. ✅ Package structure initialized
2. 🔲 Implement DatapointClient
3. 🔲 Implement WinCCDebugSession
4. 🔲 Add tests
5. 🔲 Integration with VS Code extension

## License

MIT
