ALTER TABLE episodes ADD COLUMN ad_plan jsonb;
ALTER TABLE listening_sessions ADD COLUMN ad_skipping boolean NOT NULL DEFAULT false;
ALTER TABLE listening_sessions ADD COLUMN active_ad_plan jsonb;
