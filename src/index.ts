#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import bodyParser from 'body-parser';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CacheManager } from './CacheManager.js';
import fs from 'fs-extra';
import path from 'path';
import express, { Response, Request } from 'express';
import * as http from 'http';

const app = express();
app.use(bodyParser.json()); // 新增：支持 JSON 请求体
const cacheManager = new CacheManager();

// 新增：SSE 客户端管理
const sseClients: Response[] = [];

app.get('/events', (req: Request, res: Response) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  // 发送一个初始事件（可选）
  res.write('event: connected\ndata: "SSE connected"\n\n');

  sseClients.push(res);

  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// 新增：SSE 推送函数
export function sendSseEvent(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => client.write(payload));
}

// ========== 新增：MCP HTTP 协议路由 ==========
/**
 * 让 HTTP POST /mcp 支持 MCP 协议
 * 这里直接调用 MemoryCacheServer 的 server 实例的 handleHttpRequest 方法
 * 你需要确保 MemoryCacheServer 实例化后能被访问到
 */

// 先声明一个全局变量用于保存 MemoryCacheServer 实例
let mcpServerInstance: MemoryCacheServer | undefined = undefined;

// MCP HTTP 分发函数
async function handleMcpHttpRequest(server: Server<any, any, any>, body: any) {
  // 打印可用方法
  console.log('Server methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(server)));

  // 依次尝试常见方法
  if (typeof (server as any).receive === 'function') {
    return await (server as any).receive(body);
  }
  if (typeof (server as any).handle === 'function') {
    return await (server as any).handle(body);
  }
  if (typeof (server as any).dispatch === 'function') {
    return await (server as any).dispatch(body);
  }
  throw new Error('No suitable MCP HTTP handler found on Server');
}

// ========== 新增：MCP HTTP 协议路由 ==========
app.post('/mcp', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    switch (body.method) {
      case 'listTools': {
        // 声明 tools 变量
        const tools = [
          {
            name: 'store_data',
            description: 'Store data in the cache with optional TTL',
            inputSchema: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Unique identifier for the cached data' },
                value: {
                  description: 'Data to cache',
                  anyOf: [
                    { type: 'object' },
                    { type: 'array' },
                    { type: 'string' },
                    { type: 'number' },
                    { type: 'boolean' },
                    { type: 'null' }
                  ]
                },
                ttl: { type: 'number', description: 'Time-to-live in seconds (optional)' }
              },
              required: ['key', 'value']
            }
          },
          {
            name: 'retrieve_data',
            description: 'Retrieve data from the cache',
            inputSchema: {
              type: 'object',
              properties: {
                key: {
                  type: 'string',
                  description: 'Key of the cached data to retrieve'
                }
              },
              required: ['key']
            }
          },
          {
            name: 'clear_cache',
            description: 'Clear specific or all cache entries',
            inputSchema: {
              type: 'object',
              properties: {
                key: {
                  type: 'string',
                  description: 'Specific key to clear (optional - clears all if not provided)'
                }
              }
            }
          },
          {
            name: 'get_cache_stats',
            description: 'Get cache statistics',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          }
        ];
        res.json({ tools });
        return;
      }
      case 'callTool': {
        const { name, arguments: args } = body.params || {};
        let result;
        switch (name) {
          case 'store_data':
            cacheManager.set(args.key, args.value, args.ttl);
            result = { content: [{ type: 'text', text: `Stored key: ${args.key}` }] };
            break;
          case 'retrieve_data':
            const value = cacheManager.get(args.key);
            result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
            break;
          case 'clear_cache':
            if (args.key) {
              cacheManager.delete(args.key);
              result = { content: [{ type: 'text', text: `Cleared key: ${args.key}` }] };
            } else {
              cacheManager.clear();
              result = { content: [{ type: 'text', text: 'Cleared all cache' }] };
            }
            break;
          case 'get_cache_stats':
            const stats = cacheManager.getStats();
            result = { content: [{ type: 'text', text: JSON.stringify(stats) }] };
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
        res.json(result);
        return;
      }
      // 其它分支...
      default:
        throw new Error(`Unknown MCP method: ${body.method}`);
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

class MemoryCacheServer {
  public server: Server;
  private cacheManager: CacheManager;

  constructor() {
    // Load configuration
    const configPath = process.env.CONFIG_PATH || path.join(process.cwd(), 'config.json');
    const config = fs.existsSync(configPath) 
      ? fs.readJsonSync(configPath)
      : {};
    
    // Allow environment variable overrides
    const finalConfig = {
      maxEntries: parseInt(process.env.MAX_ENTRIES as string) || config.maxEntries,
      maxMemory: parseInt(process.env.MAX_MEMORY as string) || config.maxMemory,
      defaultTTL: parseInt(process.env.DEFAULT_TTL as string) || config.defaultTTL,
      checkInterval: parseInt(process.env.CHECK_INTERVAL as string) || config.checkInterval,
      statsInterval: parseInt(process.env.STATS_INTERVAL as string) || config.statsInterval
    };

    this.server = new Server(
      {
        name: 'charly-memory-cache-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          resources: {
            'cache://stats': {
              name: 'Cache Statistics',
              mimeType: 'application/json',
              description: 'Real-time cache performance metrics',
            },
          },
          tools: {
            store_data: {
              description: 'Store data in the cache with optional TTL',
              inputSchema: {
                type: 'object',
                properties: {
                  key: { type: 'string', description: 'Unique identifier for the cached data' },
                  value: {
                    description: 'Data to cache',
                    anyOf: [
                      { type: 'object' },
                      { type: 'array' },
                      { type: 'string' },
                      { type: 'number' },
                      { type: 'boolean' },
                      { type: 'null' }
                    ]
                  },
                  ttl: { type: 'number', description: 'Time-to-live in seconds (optional)' },
                },
                required: ['key', 'value'],
              },
            },
            retrieve_data: {
              description: 'Retrieve data from the cache',
              inputSchema: {
                type: 'object',
                properties: {
                  key: {
                    type: 'string',
                    description: 'Key of the cached data to retrieve',
                  },
                },
                required: ['key'],
              },
            },
            clear_cache: {
              description: 'Clear specific or all cache entries',
              inputSchema: {
                type: 'object',
                properties: {
                  key: {
                    type: 'string',
                    description: 'Specific key to clear (optional - clears all if not provided)',
                  },
                },
              },
            },
            get_cache_stats: {
              description: 'Get cache statistics',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
          },
        },
      }
    );

    this.cacheManager = new CacheManager(finalConfig);

    this.setupResourceHandlers();
    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.close();
      process.exit(0);
    });
  }

  private setupResourceHandlers() {
    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: 'cache://stats',
          name: 'Cache Statistics',
          mimeType: 'application/json',
          description: 'Real-time cache performance metrics',
        },
      ],
    }));

    // Handle resource reads
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri === 'cache://stats') {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: 'application/json',
              text: JSON.stringify(this.cacheManager.getStats(), null, 2),
            },
          ],
        };
      }

      throw new McpError(
        ErrorCode.InvalidRequest,
        `Unknown resource: ${request.params.uri}`
      );
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'store_data',
          description: 'Store data in the cache with optional TTL',
          inputSchema: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'Unique identifier for the cached data',
              },
              value: {
                type: 'any',
                description: 'Data to cache',
              },
              ttl: {
                type: 'number',
                description: 'Time-to-live in seconds (optional)',
              },
            },
            required: ['key', 'value'],
          },
        },
        {
          name: 'retrieve_data',
          description: 'Retrieve data from the cache',
          inputSchema: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'Key of the cached data to retrieve',
              },
            },
            required: ['key'],
          },
        },
        {
          name: 'clear_cache',
          description: 'Clear specific or all cache entries',
          inputSchema: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'Specific key to clear (optional - clears all if not provided)',
              },
            },
          },
        },
        {
          name: 'get_cache_stats',
          description: 'Get cache statistics',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        console.log('[MCP] CallToolRequest:', JSON.stringify(request, null, 2));
        switch (request.params.name) {
          case 'store_data': {
            const { key, value, ttl } = request.params.arguments as {
              key: string;
              value: any;
              ttl?: number;
            };
            this.cacheManager.set(key, value, ttl);
            return {
              content: [
                {
                  type: 'text',
                  text: `Successfully stored data with key: ${key}`,
                },
              ],
            };
          }

          case 'retrieve_data': {
            const { key } = request.params.arguments as { key: string };
            const value = this.cacheManager.get(key);
            if (value === undefined) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `No data found for key: ${key}`,
                  },
                ],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(value, null, 2),
                },
              ],
            };
          }

          case 'clear_cache': {
            const { key } = request.params.arguments as { key?: string };
            if (key) {
              const success = this.cacheManager.delete(key);
              return {
                content: [
                  {
                    type: 'text',
                    text: success
                      ? `Successfully cleared cache entry: ${key}`
                      : `No cache entry found for key: ${key}`,
                  },
                ],
              };
            } else {
              this.cacheManager.clear();
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Successfully cleared all cache entries',
                  },
                ],
              };
            }
          }

          case 'get_cache_stats': {
            const stats = this.cacheManager.getStats();
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(stats, null, 2),
                },
              ],
            };
          }

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        console.error('[MCP] Tool error:', error);
        return {
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
          errorCode: 'InvalidArgument',
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Memory Cache MCP server running on stdio');
  }

  async close() {
    this.cacheManager.destroy();
    await this.server.close();
  }
}

const server = new MemoryCacheServer();
mcpServerInstance = server; // 新增：保存实例供 /mcp 路由使用
server.run().catch(console.error);

// 新增：启动 HTTP 服务
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
app.listen(PORT, () => {
  console.log(`SSE/HTTP server listening on http://localhost:${PORT}`);
});

