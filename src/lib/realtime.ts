/** Supabase Realtime Broadcast publisher (service role).
 * Dual-publishes to Socket.IO during cutover so legacy clients keep working.
 *
 * Server-side we always use channel.httpSend() (REST) — no WebSocket subscribe
 * per emit. Avoids supabase-js deprecation: send() falling back to REST.
 */
import { getSupabaseAdmin } from './supabase';
import { logger } from './logger';

type RoomEmit = (roomKey: string, event: string, payload: unknown) => void;

let socketEmitters: {
  auction?: RoomEmit;
  chat?: RoomEmit;
  tracking?: RoomEmit;
  bidzone?: RoomEmit;
  user?: RoomEmit;
} = {};

/** Register Socket.IO bridges for dual-publish (optional; clear when Socket removed). */
export function setSocketEmitters(emitters: typeof socketEmitters) {
  socketEmitters = emitters;
}

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
    // Explicit REST delivery (service role). Payload is required by httpSend.
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
    // Drop channel so we don't leak clients on the admin Realtime socket.
    await sb.removeChannel(channel).catch(() => undefined);
  }
}

export function emitAuction(bidRequestId: string, event: string, payload: unknown) {
  const topic = `auction:${bidRequestId}`;
  void broadcast(topic, event, payload);
  socketEmitters.auction?.(bidRequestId, event, payload);
}

export function emitChat(threadId: string, event: string, payload: unknown) {
  const topic = `chat:${threadId}`;
  void broadcast(topic, event, payload);
  socketEmitters.chat?.(threadId, event, payload);
}

export function emitTracking(orderId: string, event: string, payload: unknown) {
  const topic = `tracking:${orderId}`;
  void broadcast(topic, event, payload);
  socketEmitters.tracking?.(orderId, event, payload);
}

export function emitBidzone(geoKey: string, event: string, payload: unknown) {
  const topic = `bidzone:${geoKey}`;
  void broadcast(topic, event, payload);
  socketEmitters.bidzone?.(geoKey, event, payload);
}

export function emitUser(userId: string, event: string, payload: unknown) {
  const topic = `user:${userId}`;
  void broadcast(topic, event, payload);
  try {
    socketEmitters.user?.(userId, event, payload);
  } catch {
    // ignore
  }
}
