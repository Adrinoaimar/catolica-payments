-- Backport the safe DELETE payload identity to installations that already
-- enabled the payment_updates projection.
alter table public.payment_updates replica identity full;
