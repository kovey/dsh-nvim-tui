---
title: harness 服务形状以真实 d.ts/运行实例为准
confidence: 0.95
expires: 2027-02-20
times_seen: 1
updated: 2026-08-24
---

给 dsh 插件建模宿主服务接口时，臆想形状会全盘失真（如 SettingsDescriptor 是 {ns,value,revision} 而非 {name,sections}；LlmProviderInfo 是 {id,name} 无 models）。先读 node_modules 里对应包的 lib/types/*.d.ts，再真跑一次验证。
