import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import { handleStripeEvent, type StripeWebhookDeps } from '../app/api/webhooks/stripe/handlers';

const event = (type: string, object: object, id = 'evt_fixture') => ({ id, type, data: { object } }) as Stripe.Event;
const meta = { projectId: 'project', expertId: 'expert' };
let checks = 0;
function fixture() {
  let failWrite = false, failLookup = false;
  const done = new Set<string>(), active = new Set<string>();
  const writes: unknown[] = [], payouts: string[] = [], alerts: unknown[] = [];
  const deps: StripeWebhookDeps = {
    stripe: { paymentIntents: { retrieve: async () => { if (failLookup) throw Error('secret=do-not-log'); return { metadata: meta }; } } },
    getProject: async () => ({ experts: [{ expert: { id: 'expert' }, paymentStatus: 'paid' }] }),
    updateExpertStatus: async (_p, _e, patch) => { if (failWrite) throw Error('secret=do-not-log'); writes.push(patch); return true; },
    runExpertPayout: async () => { payouts.push('paid'); },
    retryPendingPayoutsForAccount: async () => ({ attempted: 0, paid: 0 }),
    recordSubscriptionStatus: async () => {},
    recordSystemFailure: async input => { alerts.push(input); },
    claimEvent: async id => { if (done.has(id)) return 'duplicate'; if (active.has(id)) return 'busy'; active.add(id); return 'process'; },
    completeEvent: async id => { done.add(id); },
    releaseEvent: async id => { active.delete(id); },
    now: () => 1,
  };
  return { deps, done, active, writes, payouts, alerts, failWrite: (v: boolean) => { failWrite=v; }, failLookup: (v: boolean) => { failLookup=v; } };
}
async function main() {
  const paid = event('payment_intent.succeeded', { id: 'pi_fixture', metadata: meta });
  const f = fixture(); f.failWrite(true);
  await assert.rejects(handleStripeEvent(paid, f.deps)); checks++;
  assert.equal(f.done.size, 0); assert.equal(f.active.size, 0); assert.equal(f.payouts.length, 0); checks+=3;
  assert.equal(JSON.stringify(f.alerts).includes('do-not-log'), false); checks++;
  f.failWrite(false);
  await handleStripeEvent(paid, f.deps);
  assert.equal(f.writes.length, 1); assert.equal(f.payouts.length, 1); checks+=2;
  assert.equal((await handleStripeEvent(paid, f.deps)).duplicate, true); checks++;
  assert.equal(f.payouts.length, 1); checks++;
  for (const payment_status of ['unpaid', 'no_payment_required', undefined]) {
    const f = fixture();
    await handleStripeEvent(event('checkout.session.completed', { metadata: meta, payment_intent: 'pi_fixture', payment_status }), f.deps);
    assert.equal(f.writes.length, 0); assert.equal(f.payouts.length, 0); checks+=2;
  }
  for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) {
    const f = fixture();
    await handleStripeEvent(event(type, { metadata: meta, payment_intent: 'pi_fixture', payment_status: 'paid' }), f.deps);
    assert.equal(f.payouts.length, 1); checks++;
  }
  for (const type of ['payment_intent.payment_failed', 'charge.refunded', 'charge.dispute.created']) {
    const f = fixture(); f.failWrite(true);
    const ev = event(type, { id: 'pi_fixture', metadata: meta });
    await assert.rejects(handleStripeEvent(ev, f.deps)); checks++;
    assert.equal(f.done.size, 0); checks++;
    f.failWrite(false); await handleStripeEvent(ev, f.deps);
    assert.equal(f.writes.length, 1); checks++;
  }
  {
    const f=fixture(); f.failLookup(true);
    const ev=event('charge.refunded', { payment_intent: 'pi_fixture' });
    await assert.rejects(handleStripeEvent(ev,f.deps)); checks++;
    f.failLookup(false); await handleStripeEvent(ev,f.deps);
    assert.equal(f.writes.length,1); checks++;
  }
  {
    const f=fixture(); f.active.add(paid.id);
    await assert.rejects(handleStripeEvent(paid,f.deps)); checks++;
    assert.equal(f.writes.length,0); checks++;
  }
  {
    const f=fixture(); let resume!: () => void;
    f.deps.updateExpertStatus=async () => { await new Promise<void>(resolve => { resume=resolve; }); };
    const first=handleStripeEvent(paid,f.deps);
    await new Promise(resolve => setTimeout(resolve, 0));
    await assert.rejects(handleStripeEvent(paid,f.deps)); checks++;
    resume(); await first;
    assert.equal(f.payouts.length,1); checks++;
  }
  // Exercise the production Redis lease implementation through a REST double.
  // No network: assert the only URL reached is the reserved fixture host.
  {
    const originalFetch = globalThis.fetch;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
    const redis = new Map<string,string>();
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://redis.example.test/pipeline');
      const commands = JSON.parse(String(init?.body)) as string[][];
      return Response.json(commands.map(([op,...args]) => {
        if (op === 'GET') return { result: redis.get(args[0]) ?? null };
        if (op === 'SET') {
          if (args.includes('NX') && redis.has(args[0])) return { result: null };
          redis.set(args[0],args[1]); return { result: 'OK' };
        }
        if (op === 'EVAL') {
          const key=args[2], owner=args[3];
          const match=redis.get(key)===owner;
          if (match) redis.delete(key);
          return { result: match ? 1 : 0 };
        }
        throw Error('unexpected Redis operation');
      }));
    };
    try {
      const f=fixture();
      const { claimEvent, completeEvent, releaseEvent, ...business }=f.deps;
      // Old seen markers must not suppress work that may have failed.
      redis.set('stripe-event:evt_fixture','1');
      f.failWrite(true);
      await assert.rejects(handleStripeEvent(paid,business)); checks++;
      assert.equal(redis.has('stripe-processing:v2:evt_fixture'),false); checks++;
      assert.equal(redis.has('stripe-done:v2:evt_fixture'),false); checks++;
      f.failWrite(false); await handleStripeEvent(paid,business);
      assert.equal(redis.get('stripe-done:v2:evt_fixture'),'1'); checks++;
      assert.equal(redis.has('stripe-processing:v2:evt_fixture'),false); checks++;
      assert.equal((await handleStripeEvent(paid,business)).duplicate,true); checks++;
      assert.equal(f.payouts.length,1); checks++;
    } finally { globalThis.fetch=originalFetch; }
  }
  process.stdout.write(`PASS Stripe recovery: ${checks} assertions\n`);
}
main().catch(err => { console.error(err); process.exitCode=1; });
