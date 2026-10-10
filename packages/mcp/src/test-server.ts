import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
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
      },
      {
        name: 'hang_unsafe',
        description: 'Sleeps forever unsafe',
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
  } else if (name === 'hang_safe' || name === 'hang_unsafe') {
    await new Promise(resolve => setTimeout(resolve, 1000000));
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

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);

app.all(['/mcp', '/mcp/messages'], async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`MCP Test Server running on port ${PORT}`);
});

