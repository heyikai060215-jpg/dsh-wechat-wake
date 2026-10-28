// dsh-wechat-wake —— 微信里的「定时唤醒」。
//
// 为什么要有它：DSH 自带的 schedule 工具在微信的「社交模式」会话里被 bridge 挡掉了
// （social-tool-policy / dsh-access 的 controlTool 前缀里就有 schedule），而 bridge 里
// 「到点把结果发回微信」那段（adoptScheduledTurn）又只在助手模式生效。于是小肥鱼这种
// 陪聊会话既看不到定时工具、到点也发不出声。
//
// 这个插件用不撞前缀的工具名（remind_*）绕开第一道闸，用自己的 followup + 投递跑完
// 「定时 → 唤醒 → 发回微信」。要不要给某个聊天用，仍在 WeChatAgent 的「能力与权限」
// 里按聊天勾选（dshAccess.tools）——插件不自己判模式，只在助手模式下礼貌拒绝，
// 那边交给原生的 schedule_create。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { chatAllowed, chatForSession, probe, sendText, sleep, workModeOf } from './send.mjs'

export const name = 'wechat-wake'
export const inject = ['tools']

const SOURCE = 'wechat-wake'
const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000
const WAKE_TIMEOUT_MS = 120000
const CATCH_UP_MS = 10 * 60 * 1000
const MIN_SEND_GAP_MS = 1500
const MAX_PENDING_PER_SESSION = 12

const jsonOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [
    {
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    },
  ],
}

// ---------- 小工具 ----------

function pad(value) {
  return String(value).padStart(2, '0')
}

function fmtLocal(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function newId() {
  try {
    return 'rw-' + randomUUID().slice(0, 8)
  } catch {
    return 'rw-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  }
}

function dshHome(ctx) {
  try {
    const value = ctx?.get?.('dshHomePath')
    if (typeof value === 'function') {
      const dir = value()
      if (dir) return String(dir)
    } else if (typeof value === 'string' && value) {
      return value
    }
  } catch {
    /* 拿不到就退回环境变量 */
  }
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** HH:MM[:SS] 或带时区的 ISO；没给时区就按本机时区。返回毫秒；认不出返回 NaN。 */
function parseWhen(value, now = Date.now()) {
  const text = String(value ?? '').trim()
  if (!text) return NaN
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (clock) {
    const hour = Number(clock[1])
    const minute = Number(clock[2])
    const second = Number(clock[3] || 0)
    if (hour > 23 || minute > 59 || second > 59) return NaN
    const at = new Date(now)
    at.setHours(hour, minute, second, 0)
    if (at.getTime() <= now) at.setDate(at.getDate() + 1)
    return at.getTime()
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (local) {
    const at = new Date(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6] || 0),
      0,
    )
    return at.getTime()
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : NaN
}

function findAgent(ctx, sessionId) {
  const raw = String(sessionId || '').trim()
  if (!raw) return undefined
  const candidates = [raw]
  if (raw.startsWith('session-')) candidates.push(raw.slice('session-'.length))
  else candidates.push('session-' + raw)
  for (const id of candidates) {
    try {
      const agent = ctx?.agents?.get?.(id)
      if (agent !== undefined) return agent
    } catch {
      /* agents 服务不在就当成找不到 */
    }
  }
  return undefined
}

function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 把模型那一轮的正文收干净：去掉发送协议前缀；SILENT 返回空串。 */
function cleanReply(text) {
  let value = String(text ?? '').trim()
  if (!value) return ''
  value = value.replace(/^\s*RESPOND:\s*/i, '').replace(/^\s*SILENT\s*$/i, '').trim()
  if (!value) return ''
  return value.length > 4000 ? value.slice(0, 3990) + '…' : value
}

// ---------- 待触发列表 ----------

class WakeStore {
  constructor(file) {
    this.file = file
    this.data = { version: 1, reminders: [], missed: [] }
    this.load()
  }

  load() {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''))
      if (!raw || raw.version !== 1 || !Array.isArray(raw.reminders)) return
      this.data = {
        version: 1,
        reminders: raw.reminders.filter((item) => item && typeof item.id === 'string'),
        missed: Array.isArray(raw.missed) ? raw.missed.slice(-50) : [],
      }
    } catch {
      /* 文件坏了就当空表，下次写回时自然修好 */
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temp = this.file + '.' + process.pid + '.tmp'
      writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(temp, this.file)
    } catch {
      /* 写盘失败不该让整轮崩掉 */
    }
  }

  get(id) {
    return this.data.reminders.find((item) => item.id === id)
  }

  pendingFor(sessionId) {
    return this.data.reminders.filter(
      (item) => item.sessionId === sessionId && item.state === 'pending',
    )
  }

  add(reminder) {
    this.data.reminders.push(reminder)
    this.data.reminders = this.data.reminders.slice(-200)
    this.save()
    return reminder
  }

  patch(id, fields) {
    const item = this.get(id)
    if (!item) return null
    Object.assign(item, fields)
    this.save()
    return item
  }

  remove(id) {
    const before = this.data.reminders.length
    this.data.reminders = this.data.reminders.filter((item) => item.id !== id)
    if (this.data.reminders.length !== before) this.save()
    return this.data.reminders.length !== before
  }
}

