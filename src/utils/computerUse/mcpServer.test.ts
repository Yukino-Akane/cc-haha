import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { ComputerUseHostAdapter } from '../../vendor/computer-use-mcp/index.js'
import { createComputerUseMcpServerForCli } from './mcpServer.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let tempConfigDir: string | undefined

function fakeAdapter(): ComputerUseHostAdapter {
  const logger = {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
    silly: () => {},
  }
  return {
    serverName: 'computer-use',
    logger,
    executor: {
      capabilities: {
        screenshotFiltering: 'none',
        platform: 'win32',
        hostBundleId: 'test-host',
      },
      listInstalledApps: async () => [],
      listDisplays: async () => [],
      resolvePrepareCapture: async () => {
        throw new Error('not implemented')
      },
      prepareForAction: async () => {
        throw new Error('not implemented')
      },
      screenshot: async () => {
        throw new Error('not implemented')
      },
      zoom: async () => {
        throw new Error('not implemented')
      },
      click: async () => {
        throw new Error('not implemented')
      },
      doubleClick: async () => {
        throw new Error('not implemented')
      },
      tripleClick: async () => {
        throw new Error('not implemented')
      },
      rightClick: async () => {
        throw new Error('not implemented')
      },
      middleClick: async () => {
        throw new Error('not implemented')
      },
      drag: async () => {
        throw new Error('not implemented')
      },
      moveMouse: async () => {
        throw new Error('not implemented')
      },
      cursorPosition: async () => {
        throw new Error('not implemented')
      },
      scroll: async () => {
        throw new Error('not implemented')
      },
      type: async () => {
        throw new Error('not implemented')
      },
      key: async () => {
        throw new Error('not implemented')
      },
      holdKey: async () => {
        throw new Error('not implemented')
      },
      leftMouseDown: async () => {
        throw new Error('not implemented')
      },
      leftMouseUp: async () => {
        throw new Error('not implemented')
      },
      openApplication: async () => {
        throw new Error('not implemented')
      },
      readClipboard: async () => '',
      writeClipboard: async () => {},
      restoreHiddenApps: async () => {},
    },
    ensureOsPermissions: async () => ({ granted: true }),
    isDisabled: () => false,
    getAutoUnhideEnabled: () => true,
    getSubGates: () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: false,
    }),
    cropRawPatch: () => null,
  }
}

async function connectTestClient() {
  const server = await createComputerUseMcpServerForCli({
    adapter: fakeAdapter(),
    enumerateInstalledApps: false,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'computer-use-test', version: '0.0.0' })
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return { client, server }
}

afterEach(async () => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true })
    tempConfigDir = undefined
  }
})

describe('createComputerUseMcpServerForCli', () => {
  test('binds a standalone session context for persisted read-only calls', async () => {
    tempConfigDir = await mkdtemp(join(tmpdir(), 'computer-use-mcp-cli-'))
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir
    await mkdir(join(tempConfigDir, 'cc-haha'), { recursive: true })
    await writeFile(
      join(tempConfigDir, 'cc-haha', 'computer-use-config.json'),
      JSON.stringify({
        enabled: true,
        authorizedApps: [
          {
            bundleId: 'chrome',
            displayName: 'Google Chrome',
            authorizedAt: '2026-05-10T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )

    const { client } = await connectTestClient()
    try {
      const list = await client.listTools()
      expect(list.tools).toHaveLength(24)

      const result = await client.callTool({
        name: 'list_granted_applications',
        arguments: {},
      })

      expect(result.isError).not.toBe(true)
      expect(JSON.stringify(result.content)).toContain('Google Chrome')
      expect(JSON.stringify(result.content)).not.toContain('not wired to a session')
    } finally {
      await client.close()
    }
  })
})
