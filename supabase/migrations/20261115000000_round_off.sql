-- Velanzo cloud database, part 13: "Amount actually received" on bills.
-- Run once in Supabase (or run supabase/UPDATE-ALL.sql, which is safe to run again).
-- round_off = what the customer really paid minus the bill total before it (999 paid as 1,000 → +1). total includes it.
alter table sales add column if not exists round_off double precision not null default 0;
