-- Keep private spoken answers under the same cascading deletion as their conversation.
ALTER TABLE conversation_turns ADD COLUMN speech_audio bytea;
UPDATE conversation_turns SET speech_status='failed' WHERE speech_key IS NOT NULL;
ALTER TABLE conversation_turns DROP COLUMN speech_key;
