-- Model 1 billing: every database guard, checked inside one transaction that is rolled back.
-- Run: docker exec -i mprnt-postgres psql -U mprnt_user -d mprnt < scripts/billing-db-guards.sql
-- Every line must read PASS. A FAIL means the database would accept a change it must refuse.
\set QUIET 1
BEGIN;
CREATE OR REPLACE FUNCTION pg_temp.expect_fail(name text, sql text) RETURNS void AS $$
BEGIN
  EXECUTE sql;
  RAISE NOTICE 'FAIL  % (statement was allowed)', name;
EXCEPTION WHEN restrict_violation OR check_violation OR unique_violation OR not_null_violation OR foreign_key_violation THEN
  RAISE NOTICE 'PASS  % (refused: %)', name, SQLSTATE;
WHEN others THEN
  RAISE NOTICE 'FAIL  % (unexpected error: % %)', name, SQLSTATE, SQLERRM;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pg_temp.expect_ok(name text, sql text) RETURNS void AS $$
BEGIN
  EXECUTE sql;
  RAISE NOTICE 'PASS  % (allowed)', name;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'FAIL  % (refused: % %)', name, SQLSTATE, SQLERRM;
END $$ LANGUAGE plpgsql;

-- Fixtures
INSERT INTO organizations (id, name, slug, business_model) VALUES ('aaaaaaaa-0000-4000-8000-000000000001','Probe M1','probe-m1','integration');
INSERT INTO organizations (id, name, slug, business_model) VALUES ('aaaaaaaa-0000-4000-8000-000000000002','Probe 2A','probe-2a','revenue-share');
INSERT INTO billing_plan_terms (id, business_model, hardware_price, monthly_price, free_months, grace_days, note)
  VALUES ('bbbbbbbb-0000-4000-8000-000000000001','integration',18999,499,1,5,'probe plan');
INSERT INTO partner_contracts (id, organization_id, plan_term_id, business_model, hardware_price, monthly_price, free_months, grace_days, sale_note)
  VALUES ('cccccccc-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001','integration',18999,499,1,5,'probe sale');
INSERT INTO billing_charges (id, contract_id, kind, period_index, period_start, period_end, amount, due_on)
  VALUES ('dddddddd-0000-4000-8000-000000000000','cccccccc-0000-4000-8000-000000000001','hardware',0,'2026-10-15','2026-10-15',18999,'2026-10-15');

