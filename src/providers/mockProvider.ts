import type { Random } from '../clock';
import type { Currency } from '../money';
import {
  type NormalizedWebhookEvent,
  type PayoutProvider,
  ProviderTimeoutError,
  type SendPayoutRequest,
  type SendResult,
  type StatusResult,
} from './types';

/**
 * A fake payout provider that misbehaves on purpose.
 *
 * It keeps its own "bank-side" record of transfers keyed by reference. That's
 * what lets it simulate the dangerous case: the money moved, but we never got
 * the response. A later status check tells the truth, just like a real
 * provider's API would.
 *
 * Behaviour is either scripted (tests: "the next call times out after
 * processing") or random with a seed (chaos simulation).
 */

export type SendBehaviour =
  | 'succeed' // synchronous success
  | 'accept' // queued; finishes later via settlePending() + webhook
  | 'fail_retryable' // definite failure, worth retrying (provider outage, rate limit)
  | 'fail_permanent' // definite failure, retrying won't help (bad account number)
  | 'timeout_after_processing' // money MOVED, but the response was lost
  | 'timeout_before_processing'; // request never arrived

export type StatusBehaviour = 'answer' | 'timeout';

export interface ChaosOptions {
  sendWeights: Record<SendBehaviour, number>;
  asyncFailureRate: number; // share of accepted transfers that later fail
  statusTimeoutRate: number;
  duplicateWebhookRate: number;
  dropWebhookRate: number;
}

export const DEFAULT_CHAOS: ChaosOptions = {
  sendWeights: {
    succeed: 40,
    accept: 25,
    fail_retryable: 12,
    fail_permanent: 3,
    timeout_after_processing: 10,
    timeout_before_processing: 10,
  },
  asyncFailureRate: 0.15,
  statusTimeoutRate: 0.2,
  duplicateWebhookRate: 0.3,
  dropWebhookRate: 0.15,
};

/**
 * Error vocabulary of this "provider". A real adapter maps the provider's own
 * codes here. Anything NOT listed as retryable (invalid_account,
 * account_name_mismatch, reference_conflict, or a code we've never seen) is
 * treated as permanent: we'd rather a human looks at it than retry blindly.
 */
const RETRYABLE_CODES = new Set(['provider_unavailable', 'rate_limited', 'issuer_unavailable']);

export interface MockTransfer {
  provider: string;
  reference: string;
  providerTransferId: string;
  amountMinor: number;
  currency: Currency;
  accountNumber: string;
  status: 'pending' | 'succeeded' | 'failed';
  failureCode?: string;
}

/** Raw webhook in this provider's own wire format (deliberately not our normalised format). */
export interface MockWebhookPayload {
  id: string;
  event: 'transfer.pending' | 'transfer.success' | 'transfer.failed';
  data: { reference: string; failure_code?: string };
}

export interface MockProviderOptions {
  name: string;
  currencies: Currency[];
  random: Random;
  chaos?: ChaosOptions; // omit for a well-behaved provider (always 'succeed')
}

export class MockProvider implements PayoutProvider {
  readonly name: string;
  readonly currencies: readonly Currency[];

  /** Counters so tests can prove things like "we only called send once". */
  sendCalls = 0;
  statusCalls = 0;

  /** Test hook: runs after a transfer is recorded but before the response returns. */
  beforeResponse?: () => void | Promise<void>;

  private readonly transfers = new Map<string, MockTransfer>();
  private readonly sendScript: SendBehaviour[] = [];
  private readonly statusScript: StatusBehaviour[] = [];
  private webhookOutbox: MockWebhookPayload[] = [];
  private nextId = 1;

  constructor(private readonly options: MockProviderOptions) {
    this.name = options.name;
    this.currencies = options.currencies;
  }

  /** Queue behaviours for the next send calls (consumed in order, before chaos). */
  script(...behaviours: SendBehaviour[]): this {
    this.sendScript.push(...behaviours);
    return this;
  }

  scriptStatus(...behaviours: StatusBehaviour[]): this {
    this.statusScript.push(...behaviours);
    return this;
  }

  async sendPayout(req: SendPayoutRequest): Promise<SendResult> {
    this.sendCalls++;

    // Idempotency on reference, the way real providers behave: a repeat of a
    // known reference returns the existing transfer and moves no new money.
    const existing = this.transfers.get(req.reference);
    if (existing) {
      if (existing.amountMinor !== req.amountMinor || existing.currency !== req.currency) {
        return { outcome: 'failed', code: 'reference_conflict', retryable: false, message: 'Reference reused with different details' };
      }
      return this.toSendResult(existing);
    }

    const behaviour = this.sendScript.shift() ?? this.randomSendBehaviour();
    switch (behaviour) {
      case 'timeout_before_processing':
        throw new ProviderTimeoutError();

      case 'fail_retryable':
        // Rejected at the door: nothing recorded, so a status check says not_found.
        return { outcome: 'failed', code: this.pick(['provider_unavailable', 'rate_limited']), retryable: true, message: 'Try again later' };

      case 'fail_permanent': {
        const t = this.record(req, 'failed', 'invalid_account');
        this.emitWebhook(t);
        return this.respond(this.toSendResult(t));
      }

      case 'accept': {
        const t = this.record(req, 'pending');
        this.emitWebhook(t);
        return this.respond(this.toSendResult(t));
      }

      case 'succeed':
      case 'timeout_after_processing': {
        const t = this.record(req, 'succeeded');
        this.emitWebhook(t);
        await this.beforeResponse?.();
        if (behaviour === 'timeout_after_processing') throw new ProviderTimeoutError();
        return this.toSendResult(t);
      }
    }
  }

