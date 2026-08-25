/** Supabase Realtime Broadcast publisher (service role).
 *
 * Server-side we always use channel.httpSend() (REST) — no WebSocket subscribe
 * per emit. Avoids supabase-js deprecation: send() falling back to REST.
 */
import { getSupabaseAdmin } from './supabase';
import { logger } from './logger';

async function broadcast(topic: string, event: string, payload: unknown): Promise<void> {
  const sb = getSupabaseAdmin();
  if (!sb) {
    logger.warn('realtime', 'admin missing — skip broadcast', { topic, event });
    return;
  }
  const channel = sb.channel(topic, {
    config: { broadcast: { ack: false } },
  });
  try {
    const body =
      payload === undefined || payload === null
        ? {}
        : typeof payload === 'object'
          ? (payload as Record<string, unknown>)
          : { value: payload };

    const result = await channel.httpSend(event, body);
    if (result && typeof result === 'object' && 'success' in result && !result.success) {
      logger.warn('realtime', 'broadcast failed', { topic, event, result });
    }
  } catch (e) {
    logger.warn('realtime', 'broadcast failed', {
      topic,
      event,
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    await sb.removeChannel(channel).catch(() => undefined);
  }
}

export function emitAuction(bidRequestId: string, event: string, payload: unknown) {
  void broadcast(`auction:${bidRequestId}`, event, payload);
}

export function emitChat(threadId: string, event: string, payload: unknown) {
  void broadcast(`chat:${threadId}`, event, payload);
}

export function emitTracking(orderId: string, event: string, payload: unknown) {
  void broadcast(`tracking:${orderId}`, event, payload);
}

export function emitBidzone(geoKey: string, event: string, payload: unknown) {
  void broadcast(`bidzone:${geoKey}`, event, payload);
}

export function emitUser(userId: string, event: string, payload: unknown) {
  void broadcast(`user:${userId}`, event, payload);
}

export function emitReturn(claimId: string, event: string, payload: unknown) {
  void broadcast(`return:${claimId}`, event, payload);
}
