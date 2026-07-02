-- ════════════════════════════════════════════════════════════════════════
-- Big Bazar Agent — Supabase Schema (agent state store, NOT product DB)
-- Run this in your Supabase project's SQL Editor.
-- ════════════════════════════════════════════════════════════════════════

create table if not exists conversations (
  sender_id              text primary key,           -- Facebook PSID
  state                  text default 'GREETING',     -- state machine position
  paused_by_ai           boolean default false,       -- human takeover flag
  paused_reason          text,
  message_history        jsonb default '[]'::jsonb,   -- last ~10 turns for AI context

  -- in-progress order fields, cleared after order is saved
  pending_product_name   text,
  pending_product_price  numeric,
  pending_variant         text,
  order_name             text,
  order_address           text,

  last_order_id           uuid,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);

create index if not exists idx_conversations_paused on conversations (paused_by_ai);
create index if not exists idx_conversations_updated on conversations (updated_at desc);

create table if not exists orders (
  id                uuid primary key default gen_random_uuid(),
  sender_id         text not null references conversations(sender_id),
  customer_name     text not null,
  customer_address  text not null,
  customer_phone    text not null,
  product_name      text not null,
  product_price     numeric not null,
  variant           text,
  status            text default 'pending_payment',  -- pending_payment | paid | shipped | cancelled
  created_at        timestamptz default now()
);

create index if not exists idx_orders_status on orders (status);
create index if not exists idx_orders_created on orders (created_at desc);

-- Row Level Security: lock down direct client access.
-- This agent only ever connects with the SERVICE ROLE key from the server,
-- which bypasses RLS — these policies protect against any future client-side use.
alter table conversations enable row level security;
alter table orders enable row level security;

-- No public policies created intentionally — service role only.
