---
title: cordis ctx 属性访问需 inject，未声明直接崩
confidence: 0.95
expires: 2027-02-20
times_seen: 1
updated: 2026-08-24
---

runtimeCtx.llm 这类直接属性访问在真实 harness 会抛 'cannot get property without inject'。runner 行只 inject 了三个服务，其余一律走 runtimeCtx.get('name') 并判 undefined。
