import { afterEach, describe, expect, it, mock } from 'bun:test'
import { buildClientVersion, extractWechatText, getWechatUpdates, sendWechatText, sendWechatTyping } from '../protocol.js'
import { collectWechatMediaCandidates } from '../media.js'
import { EventEmitter } from 'node:events'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

describe('WeChat protocol helpers', () => {
  it('encodes iLink client versions like the OpenClaw Weixin plugin', () => {
    expect(buildClientVersion('2.1.7')).toBe((2 << 16) | (1 << 8) | 7)
    expect(buildClientVersion('1.0.11')).toBe(65547)
  })

  it('extracts plain text from WeChat message items', () => {
    expect(extractWechatText([
      { type: 1, text_item: { text: 'hello' } },
    ])).toBe('hello')
  })

  it('extracts voice transcription when text items are absent', () => {
    expect(extractWechatText([
      { type: 3, voice_item: { text: 'voice text' } },
    ])).toBe('voice text')
  })

  it('preserves quoted text context', () => {
    expect(extractWechatText([
      {
        type: 1,
        text_item: { text: 'reply' },
        ref_msg: {
          title: 'quote title',
          message_item: { type: 1, text_item: { text: 'quoted body' } },
        },
      },
    ])).toBe('[引用: quote title | quoted body]\nreply')
  })

  it('collects image and file media candidates from message items', () => {
    expect(collectWechatMediaCandidates([
      {
        type: 2,
        msg_id: 'img-1',
        image_item: {
          aeskey: '00112233445566778899aabbccddeeff',
          media: {
            full_url: 'https://cdn.example.com/image',
            encrypt_query_param: 'enc=1',
          },
        },
      },
      {
        type: 4,
        msg_id: 'file-1',
        file_item: {
          file_name: 'report.pdf',
          media: {
            full_url: 'https://cdn.example.com/file',
            aes_key: Buffer.from('00112233445566778899aabbccddeeff').toString('base64'),
          },
        },
      },
    ])).toMatchObject([
      {
        kind: 'image',
        name: 'wechat-image-img-1.jpg',
        url: 'https://cdn.example.com/image',
      },
      {
        kind: 'file',
        name: 'report.pdf',
        url: 'https://cdn.example.com/file',
        mimeType: 'application/pdf',
      },
    ])
  })

  it('throws when sendmessage returns a non-zero WeChat ret code', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ret: 40001, errmsg: 'bad context_token' }), { status: 200 })) as unknown as typeof fetch

    await expect(sendWechatText({
      baseUrl: 'https://api.example.com',
      token: 'token',
      to: 'user',
      text: 'hello',
      contextToken: 'stale-context',
    })).rejects.toThrow('wechatSendMessage returned 40001: bad context_token')
  })

  it('allows successful sendmessage responses', async () => {
    const requests: string[] = []
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(String(init?.body ?? ''))
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch

    await sendWechatText({
      baseUrl: 'https://api.example.com',
      token: 'token',
      to: 'user',
      text: 'hello',
      contextToken: 'ctx',
    })

    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]!).msg.context_token).toBe('ctx')
  })

  it('throws when sendtyping returns a non-zero WeChat ret code', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ret: 42001, errmsg: 'typing ticket expired' }), { status: 200 })) as unknown as typeof fetch

    await expect(sendWechatTyping({
      baseUrl: 'https://api.example.com',
      token: 'token',
      ilinkUserId: 'user',
      typingTicket: 'ticket',
      status: 'typing',
    })).rejects.toThrow('wechatSendTyping returned 42001: typing ticket expired')
  })

  it('falls back to curl on Windows when Bun fetch cannot reach WeChat', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    globalThis.fetch = (async () => {
      const err = new Error('Unable to connect')
      ;(err as Error & { code?: string }).code = 'ConnectionRefused'
      throw err
    }) as unknown as typeof fetch

    const spawnMock = mock((_command: string, args: string[]) => {
      const statusFormat = args[args.indexOf('-w') + 1] ?? ''
      const child = new EventEmitter() as EventEmitter & {
        stdin: { end: ReturnType<typeof mock> }
        stdout: EventEmitter & { setEncoding: ReturnType<typeof mock> }
        stderr: EventEmitter & { setEncoding: ReturnType<typeof mock> }
        kill: ReturnType<typeof mock>
      }
      child.stdin = { end: mock(() => {}) }
      child.stdout = Object.assign(new EventEmitter(), { setEncoding: mock(() => child.stdout) })
      child.stderr = Object.assign(new EventEmitter(), { setEncoding: mock(() => child.stderr) })
      child.kill = mock(() => true)
      queueMicrotask(() => {
        child.stdout.emit('data', `${JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'buf' })}${statusFormat.replace('%{http_code}', '200')}`)
        child.emit('close', 0)
      })
      return child
    })
    mock.module('node:child_process', () => ({
      spawn: spawnMock,
    }))

    try {
      const resp = await getWechatUpdates({
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'token',
        timeoutMs: 5000,
      })

      expect(resp.get_updates_buf).toBe('buf')
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(spawnMock.mock.calls[0]?.[0]).toBe('curl.exe')
      expect(spawnMock.mock.calls[0]?.[1]).toContain('-X')
      expect(spawnMock.mock.calls[0]?.[1]).toContain('POST')
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    }
  })
})
