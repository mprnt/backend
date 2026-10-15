"""Model 1 billing: real-HTTP smoke test against the running local backend.

Signs in as a local super admin and a local Shop 1 owner, then checks the
permission matrix and the partner-facing response. It records a sale and a
go-live for Shop 1, so run it only against a local database.

  SMOKE_SUPER_PW=... SMOKE_SHOP_PW=... python3 scripts/billing-smoke.py

Passwords come from the environment only and are never printed.
"""
import json, os, sys, urllib.request, urllib.error

BASE = os.environ.get('SMOKE_API', 'http://localhost:3000/api/v1/admin')
assert 'localhost' in BASE or '127.0.0.1' in BASE, 'the smoke test runs against localhost only'
SUPER_EMAIL, SUPER_PW = 'console-verify@mprnt.test', os.environ['SMOKE_SUPER_PW']
SHOP_EMAIL, SHOP_PW = 'billing-shop1@mprnt.test', os.environ['SMOKE_SHOP_PW']
SHOP1 = '9a0c8191-3548-4105-9bcf-21fd4755db11'
SHOP3 = '6ba5a69e-24c6-4d24-a732-0ac0f3e548f2'
results = []

def req(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header('Content-Type', 'application/json')
    if token:
        r.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read() or b'{}')
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b'{}')
        except Exception:
            return e.code, {}

def login(email, pw):
    status, body = req('POST', '/auth/login', body={'email': email, 'password': pw})
    tok = (body.get('data') or {}).get('accessToken')
    return tok

def check(name, ok, detail=''):
    results.append((name, ok))
    print(('PASS  ' if ok else 'FAIL  ') + name + ('' if ok else f'   [{detail}]'))

super_t = login(SUPER_EMAIL, SUPER_PW)
shop_t = login(SHOP_EMAIL, SHOP_PW)
check('super admin signs in', bool(super_t))
check('shop owner signs in', bool(shop_t))

s, _ = req('GET', '/billing/contract')
check('no token is refused (401)', s == 401, s)
s, _ = req('GET', f'/billing/contract?organizationId={SHOP1}', shop_t)
check('shop reads own contract: 200 (or 404 if not yet sold)', s in (200,), s)
s, b = req('GET', f'/billing/contract?organizationId={SHOP3}', shop_t)
check("shop cannot read another partner's contract (404, not leaked)", s == 404, s)
s, _ = req('POST', '/billing/contract', shop_t, {'organizationId': SHOP1, 'note': 'self-serve sale'})
check('shop cannot record a sale (403)', s == 403, s)
s, _ = req('POST', '/billing/plans', shop_t, {'hardwarePrice': 1, 'monthlyPrice': 0, 'freeMonths': 12, 'graceDays': 60, 'note': 'shop price'})
check('shop cannot publish a price (403)', s == 403, s)
s, b = req('POST', '/billing/contract', super_t, {'organizationId': SHOP3, 'note': 'Shop 3 is on Option A'})
check('a Model 2A partner cannot be sold a Model 1 contract (409)', s == 409 and (b.get('code') or (b.get('error') or {}).get('code')) == 'NOT_MODEL_1', f'{s} {b}')
s, b = req('POST', '/billing/plans', super_t, {'hardwarePrice': 18999, 'monthlyPrice': 499, 'freeMonths': 1, 'graceDays': 5})
check('a price without a note is refused (400)', s == 400, s)

s, b = req('POST', '/billing/contract', super_t, {'organizationId': SHOP1, 'note': 'Smoke test sale'})
if s == 409:
    check('sale for Shop 1 (already has a contract from an earlier run) refused (409)', True)
else:
    check('super admin records the Model 1 sale for Shop 1 (201)', s == 201, f'{s} {b}')

s, view = req('GET', f'/billing/contract?organizationId={SHOP1}', super_t)
contract = (view.get('data') or {}).get('contract') or {}
hw = [i for i in contract.get('invoices', []) if i['kind'] == 'hardware']
check('super admin sees the hardware invoice', len(hw) == 1, view)
if hw and hw[0]['status'] == 'due':
    s, b = req('POST', f"/billing/charges/{hw[0]['id']}/settle", super_t, {'action': 'paid', 'method': 'upi', 'reference': 'UTR-SMOKE-1'})
    check('hardware recorded as paid by UPI (200)', s == 200, f'{s} {b}')
    s, b = req('POST', f"/billing/charges/{hw[0]['id']}/settle", super_t, {'action': 'paid', 'method': 'cash'})
    check('the same hardware cannot be paid twice (409)', s == 409, s)
s, view = req('GET', f'/billing/contract?organizationId={SHOP1}', super_t)
contract = (view.get('data') or {}).get('contract') or {}
if not contract.get('goLiveOn'):
    s, b = req('POST', '/billing/contract/go-live', super_t, {'organizationId': SHOP1, 'goLiveOn': __import__('datetime').date.today().isoformat(), 'note': 'Smoke test go-live'})
    check('partner goes live today (200)', s == 200, f'{s} {b}')

s, shop_view = req('GET', '/billing/contract', shop_t)
text = json.dumps(shop_view)
check('shop sees its contract (200, hasContract)', s == 200 and (shop_view.get('data') or {}).get('hasContract') is True, s)
for leaked in ['UTR-SMOKE-1', 'paymentReference', 'settledByEmail', '@mprnt.test', 'saleNote', 'goLiveNote', 'graceDays', 'Smoke test']:
    check(f'shop response does not contain {leaked!r}', leaked not in text, leaked)

s, b = req('GET', '/billing/contracts', super_t)
rows = (b.get('data') or {}).get('rows', [])
check('portfolio lists Shop 1 (200)', s == 200 and any(r['organizationId'] == SHOP1 for r in rows), s)
s, _ = req('GET', '/billing/contracts', shop_t)
check('shop cannot see the portfolio (403)', s == 403, s)
s, _ = req('GET', '/billing/plans', shop_t)
check('shop cannot see the price list (403)', s == 403, s)

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} smoke checks passed")
sys.exit(1 if failed else 0)
