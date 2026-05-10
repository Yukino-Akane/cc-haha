import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export class AdapterLockError extends Error {
  constructor(
    message: string,
    readonly lockPath: string,
    readonly pid?: number,
  ) {
    super(message)
    this.name = 'AdapterLockError'
  }
}

export type AdapterLock = {
  path: string
  release: () => void
}

type AdapterLockOptions = {
  configDir?: string
  pid?: number
  isProcessRunning?: (pid: number) => boolean
}

type LockRecord = {
  platform: string
  pid: number
  configDir: string
  createdAt: string
}

export function acquireAdapterLock(platform: string, options: AdapterLockOptions = {}): AdapterLock {
  const configDir = path.resolve(options.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))
  const pid = options.pid ?? process.pid
  const isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning
  const lockDir = path.join(configDir, 'adapter-locks')
  const lockPath = path.join(lockDir, `${platform}.lock`)
  fs.mkdirSync(lockDir, { recursive: true })

  const existing = readLock(lockPath)
  if (existing && existing.pid !== pid && isProcessRunning(existing.pid)) {
    throw new AdapterLockError(
      `${platform} adapter is already running as PID ${existing.pid}. Stop it before starting another instance.`,
      lockPath,
      existing.pid,
    )
  }

  const record: LockRecord = {
    platform,
    pid,
    configDir,
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(lockPath, JSON.stringify(record, null, 2) + '\n', 'utf8')

  return {
    path: lockPath,
    release: () => {
      const current = readLock(lockPath)
      if (!current || current.pid === pid) {
        fs.rmSync(lockPath, { force: true })
      }
    },
  }
}

function readLock(lockPath: string): LockRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    if (!value || typeof value !== 'object') return null
    const record = value as Partial<LockRecord>
    if (typeof record.pid !== 'number' || !Number.isFinite(record.pid)) return null
    if (typeof record.platform !== 'string' || typeof record.configDir !== 'string') return null
    return record as LockRecord
  } catch {
    return null
  }
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
