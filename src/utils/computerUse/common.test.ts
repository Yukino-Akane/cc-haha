import { describe, expect, it } from 'bun:test'

import {
  COMPUTER_USE_MCP_SERVER_NAME,
  getCliComputerUseCapabilities,
  isComputerUseMCPServer,
  isComputerUseSupportedPlatform,
} from './common.js'
import { setupComputerUseMCP } from './setup.js'

describe('computer use platform helpers', () => {
  it('recognizes supported platforms', () => {
    expect(isComputerUseSupportedPlatform('darwin')).toBe(true)
    expect(isComputerUseSupportedPlatform('win32')).toBe(true)
    expect(isComputerUseSupportedPlatform('linux')).toBe(false)
  })

  it('returns macOS capabilities with native screenshot filtering', () => {
    expect(getCliComputerUseCapabilities('darwin')).toEqual({
      screenshotFiltering: 'native',
      platform: 'darwin',
    })
  })

  it('returns Windows capabilities with unfiltered screenshots', () => {
    expect(getCliComputerUseCapabilities('win32')).toEqual({
      screenshotFiltering: 'none',
      platform: 'win32',
    })
  })

  it('uses the Akane-specific MCP server name for dynamic config and allowed tools', () => {
    const { mcpConfig, allowedTools } = setupComputerUseMCP()

    expect(COMPUTER_USE_MCP_SERVER_NAME).toBe('akane-computer-use')
    expect(isComputerUseMCPServer('akane-computer-use')).toBe(true)
    expect(isComputerUseMCPServer('computer-use')).toBe(false)
    expect(mcpConfig['akane-computer-use']).toBeDefined()
    expect(mcpConfig['computer-use']).toBeUndefined()
    expect(allowedTools.length).toBeGreaterThan(0)
    expect(allowedTools.every(tool => tool.startsWith('mcp__akane-computer-use__'))).toBe(true)
    expect(allowedTools.some(tool => tool.startsWith('mcp__computer-use__'))).toBe(false)
  })
})
