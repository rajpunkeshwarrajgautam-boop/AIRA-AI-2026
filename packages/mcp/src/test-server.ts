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
  }
  
  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true
  };
});

let transport: StreamableHTTPServerTransport;

app.get('/mcp', async (req, res) => {
  transport = new StreamableHTTPServerTransport('/mcp/messages', res);
  await server.connect(transport);
});

app.post('/mcp/messages', async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(500).send('No active MCP session');
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`MCP Test Server running on port ${PORT}`);
});
