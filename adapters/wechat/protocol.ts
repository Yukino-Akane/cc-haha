import crypto from 'node:crypto'

export const WECHAT_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const WECHAT_DEFAULT_BOT_TYPE = '3'

const ILINK_APP_ID = 'bot'
const CHANNEL_VERSION = '2.1.7'
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION)
const QR_LOGIN_TTL_MS = 5 * 60_000
const QR_STATUS_TIMEOUT_MS = 35_000
const GET_UPDATES_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000

type QrLoginStatus = 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'

type ActiveLogin = {
  sessionKey: string
  qrcode: string
  qrcodeUrl: string
  startedAt: number
  currentApiBaseUrl: string
}

type QrCodeResponse = {
  qrcode: string
  qrcode_img_content: string
}

type QrStatusResponse = {
  status: QrLoginStatus
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

export type WechatQrStartResult = {
  qrcodeUrl?: string
  message: string
  sessionKey: string
}

export type WechatQrPollResult = {
  connected: boolean
  status: QrLoginStatus | 'not_started'
  message: string
  botToken?: string
  accountId?: string
  baseUrl?: string
  userId?: string
}

export type WechatMessageItem = {
  type?: number
  msg_id?: string
  text_item?: { text?: string }
  voice_item?: { text?: string }
  media?: WechatCdnMedia
  image_item?: {
    media?: WechatCdnMedia
    thumb_media?: WechatCdnMedia
    aeskey?: string
    url?: string
  }
  file_item?: {
    media?: WechatCdnMedia
    file_name?: string
    len?: string
  }
  video_item?: {
    media?: WechatCdnMedia
    thumb_media?: WechatCdnMedia
  }
  ref_msg?: {
    title?: string
    message_item?: WechatMessageItem
  }
}

export type WechatCdnMedia = {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
}

export type WechatMessage = {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  session_id?: string
  message_type?: number
  message_state?: number
  item_list?: WechatMessageItem[]
  context_token?: string
}

export type WechatGetUpdatesResp = {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WechatMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

const activeLogins = new Map<string, ActiveLogin>()

export function buildClientVersion(version: string): number {
  const parts = version.split('.').map((p) => parseInt(p, 10))
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

export function extractWechatText(itemList?: WechatMessageItem[]): string {
  if (!itemList?.length) return ''
  for (const item of itemList) {
    if (item.type === 1 && item.text_item?.text != null) {
      const text = String(item.text_item.text)
      const ref = item.ref_msg
      if (!ref) return text
      const parts: string[] = []
      if (ref.title) parts.push(ref.title)
      if (ref.message_item) {
        const refBody = extractWechatText([ref.message_item])
        if (refBody) parts.push(refBody)
      }
      return parts.length ? `[引用: ${parts.join(' | ')}]\n${text}` : text
    }
    if (item.type === 3 && item.voice_item?.text) {
      return item.voice_item.text
    }
  }
  return ''
}

export async function startWechatLoginWithQr(opts: {
  force?: boolean
  sessionKey?: string
  botType?: string
} = {}): Promise<WechatQrStartResult> {
  purgeExpiredLogins()

  const sessionKey = opts.sessionKey || crypto.randomUUID()
  const existing = activeLogins.get(sessionKey)
  if (!opts.force && existing && isLoginFresh(existing)) {
    return {
      qrcodeUrl: existing.qrcodeUrl,
      message: '二维码已就绪，请使用微信扫描。',
      sessionKey,
    }
  }

  const botType = opts.botType || WECHAT_DEFAULT_BOT_TYPE
  const rawText = await apiGetFetch({
    baseUrl: WECHAT_DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    label: 'wechatQrStart',
  })
  const qr = JSON.parse(rawText) as QrCodeResponse
  if (!qr.qrcode || !qr.qrcode_img_content) {
    throw new Error('WeChat QR response did not include a QR code URL')
  }

  activeLogins.set(sessionKey, {
    sessionKey,
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    startedAt: Date.now(),
    currentApiBaseUrl: WECHAT_DEFAULT_BASE_URL,
  })

  return {
    qrcodeUrl: qr.qrcode_img_content,
    message: '使用微信扫描二维码完成绑定。',
    sessionKey,
  }
}

export async function pollWechatLoginWithQr(opts: {
  sessionKey: string
}): Promise<WechatQrPollResult> {
  purgeExpiredLogins()

  const login = activeLogins.get(opts.sessionKey)
  if (!login) {
    return {
      connected: false,
      status: 'not_started',
      message: '当前没有进行中的微信绑定，请重新生成二维码。',
    }
  }

  const status = await pollQrStatus(login.currentApiBaseUrl, login.qrcode)
  switch (status.status) {
    case 'wait':
      return { connected: false, status: 'wait', message: '等待扫码。' }
    case 'scaned':
      return { connected: false, status: 'scaned', message: '已扫码，请在微信中确认。' }
    case 'scaned_but_redirect':
      if (status.redirect_host) {
        login.currentApiBaseUrl = `https://${status.redirect_host}`
      }
      return { connected: false, status: 'scaned_but_redirect', message: '已扫码，正在切换微信网关。' }
    case 'expired':
      activeLogins.delete(opts.sessionKey)
      return { connected: false, status: 'expired', message: '二维码已过期，请重新生成。' }
    case 'confirmed':
      activeLogins.delete(opts.sessionKey)
      if (!status.bot_token || !status.ilink_bot_id) {
        return { connected: false, status: 'confirmed', message: '微信已确认，但服务端未返回完整凭据。' }
      }
      return {
        connected: true,
        status: 'confirmed',
        message: '微信绑定成功。',
        botToken: status.bot_token,
        accountId: status.ilink_bot_id,
        baseUrl: status.baseurl || login.currentApiBaseUrl || WECHAT_DEFAULT_BASE_URL,
        userId: status.ilink_user_id,
      }
  }
}

export async function getWechatUpdates(params: {
  baseUrl: string
  token: string
  getUpdatesBuf?: string
  timeoutMs?: number
}): Promise<WechatGetUpdatesResp> {
  try {
    const rawText = await apiPostFetch({
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: params.getUpdatesBuf ?? '',
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: params.timeoutMs ?? GET_UPDATES_TIMEOUT_MS,
      label: 'wechatGetUpdates',
    })
    return JSON.parse(rawText) as WechatGetUpdatesResp
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf }
    }
    throw err
  }
}

export async function sendWechatText(params: {
  baseUrl: string
  token: string
  to: string
  text: string
  contextToken?: string
  timeoutMs?: number
}): Promise<void> {
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: params.to,
      client_id: `claude-code-haha-wechat-${crypto.randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: params.text ? [{ type: 1, text_item: { text: params.text } }] : undefined,
      context_token: params.contextToken,
    },
    base_info: buildBaseInfo(),
  }

  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify(body),
    token: params.token,
    timeoutMs: params.timeoutMs ?? API_TIMEOUT_MS,
    label: 'wechatSendMessage',
  })
  assertWechatApiOk(rawText, 'wechatSendMessage')
}

export async function getWechatConfig(params: {
  baseUrl: string
  token: string
  ilinkUserId: string
  contextToken?: string
  timeoutMs?: number
}): Promise<{ ret?: number; errmsg?: string; typing_ticket?: string }> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? 10_000,
    label: 'wechatGetConfig',
  })
  return JSON.parse(rawText) as { ret?: number; errmsg?: string; typing_ticket?: string }
}

export async function sendWechatTyping(params: {
  baseUrl: string
  token: string
  ilinkUserId: string
  typingTicket: string
  status: 'typing' | 'cancel'
  timeoutMs?: number
}): Promise<void> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      typing_ticket: params.typingTicket,
      status: params.status === 'typing' ? 1 : 2,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? 10_000,
    label: 'wechatSendTyping',
  })
  assertWechatApiOk(rawText, 'wechatSendTyping')
}

async function pollQrStatus(apiBaseUrl: string, qrcode: string): Promise<QrStatusResponse> {
  try {
    const rawText = await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: QR_STATUS_TIMEOUT_MS,
      label: 'wechatQrStatus',
    })
    return JSON.parse(rawText) as QrStatusResponse
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { status: 'wait' }
    return { status: 'wait' }
  }
}

async function apiGetFetch(params: {
  baseUrl: string
  endpoint: string
  timeoutMs?: number
  label: string
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl))
  const controller = params.timeoutMs ? new AbortController() : undefined
  const timer = controller ? setTimeout(() => controller.abort(), params.timeoutMs) : undefined
  try {
    const request = {
      method: 'GET',
      headers: buildCommonHeaders(),
      ...(controller ? { signal: controller.signal } : {}),
    } satisfies RequestInit
    const res = await fetchWithCurlFallback(url.toString(), request, {
      label: params.label,
      timeoutMs: params.timeoutMs,
    })
    const rawText = await res.text()
    if (!res.ok) throw new Error(`${params.label} ${res.status}: ${rawText}`)
    return rawText
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function apiPostFetch(params: {
  baseUrl: string
  endpoint: string
  body: string
  token?: string
  timeoutMs: number
  label: string
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs)
  try {
    const request = {
      method: 'POST',
      headers: buildHeaders({ token: params.token, body: params.body }),
      body: params.body,
      signal: controller.signal,
    } satisfies RequestInit
    const res = await fetchWithCurlFallback(url.toString(), request, {
      label: params.label,
      timeoutMs: params.timeoutMs,
    })
    const rawText = await res.text()
    if (!res.ok) throw new Error(`${params.label} ${res.status}: ${rawText}`)
    return rawText
  } finally {
    clearTimeout(timer)
  }
}

async function fetchWithCurlFallback(
  url: string,
  request: RequestInit,
  opts: { label: string; timeoutMs?: number },
): Promise<Response> {
  try {
    return await fetch(url, request)
  } catch (err) {
    if (!shouldUseCurlFallback(err)) throw err
    return fetchViaCurl(url, request, opts)
  }
}

function shouldUseCurlFallback(err: unknown): boolean {
  if (process.platform !== 'win32') return false
  if (err instanceof Error && err.name === 'AbortError') return false

  const record = err as { code?: unknown; message?: unknown }
  const code = typeof record?.code === 'string' ? record.code.toUpperCase() : ''
  const message = typeof record?.message === 'string' ? record.message.toLowerCase() : ''

  return code === 'ECONNREFUSED'
    || code === 'CONNECTIONREFUSED'
    || message.includes('connectionrefused')
    || message.includes('unable to connect')
}

async function fetchViaCurl(
  url: string,
  request: RequestInit,
  opts: { label: string; timeoutMs?: number },
): Promise<Response> {
  const { spawn } = await import('node:child_process')
  const method = String(request.method || 'GET').toUpperCase()
  const headers = normalizeHeaders(request.headers)
  const body = typeof request.body === 'string' ? request.body : undefined
  const marker = `__AKANE_CURL_HTTP_STATUS_${Date.now()}__`
  const args = [
    '-sS',
    '-L',
    '-X',
    method,
    '--max-time',
    String(Math.max(1, Math.ceil((opts.timeoutMs ?? API_TIMEOUT_MS) / 1000))),
  ]

  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`)
  }

  if (body !== undefined) {
    args.push('--data-binary', '@-')
  }

  args.push('-w', `\n${marker}:%{http_code}`, url)

  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('curl.exe', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      settled = true
      child.kill()
      reject(new Error(`${opts.label} curl fallback timed out after ${opts.timeoutMs ?? API_TIMEOUT_MS}ms`))
    }, opts.timeoutMs ?? API_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(err)
    })
    child.on('close', (status) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ status, stdout, stderr })
    })
    child.stdin.end(body)
  })

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`${opts.label} curl fallback failed (${result.status ?? 'unknown'}): ${detail}`)
  }

  const stdout = result.stdout || ''
  const markerIndex = stdout.lastIndexOf(`\n${marker}:`)
  if (markerIndex === -1) {
    throw new Error(`${opts.label} curl fallback did not return an HTTP status`)
  }

  const rawText = stdout.slice(0, markerIndex)
  const statusText = stdout.slice(markerIndex + marker.length + 2).trim()
  const status = Number.parseInt(statusText, 10)
  if (!Number.isFinite(status)) {
    throw new Error(`${opts.label} curl fallback returned invalid HTTP status: ${statusText}`)
  }

  return new Response(rawText, { status })
}

function normalizeHeaders(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, value]))
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]))
}

function buildBaseInfo(): { channel_version: string } {
  return { channel_version: CHANNEL_VERSION }
}

function buildCommonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(opts.body, 'utf-8')),
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  }
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`
  }
  return headers
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function assertWechatApiOk(rawText: string, label: string): void {
  if (!rawText.trim()) return

  let body: unknown
  try {
    body = JSON.parse(rawText)
  } catch {
    return
  }

  if (!body || typeof body !== 'object') return

  const record = body as Record<string, unknown>
  const code = typeof record.ret === 'number'
    ? record.ret
    : typeof record.errcode === 'number'
      ? record.errcode
      : 0
  if (code === 0) return

  const message = typeof record.errmsg === 'string' ? record.errmsg : rawText
  throw new Error(`${label} returned ${code}: ${message}`)
}

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < QR_LOGIN_TTL_MS
}

function purgeExpiredLogins(): void {
  for (const [sessionKey, login] of activeLogins) {
    if (!isLoginFresh(login)) activeLogins.delete(sessionKey)
  }
}
