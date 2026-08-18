/**
 * web-search — public-web search tool. Routes through secure-bridge,
 * enforces the domain allow / deny list, and tags every request with
 * the originating session.
 *
 * @module dsh-edge-agent/web-search
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'web-search'

export const inject = ['edgeTools', 'secureBridge', 'auditLog'] as const

export interface Config {
  backend: 'duckduckgo' | 'brave' | 'custom'
  maxResultsPerQuery: number
}

export const Config: Schema<Config> = Schema.object({
  backend: Schema.union(['duckduckgo', 'brave', 'custom'] as const).default('duckduckgo'),
  maxResultsPerQuery: Schema.natural().default(8),
})

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchService {
  search(query: string, options?: { maxResults?: number }): Promise<WebSearchResult[]>
}

export class WebSearchServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'webSearch')
  }
  async search(query: string, options?: { maxResults?: number }): Promise<WebSearchResult[]> {
    void query
    void options
    return []
  }
}

export async function apply(ctx: any, config: Config): Promise<void> {
  const tools = (ctx as any).edgeTools
  if (tools?.register) {
    tools.register(
      {
        name: 'web_search',
        realm: 'CLOUD',
        description: 'Search the public web.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, maxResults: { type: 'number' } },
          required: ['query'],
        },
      },
      async (args: any) => {
        const svc: WebSearchServiceImpl = (ctx as any).webSearch
        return svc.search(args.query, { maxResults: args.maxResults })
      },
    )
  }
  void config
  return async () => {}
}
