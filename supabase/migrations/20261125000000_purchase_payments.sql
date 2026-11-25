-- Velanzo cloud database, part 14: paying a received purchase later.
-- Run once in Supabase (or run supabase/UPDATE-ALL.sql, which is safe to run again).
-- A supplier payment can be for one purchase (purchase_id). A purchase with no supplier gets payments with supplier_id 0.
alter table supplier_payments add column if not exists purchase_id bigint;
create index if not exists idx_spay_purchase on supplier_payments (purchase_id);
