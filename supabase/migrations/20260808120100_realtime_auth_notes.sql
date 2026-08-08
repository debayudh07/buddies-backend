-- Realtime Broadcast authorization scaffolding.
-- Private channel policies (membership) should be tightened per product rules.
-- Clients subscribe with user JWT; server broadcasts with service role.

-- Ensure realtime schema helpers exist (hosted Supabase projects already ship them).
-- Documented channel topic prefix conventions (application-level):
--   auction:{bidRequestId}
--   chat:{threadId}
--   tracking:{orderId}
--   bidzone:{geoKey}
--   user:{userId}

-- Allow authenticated clients to use Realtime (broadcast receive).
-- Fine-grained topic ACL should be layered via Realtime Authorization when enabled
-- on the project (Dashboard → Realtime → Authorization).

-- Example private-channel policy patterns (enable after project Realtime Authorization is on):
--
-- CREATE POLICY "users_own_user_topic"
-- ON realtime.messages FOR SELECT TO authenticated
-- USING (
--   (select realtime.topic()) = 'user:' || (
--     select id::text from public."User" where "supabaseId" = (select auth.uid()::text)
--   )
-- );
--
-- Keep policies out of this file until authorization is confirmed enabled for the project,
-- to avoid applying policies against tables that differ by Supabase version.

SELECT 1;
