// 投递半边：当前 DSH 会话 → 微信聊天 → wxid → WeChatAgent hook 的 /SendTextMsg。
//
// 这里刻意不碰微信本体、也不改 WeChatAgent 的代码，只用它已经暴露出来的三样东西：
//   1) state/accounts/<账号>/dsh-sessions.json 里的 conversations（会话 ↔ 聊天）
//   2) state/wechat-io-config.json 里的 reader 地址和令牌（只读接口，用来查 wxid / 回执）
//   3) state/hook/native-token.txt + http://127.0.0.1:30001（发消息）
// 这三样和 dsh-tts-bridge-wechatagent-bridge 用的是同一套，不是新造的通道。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import http from 'node:http'

export const WECHAT_ROOT = process.env.WECHATAGENT_ROOT || 'D:\\WeChatAgent\\data\\workspace'
const HOOK_BASE = process.env.WECHATAGENT_HOOK || 'http://127.0.0.1:30001'

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** 和 bridge 那边同一个算法：wxid → OneBot 里的数字 id。 */
function onebotId(username) {
  const digest = createHash('sha256').update(String(username), 'utf8').digest()
  return (digest.readBigUInt64BE(0) % 2147483647n) + 1n
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function httpJson(url, { method = 'GET', payload, headers = {}, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      reject(new Error('地址不对：' + url))
      return
    }
    const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8')
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}),
          ...headers,
        },
      },
      (response) => {
        let data = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          data += chunk
          if (data.length > 4 * 1024 * 1024) request.destroy(new Error('返回太大'))
        })
        response.on('end', () => {
          const code = response.statusCode || 0
          if (code >= 400) {
            reject(new Error(`HTTP ${code} ${String(data).slice(0, 180)}`))
            return
          }
          try {
            resolve(JSON.parse(data))
          } catch {
            reject(new Error('返回不是 JSON：' + String(data).slice(0, 180)))
          }
        })
      },
    )
    request.on('error', (error) => reject(error))
    request.setTimeout(timeoutMs, () => request.destroy(new Error('请求超时（' + timeoutMs + 'ms）')))
    if (body) request.write(body)
    request.end()
  })
}

/** 会话 id → 微信聊天键（wechat:private:<id> / wechat:group:<id>）。查不到就是空串。 */
export function chatForSession(sessionId) {
  const wanted = String(sessionId || '').trim()
  if (!wanted) return ''
  const accounts = join(WECHAT_ROOT, 'state', 'accounts')
  if (!existsSync(accounts)) return ''
  for (const name of readdirSync(accounts)) {
    const file = join(accounts, name, 'dsh-sessions.json')
    if (!existsSync(file)) continue
    const data = readJsonFile(file)
    const conversations = data && data.conversations
    if (!conversations || typeof conversations !== 'object') continue
    for (const [chat, mapped] of Object.entries(conversations)) {
      if (String(mapped) === wanted) return chat
    }
  }
  return ''
}

/** 这个聊天现在是 social 还是 assistant。读不到就按 social 算（WeChatAgent 的默认值）。 */
export function workModeOf(chat) {
  const key = String(chat || '').trim()
  if (!key) return 'social'
  const accounts = join(WECHAT_ROOT, 'state', 'accounts')
  if (existsSync(accounts)) {
    for (const name of readdirSync(accounts)) {
      const file = join(accounts, name, 'dsh-sessions.json')
      if (!existsSync(file)) continue
      const profile = readJsonFile(file)?.profiles?.[key]
      if (profile && typeof profile === 'object' && profile.workMode) {
        return String(profile.workMode)
      }
    }
  }
  const config = readJsonFile(join(WECHAT_ROOT, 'config', 'wechatagent.json'))
  const saved = config?.wechat?.workModes?.[key]
  return saved === 'assistant' ? 'assistant' : 'social'
}

/** 聊天还在微信白名单里吗（每次投递前都复查一遍）。 */
export function chatAllowed(chat) {
  const parts = String(chat || '').split(':')
  if (parts.length !== 3 || parts[0] !== 'wechat') return false
  const config = readJsonFile(join(WECHAT_ROOT, 'config', 'wechatagent.json'))
  const list = parts[1] === 'group' ? config?.wechat?.whitelist?.groups : config?.wechat?.whitelist?.private
  return Array.isArray(list) && list.some((id) => String(id) === parts[2])
}

function readerEndpoint() {
  const io = readJsonFile(join(WECHAT_ROOT, 'state', 'wechat-io-config.json'))
  if (!io || !io.reader_base_url) return null
  return {
    base: String(io.reader_base_url).replace(/\/+$/, ''),
    token: String(io.reader_token || ''),
  }
}