-- Plan terms
SELECT pg_temp.expect_fail('plan: a non-Model-1 plan is refused', $q$INSERT INTO billing_plan_terms (business_model, hardware_price, monthly_price, free_months, grace_days, note) VALUES ('revenue-share',1,1,0,0,'bad model')$q$);
SELECT pg_temp.expect_fail('plan: zero hardware price is refused', $q$INSERT INTO billing_plan_terms (business_model, hardware_price, monthly_price, free_months, grace_days, note) VALUES ('integration',0,499,1,5,'zero hw')$q$);
SELECT pg_temp.expect_fail('plan: 13 free months is refused', $q$INSERT INTO billing_plan_terms (business_model, hardware_price, monthly_price, free_months, grace_days, note) VALUES ('integration',18999,499,13,5,'too free')$q$);
SELECT pg_temp.expect_fail('plan: GST-exclusive is refused', $q$INSERT INTO billing_plan_terms (business_model, hardware_price, monthly_price, free_months, grace_days, gst_inclusive, note) VALUES ('integration',18999,499,1,5,false,'excl')$q$);
SELECT pg_temp.expect_fail('plan: an edit is refused (append-only)', $q$UPDATE billing_plan_terms SET monthly_price = 1 WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001'$q$);
SELECT pg_temp.expect_fail('plan: a delete is refused', $q$DELETE FROM billing_plan_terms WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001'$q$);
SELECT pg_temp.expect_ok('plan: a new term can be added', $q$INSERT INTO billing_plan_terms (business_model, hardware_price, monthly_price, free_months, grace_days, note) VALUES ('integration',19999,599,2,7,'new list price')$q$);

-- Contracts
SELECT pg_temp.expect_fail('contract: a second contract for the same partner is refused', $q$INSERT INTO partner_contracts (organization_id, plan_term_id, business_model, hardware_price, monthly_price, free_months, grace_days, sale_note) VALUES ('aaaaaaaa-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001','integration',1,1,0,0,'dup')$q$);
SELECT pg_temp.expect_fail('contract: a sale for a non-Model-1 partner is refused', $q$INSERT INTO partner_contracts (organization_id, plan_term_id, business_model, hardware_price, monthly_price, free_months, grace_days, sale_note) VALUES ('aaaaaaaa-0000-4000-8000-000000000002','bbbbbbbb-0000-4000-8000-000000000001','revenue-share',1,1,0,0,'wrong model')$q$);
SELECT pg_temp.expect_fail('contract: changing the hardware price is refused', $q$UPDATE partner_contracts SET hardware_price = 1 WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$);
SELECT pg_temp.expect_fail('contract: changing the monthly price is refused', $q$UPDATE partner_contracts SET monthly_price = 1 WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$);
SELECT pg_temp.expect_fail('contract: changing free months is refused', $q$UPDATE partner_contracts SET free_months = 3 WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$);
SELECT pg_temp.expect_fail('contract: moving the contract to another partner is refused', $q$UPDATE partner_contracts SET organization_id = 'aaaaaaaa-0000-4000-8000-000000000002' WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$);
SELECT pg_temp.expect_fail('contract: go-live without its recorder is refused', $q$UPDATE partner_contracts SET go_live_on = '2026-10-16', go_live_note = 'x' WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$);
SELECT pg_temp.expect_ok('contract: go-live recorded once, with who and why', $q$UPDATE partner_contracts SET go_live_on = '2026-10-16', go_live_recorded_at = NOW(), go_live_recorded_by = (SELECT id FROM admin_users WHERE email='qa-super@mprnt.test'), go_live_note = 'installed' WHERE id = 'cccccccc-0000-4000-8000-000000000001' AND go_live_on IS NULL$q$);
SELECT pg_temp.expect_fail('contract: go-live cannot be moved once set', $q$UPDATE partner_contracts SET go_live_on = '2026-10-20' WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$);
SELECT pg_temp.expect_fail('contract: a delete is refused', $q$DELETE FROM partner_contracts WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$);

-- Charges
SELECT pg_temp.expect_fail('charge: a second hardware charge for the same contract is refused', $q$INSERT INTO billing_charges (contract_id, kind, period_index, period_start, period_end, amount, due_on) VALUES ('cccccccc-0000-4000-8000-000000000001','hardware',0,'2026-10-15','2026-10-15',18999,'2026-10-15')$q$);
SELECT pg_temp.expect_fail('charge: a zero amount is refused', $q$INSERT INTO billing_charges (contract_id, kind, period_index, period_start, period_end, amount, due_on) VALUES ('cccccccc-0000-4000-8000-000000000001','software',2,'2026-11-16','2026-12-15',0,'2026-11-16')$q$);
SELECT pg_temp.expect_fail('charge: a software charge at period 0 is refused', $q$INSERT INTO billing_charges (contract_id, kind, period_index, period_start, period_end, amount, due_on) VALUES ('cccccccc-0000-4000-8000-000000000001','software',0,'2026-11-16','2026-12-15',499,'2026-11-16')$q$);
SELECT pg_temp.expect_fail('charge: an unknown kind is refused', $q$INSERT INTO billing_charges (contract_id, kind, period_index, period_start, period_end, amount, due_on) VALUES ('cccccccc-0000-4000-8000-000000000001','refund',3,'2026-12-16','2027-01-15',499,'2026-12-16')$q$);
SELECT pg_temp.expect_fail('charge: a due charge with settlement fields is refused', $q$INSERT INTO billing_charges (contract_id, kind, period_index, period_start, period_end, amount, due_on, status, settled_at, settled_by, payment_method) VALUES ('cccccccc-0000-4000-8000-000000000001','software',4,'2027-01-16','2027-02-15',499,'2027-01-16','due',NOW(),NULL,'cash')$q$);
SELECT pg_temp.expect_ok('charge: a software month is raised', $q$INSERT INTO billing_charges (contract_id, kind, period_index, period_start, period_end, amount, due_on) VALUES ('cccccccc-0000-4000-8000-000000000001','software',2,'2026-11-16','2026-12-15',499,'2026-11-16')$q$);
SELECT pg_temp.expect_fail('charge: a paid charge with no one who took the payment is refused', $q$UPDATE billing_charges SET status='paid', settled_at=NOW(), payment_method='cash' WHERE id='dddddddd-0000-4000-8000-000000000000'$q$);
SELECT pg_temp.expect_fail('charge: a bank transfer with no reference is refused', $q$UPDATE billing_charges SET status='paid', settled_at=NOW(), settled_by=(SELECT id FROM admin_users WHERE email='qa-super@mprnt.test'), payment_method='bank_transfer' WHERE id='dddddddd-0000-4000-8000-000000000000'$q$);
SELECT pg_temp.expect_fail('charge: a waiver with no reason is refused', $q$UPDATE billing_charges SET status='waived', settled_at=NOW(), settled_by=(SELECT id FROM admin_users WHERE email='qa-super@mprnt.test') WHERE id='dddddddd-0000-4000-8000-000000000000'$q$);
SELECT pg_temp.expect_fail('charge: changing the amount is refused', $q$UPDATE billing_charges SET amount = 1 WHERE id='dddddddd-0000-4000-8000-000000000000'$q$);
SELECT pg_temp.expect_fail('charge: moving the due date is refused', $q$UPDATE billing_charges SET due_on = '2026-12-01' WHERE id='dddddddd-0000-4000-8000-000000000000'$q$);
SELECT pg_temp.expect_ok('charge: a UPI payment with a reference is recorded', $q$UPDATE billing_charges SET status='paid', settled_at=NOW(), settled_by=(SELECT id FROM admin_users WHERE email='qa-super@mprnt.test'), payment_method='upi', payment_reference='UTR123456' WHERE id='dddddddd-0000-4000-8000-000000000000'$q$);
SELECT pg_temp.expect_fail('charge: a paid charge cannot be made waived', $q$UPDATE billing_charges SET status='waived', settle_note='changed mind' WHERE id='dddddddd-0000-4000-8000-000000000000'$q$);
SELECT pg_temp.expect_fail('charge: a paid charge cannot be made due again', $q$UPDATE billing_charges SET status='due', settled_at=NULL, settled_by=(SELECT id FROM admin_users WHERE email='qa-super@mprnt.test'), payment_method=NULL, payment_reference=NULL WHERE id='dddddddd-0000-4000-8000-000000000000'$q$);
SELECT pg_temp.expect_fail('charge: the payment record cannot be rewritten', $q$UPDATE billing_charges SET payment_reference='FAKE999' WHERE id='dddddddd-0000-4000-8000-000000000000'$q$);
SELECT pg_temp.expect_fail('charge: a delete is refused', $q$DELETE FROM billing_charges WHERE id='dddddddd-0000-4000-8000-000000000000'$q$);
ROLLBACK;
