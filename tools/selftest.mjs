#!/usr/bin/env node
// 只读自检：查「会话 → 微信聊天 → wxid」和 hook 通道，**不发任何消息**。
//
//   node tools/selftest.mjs wechat:private:<聊天号>
//   node tools/selftest.mjs social-xxxxxxxx          # 也可以直接给会话 id，自己反查
//
// 全部就绪返回 0；缺哪一环返回 1，并把原因打出来。

import { chatAllowed, chatForSession, probe, workModeOf, WECHAT_ROOT } from '../lib/send.mjs'

const raw = String(process.argv[2] || '').trim()

if (!raw || raw === '-h' || raw === '--help') {
  console.log([
    '用法：node tools/selftest.mjs <聊天键 | 会话 id>',
    '',
    '  聊天键形如 wechat:private:123456789 或 wechat:group:123456789',
    '  会话 id 形如 social-xxxxxxxx（WeChatAgent 里那个 DSH 会话）',
    '',
    '这个脚本只查通道，不发消息。',
  ].join('\n'))
  process.exit(raw ? 0 : 2)
}

const chat = raw.startsWith('wechat:') ? raw : chatForSession(raw)

if (!chat) {
  console.error(`找不到 ${raw} 对应的微信聊天。`)
  console.error(`会话映射读的是 ${WECHAT_ROOT}\\state\\accounts\\<账号>\\dsh-sessions.json；`)
  console.error('如果给的是会话 id，确认那条会话是 WeChatAgent 建的（id 一般以 social- 开头）。')
  process.exit(1)
}

const report = await probe(chat)

let out = {
  chat,
  fromSession: raw === chat ? null : raw,
  mode: workModeOf(chat),
  ...report,
}

// 顺手把最常踩的两个坑讲清楚
const hints = []
if (!report.reader) hints.push('读不到 state/wechat-io-config.json：WeChatAgent 后台没在跑？')
if (!report.hook) hints.push('读不到 state/hook/native-token.txt：微信没开，或 version.dll 没注入？')
if (!report.chat) hints.push('这个聊天不在 config/wechatagent.json 的 whitelist 里：先在 WeChatAgent 聊天页把它加进来。')
if (report.target && String(report.target).startsWith('解析失败')) {
  hints.push('聊天在名单里但解析不出唯一 wxid：同号多设备 / 会话列表太旧，先让那个聊天在微信里刷出一条新消息。')
}
if (hints.length) out.hints = hints

console.log(JSON.stringify(out, null, 2))

const ok = report.reader && report.hook && report.chat && !String(report.target || '').startsWith('解析失败')
process.exit(ok ? 0 : 1)