/** 聊天键 → 真实 wxid。唯一匹配才认，否则报错（宁可发不出去，也不发错人）。 */
export async function resolveTarget(chat) {
  const reader = readerEndpoint()
  if (!reader) throw new Error('读不到 WeChatAgent 的 reader 配置（state/wechat-io-config.json）')
  const data = await httpJson(reader.base + '/api/v1/sessions?limit=500', {
    headers: { authorization: 'Bearer ' + reader.token },
    timeoutMs: 8000,
  })
  const parts = String(chat).split(':')
  if (parts.length !== 3 || parts[0] !== 'wechat') throw new Error('聊天标识格式不对：' + chat)
  const kind = parts[1]
  const target = parts[2]
  const matches = []
  for (const session of data?.sessions || []) {
    const username = String(session?.username || '')
    if (!username) continue
    const isGroup = username.includes('@chatroom')
    if ((kind === 'group') !== isGroup) continue
    const mapped = session?.conversationId
    if (mapped !== undefined && mapped !== null) {
      if (String(mapped) === String(target)) matches.push(session)
    } else if (String(onebotId(username)) === String(target)) {
      matches.push(session)
    }
  }
  if (matches.length !== 1) throw new Error(`找不到唯一的微信聊天：${chat}（匹配到 ${matches.length} 个）`)
  return {
    wxid: String(matches[0].username),
    kind,
    name: String(matches[0].displayName || matches[0].nickname || ''),
  }
}

async function hookToken() {
  const file = join(WECHAT_ROOT, 'state', 'hook', 'native-token.txt')
  if (!existsSync(file)) throw new Error('微信 hook 没有令牌（微信没开，或 version.dll 没注入）')
  const token = readFileSync(file, 'utf8').trim()
  if (!token) throw new Error('微信 hook 的令牌是空的')
  return { token, file }
}

async function hookAccount(token) {
  try {
    const health = await httpJson(HOOK_BASE + '/WeChatAgent/health', {
      headers: { authorization: 'Bearer ' + token },
      timeoutMs: 4000,
    })
    const accounts = health?.databaseAccounts || []
    return accounts.length === 1 ? String(accounts[0]) : ''
  } catch {
    return ''
  }
}

/** 发一条文字到微信聊天。成功返回 { ok, wxid, confirmed }，失败直接抛错（错误信息是给人看的）。 */
export async function sendText(chat, text) {
  const body = String(text ?? '').trim()
  if (!body) throw new Error('要发的内容是空的')
  if (body.length > 4000) throw new Error('单条太长（超过 4000 字），请拆短一点')
  const { wxid } = await resolveTarget(chat)
  const { token } = await hookToken()
  const account = await hookAccount(token)
  const startedAt = Date.now() / 1000 - 2
  const result = await httpJson(HOOK_BASE + '/SendTextMsg', {
    method: 'POST',
    payload: { wxidorgid: wxid, msg: body },
    headers: {
      authorization: 'Bearer ' + token,
      ...(account ? { 'x-wechatagent-account': account } : {}),
    },
    timeoutMs: 15000,
  })
  if (Number(result?.ret) !== 0) {
    throw new Error('hook 拒绝了这次发送：' + JSON.stringify(result).slice(0, 200))
  }
  // 回执是加分项：拿不到也不当作失败（微信那边可能只是还没落库）。
  let confirmed = false
  try {
    const reader = readerEndpoint()
    if (reader) {
      const data = await httpJson(
        reader.base + '/api/v1/messages?talker=' + encodeURIComponent(wxid) + '&limit=5',
        { headers: { authorization: 'Bearer ' + reader.token }, timeoutMs: 6000 },
      )
      confirmed = (data?.messages || []).some(
        (row) => row?.isSend && Number(row?.createTime || 0) >= startedAt,
      )
    }
  } catch {
    confirmed = false
  }
  return { ok: true, wxid, confirmed }
}

/** 给「装完先自检」用的只读探针：不发送，只看通道在不在。 */
export async function probe(chat) {
  const out = { root: WECHAT_ROOT, reader: false, hook: false, chat: false, target: '' }
  out.reader = Boolean(readerEndpoint())
  out.chat = chatAllowed(chat)
  try {
    await hookToken()
    out.hook = true
  } catch {
    out.hook = false
  }
  if (chat && out.reader) {
    try {
      const target = await resolveTarget(chat)
      out.target = target.name ? `${target.name} (${target.wxid})` : target.wxid
    } catch (error) {
      out.target = '解析失败：' + error.message
    }
  }
  return out
}

export { sleep }
