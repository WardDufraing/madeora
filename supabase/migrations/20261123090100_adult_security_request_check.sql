-- S37: PostgREST runs public.check_request() (20261123090000_adult_security.sql) before every API
-- request, so a signed-out session or one still waiting for its second factor is refused on its
-- next request instead of when its access token expires. This is Supabase's documented pre-request
-- setting. It is a migration of its own: if a hosted project refuses it, only this step fails, and
-- docs/adult-security-setup.md says what the owner does then.
alter role authenticator set pgrst.db_pre_request = 'public.check_request';
notify pgrst, 'reload config';
