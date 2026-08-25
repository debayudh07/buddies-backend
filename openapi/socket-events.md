# Live events (Supabase Realtime Broadcast)

Clients subscribe with `Supabase.channel(topic).onBroadcast(...)`.
There is no Socket.IO dual-publish. Room names match topic strings.

## Client → server (HTTP)

Live writes go through REST. Clients may `sendBroadcastMessage` for typing only
(`chat.typing`).

## Server → client

| Event | Topic | Payload |
|-------|-------|---------|
| `demand.request_created` | `bidzone:all` | `{ id, batchCode, liveEndsAt, itemCount }` |
| `demand.request_updated` | `bidzone:all` | `{ id, batchCode, itemCount, liveEndsAt }` |
| `demand.request_cancelled` | `bidzone:all` | `{ id, batchCode }` |
| `demand.reordered` | `auction:{bidRequestId}` | `{ id }` |
| `auction.updated` | `auction:{bidRequestId}` | `{ bidRequestId, deliveryWindow, itemCount }` |
| `auction.cancelled` | `auction:{bidRequestId}` | `{ bidRequestId, status: 'cancelled' }` |
| `auction.bid_placed` | `auction:{bidRequestId}` | `{ bid, liveEndsAt, extendCount, bidExpiresAt, bidTtlSec }` |
| `auction.bid_withdrawn` | `auction:{bidRequestId}` | `{ bidId }` |
| `auction.bid_accepted` | `auction:{bidRequestId}` | `{ bidId }` or `{ bidIds }` |
| `auction.bid_rejected` | `auction:{bidRequestId}` | `{ bidId }` |
| `order.created` | `auction:{bidRequestId}` | `{ orderId }` |
| `order.status_changed` | `tracking:{orderId}` | `{ orderId, status, paymentStatus?, reason?, at }` |
| `order.updated` | `tracking:{orderId}`, `user:{consumerId}`, `user:{supplierId}` | same payload |
| `tracking.location_updated` | `tracking:{orderId}` | `{ point, etaMinutes }` |
| `chat.thread_created` | `chat:{threadId}` | `{ threadId, orderId }` |
| `chat.message_created` | `chat:{threadId}` | `{ message }` |
| `chat.typing` | `chat:{threadId}` | `{ typing, userId, orderId }` or `{ typing, userId, claimId }` for return threads |
| `return.updated` | `return:{claimId}`, `user:{consumerUserId}`, `user:{supplierUserId}` | `{ claim }` |
| `notify.created` | `user:{userId}` | `{ notification }` |
| `bid.status_changed` | `user:{supplierUserId}` | `{ bidId, status, orderId? }` |
| `bidRequest.updated` | `user:{consumerUserId}` | `{ id, status, orderId? }` |

Return-scoped chat reuses `chat.message_created` / `chat.typing` on `chat:{threadId}`.
The thread is per-claim (`threadKind: return_claim`), not the order thread.
Clients join the same `chat:{threadId}` room returned by `GET /return-claims/{id}/chat`.

