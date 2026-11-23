# 记忆功能的行业现状与用户痛点（侦察结果）

采集：2026-11-22。用途：报告的「问题」证据与「凭什么不同」对照。每条都带来源；未带来源的是我的归纳。

## 一、各家怎么做

| 产品 | 写入 | 注入 | 存储/可见性 | 来源 |
|---|---|---|---|---|
| ChatGPT | 历史对话、已保存记忆、自定义指令、文件、连接应用 | 按相关度注入，回答下方显示 Sources | 设置里可改 memory summary、删单条；"别再提"只减少提及，**不删原始来源** | https://help.openai.com/en/articles/8590148-memory-in-chatgpt |
| Claude | 对话中自动/显式 | 汇总成可查看可编辑的 memory summary | 按项目隔离；有 incognito | https://claude.com/resources/articles/memory |
| Cursor | 编辑器 Memories 已在 2.1 移除 | `.cursor/rules/*.mdc` 与 AGENTS.md 注入提示开头 | 随仓库版本化；云端 Automations 另存 MEMORIES.md | https://cursor.com/docs/context/rules |
| GitHub Copilot | 工作中抓仓库级 memories | 使用前对照当前代码校验 | **28 天自动过期**，仓库设置里可审阅删除 | https://github.blog/changelog/2026-01-15-agentic-memory-for-github-copilot-is-in-public-preview/ |
| Mem0 | 应用侧 add/search | 抽取 + 检索两阶段，是否入 prompt 由应用定 | 向量库，可自托管 | https://docs.mem0.ai/core-concepts/memory-types |
| Letta | agent 自有 git 仓库里的 Markdown（MemFS） | `system/` 每轮进系统提示，其余只给文件树按需读 | 文件即记忆；后台"dreaming"子代理做整合 | https://docs.letta.com/agent-sdk/memory/index.md |
| Notion AI | 指定一页 Notion 页面 | 整页 | 人可直接编辑 | https://www.notion.com/blog/introducing-notion-3-0 |
| mem.ai | 笔记自动组织 | — | **已宣布 2027-01-15 关停** | https://get.mem.ai/ |

## 二、真实抱怨（原话）

1. "It's effectively collecting a dossier on our previous interactions… removes that control completely." — https://simonwillison.net/2025/May/21/chatgpt-new-memory/
2. "Asking it to forget these concrete memories sometimes results in remembering to not mention them. Thoroughly useless." — https://news.ycombinator.com/item?id=47132001
3. "why does it require sharing all of our code with Cursor?" — https://forum.cursor.com/t/0-51-memories-feature/98509
4. "context rot"：过期偏好、错误、矛盾慢慢堆积，结果静默变差且难诊断 — https://every.to/also-true-for-humans/why-i-turned-off-chatgpt-s-memory
5. CLAUDE.md 规则被 "silently ignored"、跨会话漂移 — https://github.com/anthropics/claude-code/issues/44004

## 三、公认难点

- 写入噪声：Letta 官方 issue 承认 archival memory 堆语义重复条目、拖慢检索 — https://github.com/letta-ai/letta/issues/3116
- 检索命中率：Mem0 自报 LoCoMo 92.5（厂商自测）
- 冲突/过期：Copilot 用 28 天过期兜底；ChatGPT 靠手动改 summary
- 可控性：删除 ≠ 源头消失；"别再提" ≠ 忘记
- 可移植：Cursor 移除、mem.ai 关停、Claude 需迁移指引

## 四、本地优先纯文本路线

存在且规模化：AGENTS.md（自称 60k+ 项目采用）、Cline Memory Bank、Letta MemFS、Notion 页面即记忆。

- 已验证优点：可读可改可 diff、随 git 版本化、跨工具复用、退出成本低
- 已验证局限：Claude 官方说 CLAUDE.md 与 auto memory 是 "context, not enforced configuration"，只能靠 hook 强制；MEMORY.md 只加载**前 200 行或 25KB**；整文件注入而非检索，规模一大回到噪声问题；维护靠人工且会被忽略 — https://code.claude.com/docs/en/memory

核查限制：Reddit 403，改用 HN/官方论坛/GitHub；Cursor 移除与 mem.ai 关停以第三方为准。
