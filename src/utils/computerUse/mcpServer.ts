import {
  buildComputerUseTools,
  createComputerUseMcpServer,
  DEFAULT_GRANT_FLAGS,
  type AppGrant,
  type ComputerUseHostAdapter,
  type ComputerUseSessionContext,
  type CuGrantFlags,
  type CuPermissionRequest,
  type CuPermissionResponse,
  type ScreenshotDims,
} from '../../vendor/computer-use-mcp/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { homedir } from 'os'

import { shutdownDatadog } from '../../services/analytics/datadog.js'
import { shutdown1PEventLogging } from '../../services/analytics/firstPartyEventLogger.js'
import { initializeAnalyticsSink } from '../../services/analytics/sink.js'
import { enableConfigs } from '../config.js'
import { logForDebugging } from '../debug.js'
import { filterAppsForDescription } from './appNames.js'
import { checkComputerUseLock, tryAcquireComputerUseLock } from './computerUseLock.js'
import { getChicagoCoordinateMode } from './gates.js'
import { getComputerUseHostAdapter } from './hostAdapter.js'
import { loadStoredComputerUseConfig, saveStoredComputerUseConfig } from './preauthorizedConfig.js'
import { getSessionId } from '../../bootstrap/state.js'

const APP_ENUM_TIMEOUT_MS = 1000

/**
 * Enumerate installed apps, timed. Fails soft — if Spotlight is slow or
 * claude-swift throws, the tool description just omits the list. Resolution
 * happens at call time regardless; the model just doesn't get hints.
 */
async function tryGetInstalledAppNames(): Promise<string[] | undefined> {
  const adapter = getComputerUseHostAdapter()
  const enumP = adapter.executor.listInstalledApps()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<undefined>(resolve => {
    timer = setTimeout(resolve, APP_ENUM_TIMEOUT_MS, undefined)
  })
  const installed = await Promise.race([enumP, timeoutP])
    .catch(() => undefined)
    .finally(() => clearTimeout(timer))
  if (!installed) {
    // The enumeration continues in the background — swallow late rejections.
    void enumP.catch(() => {})
    logForDebugging(
      `[Computer Use MCP] app enumeration exceeded ${APP_ENUM_TIMEOUT_MS}ms or failed; tool description omits list`,
    )
    return undefined
  }
  return filterAppsForDescription(installed, homedir())
}

/**
 * Construct the in-process server. Delegates to the package's
 * `createComputerUseMcpServer` for the Server object + stub CallTool handler,
 * then REPLACES the ListTools handler with one that includes installed-app
 * names in the `request_access` description (the package's factory doesn't
 * take `installedAppNames`, and Cowork builds its own tool array in
 * serverDef.ts for the same reason).
 *
 * Async so the 1s app-enumeration timeout doesn't block startup — called from
 * an `await import()` in `client.ts` on first CU connection, not `main.tsx`.
 *
 * Standalone stdio MCP server used when Claude launches this entrypoint from
 * user/project MCP config. Unlike the in-process client.ts path, there is no
 * ToolUseContext to borrow; bind the persisted desktop Computer Use config to
 * a small session context so CallTool is real instead of the legacy stub.
 */
function formatLockHeld(holder: string): string {
  return `Computer use is in use by another Claude session (${holder.slice(0, 8)}...). Wait for that session to finish or run /exit there.`
}

