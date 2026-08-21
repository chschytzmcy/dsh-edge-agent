/**
 * Simple tests to verify DSH native tools configuration.
 */

import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

describe('DSH Native Tools - Configuration Tests', () => {
  it('should configure bash tool in cordis.yml', async () => {
    const cordisPath = join(process.cwd(), 'cordis.yml')
    const content = await readFile(cordisPath, 'utf-8')

    expect(content).toContain('tool-bash')
    expect(content).toContain('@deepseek-ai/dsh-tool-bash')
  })

  it('should configure filesystem tools in cordis.yml', async () => {
    const cordisPath = join(process.cwd(), 'cordis.yml')
    const content = await readFile(cordisPath, 'utf-8')

    expect(content).toContain('tool-fs')
    expect(content).toContain('@deepseek-ai/dsh-tool-fs')
  })

  it('should configure web tools in cordis.yml', async () => {
    const cordisPath = join(process.cwd(), 'cordis.yml')
    const content = await readFile(cordisPath, 'utf-8')

    expect(content).toContain('tool-web')
    expect(content).toContain('@deepseek-ai/dsh-tool-web')
  })

  it('should configure DeepSeek search provider in cordis.yml', async () => {
    const cordisPath = join(process.cwd(), 'cordis.yml')
    const content = await readFile(cordisPath, 'utf-8')

    expect(content).toContain('web-search-deepseek')
    expect(content).toContain('@deepseek-ai/dsh-web-search-deepseek')
    expect(content).toContain('DEEPSEEK_API_KEY')
  })

  it('should not configure removed edge plugins', async () => {
    const cordisPath = join(process.cwd(), 'cordis.yml')
    const content = await readFile(cordisPath, 'utf-8')

    // Verify removed edge plugins are not present
    // Use negative lookahead to avoid matching web-search-deepseek
    expect(content).not.toMatch(/id:\s*local-tools\b/)
    expect(content).not.toMatch(/id:\s*web-search\s*\n/)
  })

  it('should have correct DSH tool package names', async () => {
    const cordisPath = join(process.cwd(), 'cordis.yml')
    const content = await readFile(cordisPath, 'utf-8')

    // Verify correct package names
    expect(content).toContain('@deepseek-ai/dsh-tool-bash')
    expect(content).toContain('@deepseek-ai/dsh-tool-fs')
    expect(content).toContain('@deepseek-ai/dsh-tool-web')
    expect(content).toContain('@deepseek-ai/dsh-web-search-deepseek')
  })

  it('should configure web tools with search and fetch enabled', async () => {
    const cordisPath = join(process.cwd(), 'cordis.yml')
    const content = await readFile(cordisPath, 'utf-8')

    // Find the tool-web section
    const toolWebMatch = content.match(/id:\s*tool-web[\s\S]*?name:\s*'@deepseek-ai\/dsh-tool-web'[\s\S]*?config:\s*([\s\S]*?)(?=\n-|\n#|$)/)

    expect(toolWebMatch).toBeDefined()
    if (toolWebMatch) {
      const config = toolWebMatch[1]
      expect(config).toContain('search: true')
      expect(config).toContain('fetch: true')
    }
  })

  it('should configure bash tool without background execution', async () => {
    const cordisPath = join(process.cwd(), 'cordis.yml')
    const content = await readFile(cordisPath, 'utf-8')

    // Find the tool-bash section
    const toolBashMatch = content.match(/id:\s*tool-bash[\s\S]*?name:\s*'@deepseek-ai\/dsh-tool-bash'[\s\S]*?config:\s*([\s\S]*?)(?=\n-|\n#|$)/)

    expect(toolBashMatch).toBeDefined()
    if (toolBashMatch) {
      const config = toolBashMatch[1]
      expect(config).toContain('enableRunInBackground: false')
    }
  })
})

describe('Removed Plugin Files', () => {
  it('should not have local-tools.ts source file', async () => {
    const fs = await import('node:fs/promises')
    const localToolsPath = join(process.cwd(), 'src/dsh-adapter/local-tools.ts')

    try {
      await fs.access(localToolsPath)
      expect.fail('local-tools.ts should not exist')
    } catch (err: any) {
      expect(err.code).toBe('ENOENT')
    }
  })

  it('should not have web-search.ts source file', async () => {
    const fs = await import('node:fs/promises')
    const webSearchPath = join(process.cwd(), 'src/dsh-adapter/web-search.ts')

    try {
      await fs.access(webSearchPath)
      expect.fail('web-search.ts should not exist')
    } catch (err: any) {
      expect(err.code).toBe('ENOENT')
    }
  })

  it('should not have local-tools.test.ts test file', async () => {
    const fs = await import('node:fs/promises')
    const testPath = join(process.cwd(), 'tests/unit/local-tools.test.ts')

    try {
      await fs.access(testPath)
      expect.fail('local-tools.test.ts should not exist')
    } catch (err: any) {
      expect(err.code).toBe('ENOENT')
    }
  })
})

describe('Package Configuration', () => {
  it('should not export local-tools in package.json', async () => {
    const packagePath = join(process.cwd(), 'package.json')
    const content = await readFile(packagePath, 'utf-8')
    const pkg = JSON.parse(content)

    expect(pkg.exports['./local-tools']).toBeUndefined()
  })

  it('should not export web-search in package.json', async () => {
    const packagePath = join(process.cwd(), 'package.json')
    const content = await readFile(packagePath, 'utf-8')
    const pkg = JSON.parse(content)

    expect(pkg.exports['./web-search']).toBeUndefined()
  })
})
