-- SYNTHETIC FIXTURES - PHASE 3 BOOKING. NOT BUSINESS POLICY, NOT REAL STAFF,
-- NOT REAL CUSTOMERS. Loaded only into local databases and automated tests,
-- after synthetic_fixtures.sql (which sets deployment_settings.environment to
-- 'test'). Never copy to staging or production.
--
-- Booking roles are played by the existing synthetic users (all @example.test):
--   deal owner (Sales)        Synthetic Sales Delhi A    -> owns SYN-DEL-001
--   Sales, not the owner      Synthetic Sales Delhi B    (tests add a 'sales'
--                             assignment on SYN-DEL-001 inside their own
--                             rolled-back transaction or cleaned-up run)
--   Sales Manager, same branch   Synthetic Manager Delhi (manager, DEL)
--   Manager, another branch      Synthetic Manager Ahmedabad (manager, AMD)
--   Purchase                     Synthetic Purchase Jodhpur (purchase, JDH)
--   Booking health (admin)       Synthetic Admin Jodhpur (integration.manage)
--
-- No deal, assignment or booking row is added here on purpose: the frozen
-- Phase 1 policy-parity suite pins the exact set of readable fixture deals,
-- and real-stack booking suites must be able to open a fresh draft.

-- SYNTHETIC FIXTURE: real (Bitrix) booking confirmation stays OFF. Synthetic
-- deals confirm only because the environment is 'test'.
update public.booking_settings
set real_booking_enabled = false, updated_at = now()
where id;
