import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/server';
import { ModernTasksProtocol } from './modern-tasks-protocol.js';
import {
  maybeHandleModernTasksWireRequest,
  maybeTransformModernTasksWireResponse,
  requestSupportsModernTasks,
} from './modern-tasks-wire.js';

/**
 * Wraps a connection-oriented transport so extension-aware tools/call
 * responses can become CreateTaskResult only after the SDK has validated the
 * ordinary CallToolResult. Custom tasks/* requests still flow through the
 * SDK request router registered by registerModernTasksProtocol.
 */
export function createModernTasksTransport(
  delegate: Transport,
  protocol: ModernTasksProtocol,
): Transport {
  const pendingToolCalls = new Map<string | number, JSONRPCMessage>();

  const transport: Transport = {
    ...(delegate.hasPerRequestStream === undefined ? {} : { hasPerRequestStream: delegate.hasPerRequestStream }),
    async start(): Promise<void> {
      delegate.onclose = (): void => transport.onclose?.();
      delegate.onerror = (error): void => transport.onerror?.(error);
      delegate.onmessage = (message, extra): void => {
        if (isJSONRPCRequest(message)) {
          void maybeHandleModernTasksWireRequest(protocol, message).then(async (handled) => {
            if (handled !== undefined) {
              await delegate.send(handled);
              return;
            }
            if (message.method === 'tools/call' && requestSupportsModernTasks(message)) {
              const requestId = asRequestId(message.id);
              if (requestId !== undefined) pendingToolCalls.set(requestId, message);
            }
            transport.onmessage?.(message, extra);
          }).catch((error: unknown) => {
            transport.onerror?.(error instanceof Error ? error : new Error('Modern Tasks transport failed'));
          });
          return;
        }
        if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
          const requestId = asRequestId(message.params?.requestId);
          if (requestId !== undefined) pendingToolCalls.delete(requestId);
        }
        transport.onmessage?.(message, extra);
      };
      await delegate.start();
    },
    async send(message, options): Promise<void> {
      let outgoing = message;
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        const requestId = asRequestId(message.id);
        const request = requestId === undefined ? undefined : pendingToolCalls.get(requestId);
        if (requestId !== undefined && request !== undefined) {
          pendingToolCalls.delete(requestId);
          outgoing = await maybeTransformModernTasksWireResponse(protocol, request, message);
        }
      }
      await delegate.send(outgoing, options);
    },
    async close(): Promise<void> {
      pendingToolCalls.clear();
      await delegate.close();
    },
    setProtocolVersion(version): void {
      delegate.setProtocolVersion?.(version);
    },
    setSupportedProtocolVersions(versions): void {
      delegate.setSupportedProtocolVersions?.(versions);
    },
  };

  return transport;
}

function asRequestId(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}
