# @winccoa-tools-pack/winccoa-debug-adapter

Debug Adapter Protocol (DAP) implementation for WinCC OA CTRL debugging.


## Status

🚧 **Initial Setup** - Feature branch `feature/initial_setup`

---

## Overview

This package provides a Debug Adapter for debugging WinCC OA CTRL scripts from VS Code. It implements the [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) and communicates with WinCC OA via the Datapoint API.

---

## Architecture

```text
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

---

## Next Steps

1. ✅ Package structure initialized
2. 🔲 Implement DatapointClient
3. 🔲 Implement WinCCDebugSession
4. 🔲 Add tests
5. 🔲 Integration with VS Code extension

---

## 🏆 Recognition

Special thanks to all our [contributors](https://github.com/orgs/winccoa-tools-pack/people) who make this project possible!

---

### Key Contributors

- **Martin Pokorny** ([@mPokornyETM](https://github.com/mPokornyETM)) - Creator & Lead Developer
- And many more amazing contributors!

---

## 📜 License

This project is licensed under the **MIT License** - see the [LICENSE](https://github.com/winccoa-tools-pack/.github/blob/main/LICENSE) file for details.

Some parts of this repository may contain third-party software that uses other license models.

---

## ⚠️ Disclaimer

**WinCC OA** and **Siemens** are trademarks of Siemens AG.
This project is not affiliated with, endorsed by, or sponsored by Siemens AG.
This is a community-driven open source project created to enhance the development experience for WinCC OA developers.

---

## 🎉 Thank You

Thank you for using WinCC OA tools package! We're excited to be part of your development journey.

Happy Coding! 🚀

---
