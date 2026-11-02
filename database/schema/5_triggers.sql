-- All triggers (public + auth schema). Run AFTER functions.sql.

-- auth.users.on_auth_user_created_oauth
CREATE TRIGGER on_auth_user_created_oauth AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_oauth_user();

-- auth.users.on_auth_user_created
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- public.group_messages.broadcast_group_message
CREATE TRIGGER broadcast_group_message AFTER INSERT ON public.group_messages FOR EACH ROW EXECUTE FUNCTION broadcast_group_message();


-- public.group_message_reactions.broadcast_group_reaction_insert (Phase 8.7)
CREATE TRIGGER broadcast_group_reaction_insert AFTER INSERT ON public.group_message_reactions FOR EACH ROW EXECUTE FUNCTION public.broadcast_group_reaction();

-- public.group_message_reactions.broadcast_group_reaction_delete (Phase 8.7)
CREATE TRIGGER broadcast_group_reaction_delete AFTER DELETE ON public.group_message_reactions FOR EACH ROW EXECUTE FUNCTION public.broadcast_group_reaction();

-- public.messages.broadcast_personal_message (Phase 8.8)
CREATE TRIGGER broadcast_personal_message AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.broadcast_personal_message();

-- public.group_messages.broadcast_group_message_deleted (Phase 8.9)
CREATE TRIGGER broadcast_group_message_deleted AFTER UPDATE ON public.group_messages FOR EACH ROW WHEN (old.deleted_at IS NULL AND new.deleted_at IS NOT NULL) EXECUTE FUNCTION public.broadcast_group_message_deleted();

-- public.group_message_attachments.broadcast_group_attachment (Phase 8.11)
CREATE TRIGGER broadcast_group_attachment AFTER INSERT ON public.group_message_attachments FOR EACH ROW EXECUTE FUNCTION public.broadcast_group_attachment();
