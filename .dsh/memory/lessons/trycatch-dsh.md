---
title: 通知分发必须兜 try/catch，否则一个命令炸掉整个 dsh
confidence: 0.9
expires: 2027-02-20
times_seen: 1
updated: 2026-08-24
---

nvim 通知处理回调里调用命令函数若不兜异常，会变成 unhandled rejection 直接杀死 runner 进程（整个 dsh 退出）。dsh-command/dsh-input 分发已加 try/catch + notice。