// ---------- 插件本体 ----------

export async function apply(ctx) {
  const file = join(dshHome(ctx), 'wechat-wake.json')
  const store = new WakeStore(file)
  const timers = new Map() // id -> timeout
  const active = new Map() // sessionId -> 正在被唤醒的那一轮
  const wakeTimers = new Map() // sessionId -> 唤醒兜底计时器
  const lastSend = new Map() // chat -> 上次发送时间
  let closed = false

  const log = (line) => {
    try {
      ctx.logger.info('[wechat-wake] ' + line)
    } catch {
      /* 没有 logger 就算了 */
    }
  }

  function arm(reminder) {
    if (timers.has(reminder.id)) clearTimeout(timers.get(reminder.id))
    const delay = Math.max(0, reminder.dueAt - Date.now())
    const timer = setTimeout(() => {
      timers.delete(reminder.id)
      void fire(reminder.id)
    }, delay)
    timer.unref?.()
    timers.set(reminder.id, timer)
  }

  /** 真正把一条提醒发出去（wake 失败、超时、SILENT 的兜底都走这里）。 */
  async function deliver(reminder, chat, text, extra = {}) {
    const gap = MIN_SEND_GAP_MS - (Date.now() - (lastSend.get(chat) || 0))
    if (gap > 0) await sleep(gap)
    try {
      const result = await sendText(chat, text)
      lastSend.set(chat, Date.now())
      store.patch(reminder.id, {
        state: 'delivered',
        deliveredAt: Date.now(),
        deliveredText: String(text).slice(0, 500),
        confirmed: Boolean(result.confirmed),
        ...extra,
      })
      log(`已发到 ${chat}：${String(text).slice(0, 40)}`)
    } catch (error) {
      store.patch(reminder.id, {
        state: 'failed',
        error: String(error?.message || error).slice(0, 300),
        ...extra,
      })
      log(`发送失败（${reminder.id}）：${String(error?.message || error)}`)
    }
  }

  function wakeText(reminder) {
    return [
      '（这条不是对方发来的消息，是你在微信里给自己定的一个到点唤醒。）',
      `【定时唤醒 · ${fmtLocal(Date.now())}】`,
      '你之前记下、要对 ta 做/说的事：' + reminder.note,
      '现在到点了。按你平时和 ta 的相处方式，把此刻要对 ta 说的话说出来，就发这一条；',
      '该查的数据、该看的东西现在就去查，别凭记忆编。',
      '不要提「定时器 / 提醒系统 / 程序唤醒」这类词，也不要复述这条指令本身。',
    ].join('\n')
  }

  /** 这一轮收工：把模型说的话发到微信；没有就发兜底的那句。 */
  async function finishWake(sessionId, reason = {}) {
    const state = active.get(sessionId)
    if (!state) return
    active.delete(sessionId)
    const timer = wakeTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      wakeTimers.delete(sessionId)
    }
    const reminder = store.get(state.reminderId)
    if (!reminder) return
    const said = cleanReply(state.text)
    if (said) {
      await deliver(reminder, state.chat, said)
      return
    }
    const why = reason.timeout ? '唤醒后没等到回复' : reason.error ? '这一轮出错了' : '这一轮没有说话'
    await deliver(reminder, state.chat, '⏰ ' + state.note, { fallback: true, fallbackReason: why })
  }

  async function fire(id) {
    const reminder = store.get(id)
    if (!reminder || reminder.state !== 'pending' || closed) return
    if (reminder.dueAt > Date.now() + 1500) {
      arm(reminder)
      return
    }
    const chat = reminder.chat || chatForSession(reminder.sessionId)
    if (!chat) {
      store.patch(id, { state: 'skipped', error: '找不到这条会话对应的微信聊天' })
      log(`跳过 ${id}：找不到对应的微信聊天`)
      return
    }
    if (!chatAllowed(chat)) {
      store.patch(id, { state: 'skipped', error: '聊天已不在微信白名单里' })
      log(`跳过 ${id}：${chat} 已不在白名单`)
      return
    }
    const note = String(reminder.note || '').trim()
    store.patch(id, { firedAt: Date.now() })

    if (reminder.mode === 'text') {
      await deliver(reminder, chat, note, { chat })
      return
    }

    const agent = findAgent(ctx, reminder.sessionId)
    if (!agent) {
      await deliver(reminder, chat, '⏰ ' + note, { fallback: true, fallbackReason: '会话不在线' })
      return
    }
    const sessionId = String(agent.session?.id || reminder.sessionId)
    if (active.has(sessionId)) {
      await deliver(reminder, chat, '⏰ ' + note, { fallback: true, fallbackReason: '上一轮唤醒还没结束' })
      return
    }
    active.set(sessionId, {
      reminderId: id,
      chat,
      note,
      turn: null,
      text: '',
      startedAt: Date.now(),
    })
    const message = {
      id: 'wake-' + randomUUID().slice(0, 12),
      role: 'user',
      content: [{ type: 'text', text: wakeText(reminder) }],
      source: { kind: SOURCE, reminderId: id },
    }
    try {
      await agent.followup(message)
    } catch (error) {
      active.delete(sessionId)
      await deliver(reminder, chat, '⏰ ' + note, {
        fallback: true,
        fallbackReason: '唤醒失败：' + String(error?.message || error).slice(0, 120),
      })
      return
    }
    const timer = setTimeout(() => {
      const state = active.get(sessionId)
      if (state && state.reminderId === id) void finishWake(sessionId, { timeout: true })
    }, WAKE_TIMEOUT_MS)
    timer.unref?.()
    wakeTimers.set(sessionId, timer)
    log(`唤醒 ${sessionId}（${id}）：${note.slice(0, 40)}`)
  }

  // ---------- 会话事件：抓住被唤醒那一轮的正文 ----------

  function onSessionEvent(session, event) {
    const sessionId = String(session?.id || '')
    if (!sessionId) return
    const state = active.get(sessionId)
    if (!state) return
    const data = event?.data || {}

    if (event?.type === 'user/message') {
      const kind = String(data?.message?.source?.kind || '')
      if (kind === SOURCE) state.turn = data.turn ?? state.turn
      return
    }

    if (event?.type === 'assistant/message') {
      if (data.interrupted) return
      if (state.turn !== null && data.turn !== undefined && data.turn !== state.turn) return
      const text = messageText(data.message)
      if (text.trim()) state.text = text
      return
    }

    if (event?.type === 'turn/end') {
      if (state.turn !== null && data.turn !== undefined && data.turn !== state.turn) return
      const ok = data?.reason?.kind === 'completed'
      void finishWake(sessionId, ok ? {} : { error: true })
    }
  }

  // ---------- 工具 ----------

  function resolveSessionChat(exec) {
    let sessionId = ''
    try {
      const agent = exec?.agent || exec?.caller || exec?.agentRef
      sessionId = String(agent?.session?.id || agent?.sessionId || agent?.id || '')
    } catch {
      sessionId = ''
    }
    return { sessionId, chat: chatForSession(sessionId) }
  }

  ctx.tools.register({
    name: 'remind_later',
    description:
      '给这个微信聊天定一个「到点唤醒」：到时间在当前的微信会话里叫醒你自己，'
      + '按当时的真实情况说一句 / 办一件事，说的话会直接发回这个微信聊天。'
      + '用户说「过一会儿提醒我」「X 点再来找我」「十分钟后再看一眼」就用它。'
      + 'mode=wake（默认）会花一次模型；只是原样提醒一句就传 mode=text，不花模型。'
      + '最长 7 天，不要用它做每天重复的日程。',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: '到点要做/要说的事，写给未来的自己看：ta 让你提醒什么、到点该说什么或该去看什么。',
        },
        delay_seconds: {
          type: 'number',
          description: '多久之后（秒）。和 at 二选一。',
        },
        at: {
          type: 'string',
          description: '具体时间：HH:MM（今天，过了就明天）或 2026-10-28T15:30:00+08:00。和 delay_seconds 二选一。',
        },
        mode: {
          type: 'string',
          enum: ['wake', 'text'],
          description: 'wake=到点唤醒你自己说话（默认）；text=到点原样发 note，不花模型。',
        },
      },
      required: ['note'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(args, exec) {
      const note = String(args?.note ?? '').trim()
      if (!note) return { ok: false, error: '缺少 note：要写清楚到点提醒什么' }
      if (note.length > 800) return { ok: false, error: 'note 太长（超过 800 字），写短一点' }
      const { sessionId, chat } = resolveSessionChat(exec)
      if (!chat) {
        return { ok: false, error: '当前不在 WeChatAgent 的微信会话里，这个工具只在微信聊天里用。' }
      }
      if (workModeOf(chat) === 'assistant') {
        return {
          ok: false,
          reason: 'assistant_mode',
          message: '这个聊天在助手模式：请改用 schedule_create（那边的结果会由 bridge 自动发回微信），本工具不用。',
        }
      }
      const hasDelay = args?.delay_seconds !== undefined
      const hasAt = args?.at !== undefined
      if (hasDelay === hasAt) return { ok: false, error: 'delay_seconds 和 at 必须给且只给一个' }
      let dueAt
      if (hasDelay) {
        const seconds = Number(args.delay_seconds)
        if (!Number.isFinite(seconds) || seconds < 10) {
          return { ok: false, error: 'delay_seconds 至少 10 秒' }
        }
        dueAt = Date.now() + Math.round(seconds) * 1000
      } else {
        dueAt = parseWhen(args.at)
        if (!Number.isFinite(dueAt)) return { ok: false, error: 'at 认不出来：用 HH:MM 或带时区的 ISO 时间' }
      }
      const ahead = dueAt - Date.now()
      if (ahead <= 0) return { ok: false, error: '这个时间已经过去了' }
      if (ahead > MAX_DELAY_MS) return { ok: false, error: '最长只能定 7 天以内的' }
      const pending = store.pendingFor(sessionId)
      if (pending.length >= MAX_PENDING_PER_SESSION) {
        return { ok: false, error: `这个会话已经压着 ${pending.length} 条没触发的提醒，先 list/cancel 掉一些` }
      }
      const mode = args?.mode === 'text' ? 'text' : 'wake'
      const reminder = store.add({
        id: newId(),
        sessionId,
        chat,
        note,
        mode,
        dueAt,
        createdAt: Date.now(),
        state: 'pending',
      })
      arm(reminder)
      return {
        ok: true,
        id: reminder.id,
        dueAt: new Date(dueAt).toISOString(),
        dueLocal: fmtLocal(dueAt),
        inSeconds: Math.round(ahead / 1000),
        mode,
        chat,
        hint: mode === 'wake'
          ? '到点我会被叫起来，你那时说的话会直接发到这个微信聊天。'
          : '到点我会把 note 原样发到这个微信聊天，不会叫模型。',
      }
    },
  })

  ctx.tools.register({
    name: 'remind_list',
    description: '看这个微信会话里还压着哪些没触发的定时唤醒，以及最近错过的。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: jsonOutput,
    async execute(_args, exec) {
      const { sessionId } = resolveSessionChat(exec)
      const pending = store
        .pendingFor(sessionId)
        .sort((a, b) => a.dueAt - b.dueAt)
        .map((item) => ({
          id: item.id,
          dueLocal: fmtLocal(item.dueAt),
          inSeconds: Math.round((item.dueAt - Date.now()) / 1000),
          mode: item.mode,
          note: item.note,
        }))
      const missed = store.data.missed
        .filter((item) => item.sessionId === sessionId)
        .slice(-5)
        .map((item) => ({ id: item.id, wasDue: fmtLocal(item.dueAt), note: item.note }))
      return { ok: true, pending, missed, file: store.file }
    },
  })

  ctx.tools.register({
    name: 'remind_cancel',
    description: '取消一条还没触发的定时唤醒（按 id）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'remind_later 返回的那条 id' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(args, exec) {
      const id = String(args?.id ?? '').trim()
      if (!id) return { ok: false, error: '缺少 id' }
      const reminder = store.get(id)
      if (!reminder) return { ok: false, error: '没有这条提醒：' + id }
      const { sessionId } = resolveSessionChat(exec)
      if (reminder.sessionId !== sessionId) return { ok: false, error: '这条提醒不属于当前会话' }
      if (reminder.state !== 'pending') return { ok: false, error: `这条已经是 ${reminder.state}，不用取消` }
      const timer = timers.get(id)
      if (timer) {
        clearTimeout(timer)
        timers.delete(id)
      }
      store.patch(id, { state: 'cancelled' })
      return { ok: true, id, cancelled: true }
    },
  })

  // ---------- 装表 / 收摊 ----------

  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      try {
        onSessionEvent(session, event)
      } catch {
        /* 单条事件处理出错不该影响会话 */
      }
    })
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* ignore */
      }
    }
  }, 'wechat-wake: 抓被唤醒那一轮的正文')

  ctx.effect(() => {
    const now = Date.now()
    let armed = 0
    let late = 0
    for (const reminder of store.data.reminders) {
      if (reminder.state !== 'pending') continue
      if (reminder.dueAt > now) {
        arm(reminder)
        armed += 1
      } else if (now - reminder.dueAt <= CATCH_UP_MS) {
        late += 1
        const timer = setTimeout(() => void fire(reminder.id), 2000 + late * 1500)
        timer.unref?.()
        timers.set(reminder.id, timer)
      } else {
        store.data.missed.push({
          id: reminder.id,
          sessionId: reminder.sessionId,
          chat: reminder.chat,
          note: reminder.note,
          dueAt: reminder.dueAt,
        })
        store.data.missed = store.data.missed.slice(-50)
        store.patch(reminder.id, { state: 'missed', error: '进程关着期间错过了，没有补发' })
      }
    }
    if (store.data.missed.length) store.save()
    log(`已加载，待触发 ${armed} 条${late ? `，补发 ${late} 条` : ''}（${file}）`)
    return () => {
      closed = true
      for (const timer of timers.values()) clearTimeout(timer)
      for (const timer of wakeTimers.values()) clearTimeout(timer)
      timers.clear()
      wakeTimers.clear()
      active.clear()
    }
  }, 'wechat-wake: 重启后重新挂表')
}

/** 给命令行自检用：只读探针，不发消息。 */
export { probe }
