#!/usr/bin/env node
/**
 * Anthropic-to-GPT Proxy Adapter with Full SSE Streaming Support
 *
 * Architecture:
 *   Claude Code -> Anthropic-compatible Proxy (this script) -> OpenAI/GPT API
 *   Claude Code -> MCP -> lnwjud-mcp-stdio -> Ubuntu Local Execution
 *
 * Usage:
 *   OPENAI_API_KEY="your-key" node scripts/anthropic-gpt-proxy.mjs
 *   (or set ANTHROPIC_BASE_URL="http://127.0.0.1:8080" for Claude Code)
 */

import http from 'node:http';

const PORT = parseInt(process.env.PORT || process.env.ANTHROPIC_PROXY_PORT || '8080', 10);
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

function transformAnthropicToOpenAI(anthropicReq) {
  const messages = [];

  if (anthropicReq.system) {
    const systemContent = Array.isArray(anthropicReq.system)
      ? anthropicReq.system.map((s) => (typeof s === 'string' ? s : s.text)).join('\n')
      : String(anthropicReq.system);
    messages.push({ role: 'system', content: systemContent });
  }

  if (Array.isArray(anthropicReq.messages)) {
    for (const msg of anthropicReq.messages) {
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const parts = [];
        const toolCalls = [];

        for (const item of msg.content) {
          if (item.type === 'text') {
            parts.push(item.text);
          } else if (item.type === 'tool_use') {
            toolCalls.push({
              id: item.id,
              type: 'function',
              function: {
                name: item.name,
                arguments: JSON.stringify(item.input || {}),
              },
            });
          } else if (item.type === 'tool_result') {
            const content = typeof item.content === 'string'
              ? item.content
              : JSON.stringify(item.content || '');
            messages.push({
              role: 'tool',
              tool_call_id: item.tool_use_id,
              content,
            });
          }
        }

        if (parts.length > 0 || toolCalls.length > 0) {
          const formatted = { role: msg.role };
          if (parts.length > 0) formatted.content = parts.join('\n');
          if (toolCalls.length > 0) formatted.tool_calls = toolCalls;
          messages.push(formatted);
        }
      }
    }
  }

  const openAiReq = {
    model: DEFAULT_MODEL,
    messages,
    max_tokens: anthropicReq.max_tokens || 4096,
  };

  if (anthropicReq.temperature !== undefined) {
    openAiReq.temperature = anthropicReq.temperature;
  }

  if (Array.isArray(anthropicReq.tools) && anthropicReq.tools.length > 0) {
    openAiReq.tools = anthropicReq.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  if (anthropicReq.stream === true) {
    openAiReq.stream = true;
  }

  return openAiReq;
}

function transformOpenAIToAnthropic(openAiRes, model) {
  const choice = openAiRes.choices?.[0];
  const message = choice?.message;
  const content = [];

  if (message?.content) {
    content.push({ type: 'text', text: message.content });
  }

  if (Array.isArray(message?.tool_calls)) {
    for (const call of message.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: args,
      });
    }
  }

  let stopReason = 'end_turn';
  if (choice?.finish_reason === 'tool_calls') {
    stopReason = 'tool_use';
  } else if (choice?.finish_reason === 'length') {
    stopReason = 'max_tokens';
  }

  return {
    id: `msg_${openAiRes.id || Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openAiRes.usage?.prompt_tokens || 0,
      output_tokens: openAiRes.usage?.completion_tokens || 0,
    },
  };
}

function sendSseEvent(res, eventName, data) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleStreamingResponse(openAiRes, res, model) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const msgId = `msg_${Date.now()}`;
  sendSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let blockStarted = false;
  let currentBlockIndex = 0;
  let finishReason = 'end_turn';
  const toolCallsAcc = new Map();

  const reader = openAiRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const rawData = trimmed.slice(6).trim();
      if (rawData === '[DONE]') break;

      try {
        const chunk = JSON.parse(rawData);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;

        if (choice?.finish_reason) {
          finishReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason;
        }

        if (delta?.content) {
          if (!blockStarted) {
            sendSseEvent(res, 'content_block_start', {
              type: 'content_block_start',
              index: currentBlockIndex,
              content_block: { type: 'text', text: '' },
            });
            blockStarted = true;
          }
          sendSseEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'text_delta', text: delta.content },
          });
        }

        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            if (!toolCallsAcc.has(index)) {
              toolCallsAcc.set(index, { id: tc.id || `call_${index}`, name: tc.function?.name || '', args: tc.function?.arguments || '' });
            } else {
              const existing = toolCallsAcc.get(index);
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.args += tc.function.arguments;
            }
          }
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  if (blockStarted) {
    sendSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: currentBlockIndex,
    });
    currentBlockIndex++;
  }

  for (const [, tc] of toolCallsAcc) {
    let parsedArgs = {};
    try {
      parsedArgs = JSON.parse(tc.args || '{}');
    } catch {
      parsedArgs = {};
    }

    sendSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: currentBlockIndex,
      content_block: {
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: parsedArgs,
      },
    });

    sendSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: currentBlockIndex,
    });
    currentBlockIndex++;
  }

  sendSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: finishReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  });

  sendSseEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', proxy: 'anthropic-to-gpt' }));
    return;
  }

  if (req.method === 'POST' && (req.url === '/v1/messages' || req.url === '/messages')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const anthropicReq = JSON.parse(body);
        const openAiReq = transformAnthropicToOpenAI(anthropicReq);

        const openAiRes = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY || req.headers['x-api-key'] || ''}`,
          },
          body: JSON.stringify(openAiReq),
        });

        if (!openAiRes.ok) {
          const errText = await openAiRes.text();
          res.writeHead(openAiRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'api_error', message: errText } }));
          return;
        }

        if (anthropicReq.stream === true) {
          await handleStreamingResponse(openAiRes, res, anthropicReq.model || DEFAULT_MODEL);
        } else {
          const openAiData = await openAiRes.json();
          const anthropicRes = transformOpenAIToAnthropic(openAiData, anthropicReq.model || DEFAULT_MODEL);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(anthropicRes));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'proxy_error', message: err.message } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  process.stdout.write(`Anthropic-to-GPT proxy listening on http://127.0.0.1:${PORT}\n`);
});
