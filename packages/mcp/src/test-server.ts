import express from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export function createTestMcpServer(port = 0) {
  const app = express();
  app.use(express.json());

  const server = new Server({
    name: 'mcp-test-server',
    version: '1.0.0'
  }, {
    capabilities: {
      tools: {}
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'echo',
          description: 'Echoes the input string',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string' }
            },
            required: ['message']
          }
        },
        {
          name: 'add',
          description: 'Adds two numbers',
          inputSchema: {
            type: 'object',
            properties: {
              a: { type: 'number' },
              b: { type: 'number' }
            },
            required: ['a', 'b']
          }
        },
        {
          name: 'hang_safe',
          description: 'Sleeps forever',
          inputSchema: { type: 'object', properties: {} }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params;
    
    if (name === 'echo') {
      return {
        content: [{ type: 'text', text: args.message }],
        isError: false
      };
    } else if (name === 'add') {
      return {
        content: [{ type: 'text', text: String(args.a + args.b) }],
        isError: false
      };
    } else if (name === 'hang_safe') {
      await new Promise(resolve => setTimeout(resolve, 60000));
      return {
        content: [{ type: 'text', text: 'Woke up' }],
        isError: false
      };
    }
    
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true
    };
  });

  let transport: StreamableHTTPServerTransport | undefined;

  app.all('/mcp', async (req, res) => {
    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });

  app.all('/mcp/messages', async (req, res) => {
    if (transport) {
      await transport.handleRequest(req, res, req.body);
    } else {
      res.status(500).send('No active MCP session');
    }
  });

  let httpServer: any;
  return {
    app,
    server,
    start: () => new Promise<number>((resolve) => {
      httpServer = app.listen(port, () => {
        const addr = httpServer.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve(actualPort);
      });
    }),
    close: () => new Promise<void>((resolve) => {
      if (httpServer) httpServer.close(() => resolve());
      else resolve();
    })
  };
}

if (process.argv[1] && (process.argv[1].endsWith('test-server.ts') || process.argv[1].endsWith('test-server.js'))) {
  const PORT = Number(process.env.PORT) || 3002;
  const s = createTestMcpServer(PORT);
  void s.start().then(p => console.log(`MCP Test Server running on port ${p}`));
}
