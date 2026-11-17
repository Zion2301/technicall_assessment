import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db';
import { canTransition, InvalidTransitionError, isTerminal, PAYOUT_STATUSES } from '../src/stateMachine';
import { transitionPayout } from '../src/transitions';
import { insertTestPayout } from './helpers';

test('terminal states can never be left', () => {
  for (const to of PAYOUT_STATUSES) {
    assert.equal(canTransition('succeeded', to), false);
    assert.equal(canTransition('failed', to), false);
  }
  assert.ok(isTerminal('succeeded') && isTerminal('failed'));
  assert.ok(!isTerminal('needs_review'));
});

test('a payout cannot skip processing and jump straight to succeeded', () => {
  assert.equal(canTransition('pending', 'succeeded'), false);
  assert.equal(canTransition('awaiting_retry', 'succeeded'), false);
});

test('transitionPayout moves state and writes an audit event', () => {
  const db = openDb();
  const id = insertTestPayout(db);

  const ok = transitionPayout(db, { payoutId: id, from: 'pending', to: 'processing', actor: 'processor', reason: 'claimed', at: 1 });

  assert.equal(ok, true);
  assert.equal(db.prepare('SELECT status FROM payouts WHERE id = ?').pluck().get(id), 'processing');
  const events = db.prepare('SELECT from_status, to_status, actor, reason FROM payout_events').all();
  assert.deepEqual(events, [{ from_status: 'pending', to_status: 'processing', actor: 'processor', reason: 'claimed' }]);
});

test('compare-and-swap: a stale caller loses the race and changes nothing', () => {
  const db = openDb();
  const id = insertTestPayout(db);

  // Two workers both read "pending". The first wins...
  assert.equal(transitionPayout(db, { payoutId: id, from: 'pending', to: 'processing', actor: 'processor', reason: 'A', at: 1 }), true);
  // ...the second's precondition is now false, so it must back off.
  assert.equal(transitionPayout(db, { payoutId: id, from: 'pending', to: 'processing', actor: 'processor', reason: 'B', at: 2 }), false);

  assert.equal(db.prepare('SELECT COUNT(*) FROM payout_events').pluck().get(), 1);
});

test('an illegal transition throws and leaves the payout untouched', () => {
  const db = openDb();
  const id = insertTestPayout(db, { status: 'succeeded' });

  assert.throws(
    () => transitionPayout(db, { payoutId: id, from: 'succeeded', to: 'failed', actor: 'webhook', reason: 'late failure', at: 1 }),
    InvalidTransitionError,
  );
  assert.equal(db.prepare('SELECT status FROM payouts WHERE id = ?').pluck().get(id), 'succeeded');
});

test('schema: the same employee cannot appear twice in one run', () => {
  const db = openDb();
  insertTestPayout(db, { id: 'po_1', employeeId: 'emp_1' });
  assert.throws(() => insertTestPayout(db, { id: 'po_2', employeeId: 'emp_1' }), /UNIQUE/);
});

test('schema: rejects zero/negative amounts and unknown statuses', () => {
  const db = openDb();
  assert.throws(() => insertTestPayout(db, { id: 'po_a', employeeId: 'a', amountMinor: 0 }), /CHECK/);
  assert.throws(() => insertTestPayout(db, { id: 'po_b', employeeId: 'b', status: 'paid' as never }), /CHECK/);
});

test('schema: provider references are globally unique', () => {
  const db = openDb();
  const id = insertTestPayout(db);
  const insert = db.prepare(
    `INSERT INTO payout_attempts (id, payout_id, attempt_number, provider, provider_reference, status, created_at, updated_at)
     VALUES (?, ?, ?, 'paystack-mock', 'po_test_1', 'in_flight', 0, 0)`,
  );
  insert.run('att_1', id, 1);
  assert.throws(() => insert.run('att_2', id, 2), /UNIQUE/);
});

test('schema: audit events and ledger entries are append-only', () => {
  const db = openDb();
  const id = insertTestPayout(db);
  transitionPayout(db, { payoutId: id, from: 'pending', to: 'processing', actor: 'processor', reason: 'claimed', at: 1 });
  db.prepare(
    `INSERT INTO ledger_entries (txn_id, account, currency, amount_minor, payout_id, description, created_at)
     VALUES ('t1', 'x', 'NGN', 100, ?, 'test', 0)`,
  ).run(id);

  assert.throws(() => db.exec(`UPDATE payout_events SET reason = 'rewritten'`), /append-only/);
  assert.throws(() => db.exec(`DELETE FROM payout_events`), /append-only/);
  assert.throws(() => db.exec(`UPDATE ledger_entries SET amount_minor = 1`), /append-only/);
  assert.throws(() => db.exec(`DELETE FROM ledger_entries`), /append-only/);
});
