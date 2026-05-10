import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { acquireAdapterLock, AdapterLockError } from '../adapter-lock.js'

describe('AdapterLock', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeConfigDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-lock-'))
    tmpDirs.push(dir)
    return dir
  }

  it('rejects a second live adapter for the same platform and config dir', () => {
    const configDir = makeConfigDir()
    const first = acquireAdapterLock('wechat', {
      configDir,
      pid: 111,
      isProcessRunning: () => true,
    })

    try {
      expect(() => acquireAdapterLock('wechat', {
        configDir,
        pid: 222,
        isProcessRunning: () => true,
      })).toThrow(AdapterLockError)
    } finally {
      first.release()
    }
  })

  it('replaces a stale lock when the recorded pid is gone', () => {
    const configDir = makeConfigDir()
    const first = acquireAdapterLock('wechat', {
      configDir,
      pid: 111,
      isProcessRunning: () => false,
    })

    const second = acquireAdapterLock('wechat', {
      configDir,
      pid: 222,
      isProcessRunning: () => false,
    })

    expect(second.path).toBe(first.path)
    second.release()
    expect(fs.existsSync(second.path)).toBe(false)
  })
})