async function requestDesktopPermission(
  request: CuPermissionRequest,
  signal: AbortSignal,
): Promise<CuPermissionResponse> {
  const desktopServerUrl = process.env.CC_HAHA_DESKTOP_SERVER_URL
  if (!desktopServerUrl) {
    throw new Error(
      'Desktop Computer Use approval bridge is not configured for this standalone MCP server.',
    )
  }

  const response = await fetch(`${desktopServerUrl}/api/computer-use/request-access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: getSessionId(),
      request,
    }),
    signal,
  })
  if (!response.ok) {
    const message = await response.text().catch(() => '')
    throw new Error(
      `Desktop Computer Use approval failed (${response.status}): ${message || response.statusText}`,
    )
  }
  return await response.json() as CuPermissionResponse
}

async function createStandaloneSessionContext(): Promise<ComputerUseSessionContext> {
  const stored = await loadStoredComputerUseConfig()
  let allowedApps: AppGrant[] = stored.authorizedApps.map(app => ({
    bundleId: app.bundleId,
    displayName: app.displayName,
    grantedAt: app.authorizedAt ? Date.parse(app.authorizedAt) || Date.now() : Date.now(),
    tier: 'full' as const,
  }))
  let grantFlags: CuGrantFlags = {
    ...DEFAULT_GRANT_FLAGS,
    ...stored.grantFlags,
  }
  let selectedDisplayId: number | undefined
  let displayPinnedByModel = false
  let displayResolvedForApps: string | undefined
  let lastScreenshotDims: ScreenshotDims | undefined
  let clipboardStash: string | undefined

  return {
    getAllowedApps: () => allowedApps,
    getGrantFlags: () => grantFlags,
    getUserDeniedBundleIds: () => [],
    getSelectedDisplayId: () => selectedDisplayId,
    getDisplayPinnedByModel: () => displayPinnedByModel,
    getDisplayResolvedForApps: () => displayResolvedForApps,
    getLastScreenshotDims: () => lastScreenshotDims,
    onPermissionRequest: requestDesktopPermission,
    onAllowedAppsChanged: (apps, flags) => {
      allowedApps = [...apps]
      grantFlags = flags
      void saveStoredComputerUseConfig({
        enabled: stored.enabled,
        authorizedApps: allowedApps.map(app => ({
          bundleId: app.bundleId,
          displayName: app.displayName,
          authorizedAt: new Date(app.grantedAt).toISOString(),
        })),
        grantFlags,
      }).catch(error => {
        logForDebugging(
          `[Computer Use MCP] failed to persist standalone allowed apps: ${String(error)}`,
        )
      })
    },
    getClipboardStash: () => clipboardStash,
    onClipboardStashChanged: stash => {
      clipboardStash = stash
    },
    onResolvedDisplayUpdated: id => {
      selectedDisplayId = id
      displayPinnedByModel = false
      displayResolvedForApps = undefined
    },
    onDisplayPinned: id => {
      selectedDisplayId = id
      displayPinnedByModel = id !== undefined
      if (id === undefined) {
        displayResolvedForApps = undefined
      }
    },
    onDisplayResolvedForApps: key => {
      displayResolvedForApps = key
    },
    onScreenshotCaptured: dims => {
      lastScreenshotDims = dims
    },
    checkCuLock: async () => {
      const lock = await checkComputerUseLock()
      switch (lock.kind) {
        case 'free':
          return { holder: undefined, isSelf: false }
        case 'held_by_self':
          return { holder: getSessionId(), isSelf: true }
        case 'blocked':
          return { holder: lock.by, isSelf: false }
      }
    },
    acquireCuLock: async () => {
      const lock = await tryAcquireComputerUseLock()
      if (lock.kind === 'blocked') {
        throw new Error(formatLockHeld(lock.by))
      }
    },
    formatLockHeldMessage: formatLockHeld,
  }
}

export async function createComputerUseMcpServerForCli(options: {
  adapter?: ComputerUseHostAdapter
  enumerateInstalledApps?: boolean
} = {}): Promise<
  ReturnType<typeof createComputerUseMcpServer>
> {
  const adapter = options.adapter ?? getComputerUseHostAdapter()
  const coordinateMode = getChicagoCoordinateMode()
  const context = await createStandaloneSessionContext()
  const server = createComputerUseMcpServer(adapter, coordinateMode, context)

  const installedAppNames = options.enumerateInstalledApps === false
    ? undefined
    : await tryGetInstalledAppNames()
  const tools = buildComputerUseTools(
    adapter.executor.capabilities,
    coordinateMode,
    installedAppNames,
  )
  server.setRequestHandler(ListToolsRequestSchema, async () =>
    adapter.isDisabled() ? { tools: [] } : { tools },
  )

  return server
}

/**
 * Subprocess entrypoint for `--computer-use-mcp`. Mirror of
 * `runClaudeInChromeMcpServer` — stdio transport, exit on stdin close,
 * flush analytics before exit.
 */
export async function runComputerUseMcpServer(): Promise<void> {
  enableConfigs()
  initializeAnalyticsSink()

  const server = await createComputerUseMcpServerForCli()
  const transport = new StdioServerTransport()

  let exiting = false
  const shutdownAndExit = async (): Promise<void> => {
    if (exiting) return
    exiting = true
    await Promise.all([shutdown1PEventLogging(), shutdownDatadog()])
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }
  process.stdin.on('end', () => void shutdownAndExit())
  process.stdin.on('error', () => void shutdownAndExit())

  logForDebugging('[Computer Use MCP] Starting MCP server')
  await server.connect(transport)
  logForDebugging('[Computer Use MCP] MCP server started')
}
