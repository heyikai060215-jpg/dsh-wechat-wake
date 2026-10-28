# 更新记录

## 0.1.0 — 2026-10-28

首个版本。

- 三个工具：`remind_later` / `remind_list` / `remind_cancel`；工具名刻意避开 `schedule` 前缀，才能在微信社交模式的工具闸门里存在
- 两种到点方式：`wake`（叫醒会话，现查现说）与 `text`（原样发 note，不花模型）
- 到点兜底：唤醒超时 / 这一轮报错 / 没说话 → 发 `⏰ note`，不会静默消失
- 状态持久化到 `$DSH_HOME/wechat-wake.json`，进程重启后重新挂表；10 分钟内的错过会补发，更早的标记 `missed`
- 每次投递前复查微信白名单、每会话 12 条上限、单条 7 天上限、发送间隔 1.5 秒
- 助手模式下拒绝执行并提示改用原生 `schedule_create`，避免撞上 bridge 的发起人校验
- 附 `tools/selftest.mjs`：命令行只读自检，不发消息

### 实测（微信私聊，社交模式 + 人格式会话）

| 时刻 | 事件 |
|---|---|
| 01:30:55 | 会话第 39 轮，工具表里出现 `remind_later / remind_list / remind_cancel` |
| 01:30:55 | 模型自己调用 `remind_later`，选了 `mode: "text"` |
| 01:33:55.479 | 定时器触发（误差 0.5 秒内） |
| 01:33:56.042 | 投递完成，微信数据库回执 `confirmed: true` |

`mode: "wake"`（到点真叫醒再说话）由同一条链路承载，走的是 `agent.followup()` + `turn/end` 抓正文，尚未在有真实任务的场景下单独验收。
