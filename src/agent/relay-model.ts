import { z } from 'zod';
import type { OutboundGate, Transport } from '../gate/gate';
import type { ModelAdapter, ModelRequest, ModelResponse } from './types';

/**
 * Hosted-model adapter (decision D5): the request goes through the outbound
 * gate, which redacts and records it, and from there to the stateless relay,
 * which adds the API key (PRD Section 9). The browser never sees the key and
 * never talks to the provider directly.
 *
 * Nothing about safety depends on what comes back. A reply is only text and
 * tool requests: the tier engine decides every request, and the orchestrator
 * checks the text.
 */
export const RELAY_ENDPOINT = '/api/model';

const RelayReplySchema = z.object({
  content: z.string().nullish(),
  toolCalls: z.array(z.object({ name: z.string().min(1), arguments: z.unknown() })).nullish(),
});

/** The transport the gate uses when a hosted model is switched on. */
export function createRelayTransport(endpoint: string = RELAY_ENDPOINT): Transport {
  return {
    send: async (request) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.payload),
      });
      if (!response.ok) {
        // The relay says why ("the model provider returned 429"); keep that for the user.
        const detail = await response
          .json()
          .then((body: unknown) => (body as { error?: unknown }).error)
          .catch(() => undefined);
        throw new Error(
          `the relay answered ${response.status}${typeof detail === 'string' ? ` (${detail})` : ''}`,
        );
      }
      return (await response.json()) as unknown;
    },
  };
}

/** "Options: Health | Travel" on the last line becomes buttons (CHAT-2). */
export function splitOptions(content: string): { content: string; options: string[] } {
  const match = /\n?\s*Options:\s*(.+)\s*$/i.exec(content);
  if (!match) return { content, options: [] };
  const options = match[1]!
    .split('|')
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
  return options.length >= 2
    ? { content: content.slice(0, match.index).trim(), options }
    : { content, options: [] };
}

export function createRelayModelAdapter(options: { gate: OutboundGate; id?: string }): ModelAdapter {
  return {
    id: options.id ?? 'relay',
    complete: async (request: ModelRequest): Promise<ModelResponse> => {
      const gated = await options.gate.send({
        purpose: 'agent.complete',
        payload: {
          messages: request.messages,
          tools: request.tools.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
        },
      });

      const unavailable = (reason: string): ModelResponse => ({
        content: `I could not reach the model: ${reason}. Your ledger, forecast, policies, earmarks and audit log keep working without it.`,
        toolCalls: [],
        unavailable: true,
      });

      if (!gated.ok) return unavailable(gated.reason);

      const reply = RelayReplySchema.safeParse(gated.response);
      if (!reply.success) return unavailable('the reply was not in the expected format');

      const parsed = splitOptions(reply.data.content ?? '');
      return {
        content: parsed.content,
        toolCalls: reply.data.toolCalls ?? [],
        ...(parsed.options.length > 0 ? { options: parsed.options } : {}),
      };
    },
  };
}
