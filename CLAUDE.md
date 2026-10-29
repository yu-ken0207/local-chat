# local-chat

地端 Ollama 聊天 App（Expo Go）。用法、結構、進度看 [README.md](README.md)，Expo 開發規則看 [AGENTS.md](AGENTS.md)。

- 程式碼主檔在開發機，執行與測試在另一台 Windows 電腦（跑 Expo 開發伺服器），改完同步過去再跑 `npm test`、`npm run typecheck`。
- 每完成一個階段、測試過就 commit；push 前要列出還沒 push 的 commit 文字給使用者看，等使用者說「確認完成」才 push（2026-10-29 改）。
