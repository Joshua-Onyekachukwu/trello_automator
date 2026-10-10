-- Migration 005: card visibility + drop vestigial scan_events
-- Run in Supabase SQL Editor → Run
-- Idempotent: safe to re-run.

-- Card-visibility display hint (if the installation predates schema.sql's
-- version of this statement). NULL = not set (fall back to env default).
alter table claim_state add column if not exists card_visibility_state text;

-- The periodic scan was removed in favor of webhook-only claiming, and the
-- app no longer writes scan audit events (insertScanEvent was deleted).
-- Drop the now-unused table left behind by migration 002.
drop table if exists scan_events;