  async getPayoutStatus(reference: string): Promise<StatusResult> {
    this.statusCalls++;
    const behaviour = this.statusScript.shift() ?? (this.chance(this.options.chaos?.statusTimeoutRate ?? 0) ? 'timeout' : 'answer');
    if (behaviour === 'timeout') throw new ProviderTimeoutError('Status check timed out');

    const t = this.transfers.get(reference);
    if (!t) return { status: 'not_found' };
    if (t.status === 'failed') return { status: 'failed', code: t.failureCode!, retryable: RETRYABLE_CODES.has(t.failureCode!) };
    return { status: t.status };
  }

  parseWebhook(payload: unknown): NormalizedWebhookEvent {
    // Production: verify the HMAC signature header BEFORE trusting the body.
    const p = payload as MockWebhookPayload;
    if (!p || typeof p.id !== 'string' || typeof p.data?.reference !== 'string') {
      throw new Error('Malformed webhook payload');
    }
    const statusByEvent = { 'transfer.pending': 'pending', 'transfer.success': 'succeeded', 'transfer.failed': 'failed' } as const;
    const status = statusByEvent[p.event];
    if (!status) throw new Error(`Unknown webhook event type: ${p.event}`);
    const code = p.data.failure_code;
    return {
      eventId: p.id,
      reference: p.data.reference,
      status,
      failureCode: code,
      retryable: code ? RETRYABLE_CODES.has(code) : undefined,
    };
  }

  // --- Simulation controls ---------------------------------------------------

  /** The bank finishes processing queued transfers (some fail) and fires webhooks. */
  settlePending(): void {
    for (const t of this.transfers.values()) {
      if (t.status !== 'pending') continue;
      if (this.chance(this.options.chaos?.asyncFailureRate ?? 0)) {
        t.status = 'failed';
        t.failureCode = this.pick(['issuer_unavailable', 'account_name_mismatch']);
      } else {
        t.status = 'succeeded';
      }
      this.emitWebhook(t);
    }
  }

  /** Hands over queued webhooks, shuffled (so they arrive out of order). */
  drainWebhooks(): MockWebhookPayload[] {
    const batch = this.webhookOutbox;
    this.webhookOutbox = [];
    for (let i = batch.length - 1; i > 0; i--) {
      const j = Math.floor(this.options.random() * (i + 1));
      [batch[i], batch[j]] = [batch[j]!, batch[i]!];
    }
    return batch;
  }

  /** The provider's view of every transfer: what a settlement report would contain. */
  allTransfers(): MockTransfer[] {
    return [...this.transfers.values()].map((t) => ({ ...t }));
  }

  // --- Internals -------------------------------------------------------------

  private record(req: SendPayoutRequest, status: MockTransfer['status'], failureCode?: string): MockTransfer {
    const t: MockTransfer = {
      provider: this.name,
      reference: req.reference,
      providerTransferId: `${this.name}_trf_${this.nextId++}`,
      amountMinor: req.amountMinor,
      currency: req.currency,
      accountNumber: req.recipient.accountNumber,
      status,
      failureCode,
    };
    this.transfers.set(req.reference, t);
    return t;
  }

  private async respond(result: SendResult): Promise<SendResult> {
    await this.beforeResponse?.();
    return result;
  }

  private toSendResult(t: MockTransfer): SendResult {
    if (t.status === 'succeeded') return { outcome: 'succeeded', providerTransferId: t.providerTransferId };
    if (t.status === 'pending') return { outcome: 'accepted', providerTransferId: t.providerTransferId };
    return { outcome: 'failed', code: t.failureCode!, retryable: RETRYABLE_CODES.has(t.failureCode!), message: 'Transfer failed' };
  }

  private emitWebhook(t: MockTransfer): void {
    const chaos = this.options.chaos;
    if (this.chance(chaos?.dropWebhookRate ?? 0)) return; // lost in transit
    const event = t.status === 'succeeded' ? 'transfer.success' : t.status === 'failed' ? 'transfer.failed' : 'transfer.pending';
    const payload: MockWebhookPayload = {
      id: `evt_${this.name}_${this.nextId++}`,
      event,
      data: { reference: t.reference, ...(t.failureCode ? { failure_code: t.failureCode } : {}) },
    };
    this.webhookOutbox.push(payload);
    if (this.chance(chaos?.duplicateWebhookRate ?? 0)) this.webhookOutbox.push({ ...payload }); // delivered twice
  }

  private randomSendBehaviour(): SendBehaviour {
    const weights = this.options.chaos?.sendWeights;
    if (!weights) return 'succeed';
    const entries = Object.entries(weights) as [SendBehaviour, number][];
    let roll = this.options.random() * entries.reduce((sum, [, w]) => sum + w, 0);
    for (const [behaviour, weight] of entries) {
      roll -= weight;
      if (roll < 0) return behaviour;
    }
    return 'succeed';
  }

  private chance(probability: number): boolean {
    return probability > 0 && this.options.random() < probability;
  }

  private pick<T>(items: T[]): T {
    return items[Math.floor(this.options.random() * items.length)]!;
  }
}
