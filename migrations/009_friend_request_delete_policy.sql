-- Migration: Allow sender to delete (cancel) their own pending friend requests
-- The cancelFriendRequest() function in supabase.js needs this policy to work.

CREATE POLICY "Friend requests: sender delete"
  ON friend_requests FOR DELETE
  USING (sender_id = auth.uid());
