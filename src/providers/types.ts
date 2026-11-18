import type { Currency } from '../money';

/**
 * The contract every payout provider adapter implements (Paystack, Flutterwave,
 * M-Pesa, ...). The rest of the system only ever talks to this interface, so
 * adding a country or switching provider means writing one adapter, nothing else.
 *
 * The adapter's main job is TRANSLATION: provider-specific responses, error
 * codes and webhook formats in, these normalised types out. In particular,
 * deciding whether a failure is retryable belongs here, because only the
 * adapter knows that provider's error vocabulary.
 */
export interface PayoutProvider {
  readonly name: string;
  readonly currencies: readonly Currency[];

  /**
   * Must be idempotent on `reference`: sending the same reference twice must
   * never move money twice. Every real provider we'd use supports this.
   *
   * Contract for errors: return `failed` only when the provider definitively
   * did NOT move money. If the outcome is unclear (timeout, connection reset,
   * unparseable 5xx), THROW: the caller treats any throw as "unknown outcome".
   */
  sendPayout(request: SendPayoutRequest): Promise<SendResult>;

  /** Ask the provider what happened to a reference. Used to resolve unknown outcomes. */
  getPayoutStatus(reference: string): Promise<StatusResult>;

  /** Parse (and, in production, verify the signature of) an inbound webhook. */
  parseWebhook(payload: unknown): NormalizedWebhookEvent;
}

export interface Recipient {
  name: string;
  /** Bank account number, or phone number for mobile money (M-Pesa). */
  accountNumber: string;
  bankCode?: string;
}

export interface SendPayoutRequest {
  reference: string;
  amountMinor: number;
  currency: Currency;
  recipient: Recipient;
}

export type SendResult =
  | { outcome: 'succeeded'; providerTransferId: string }
  | { outcome: 'accepted'; providerTransferId: string } // async: final result comes later
  | { outcome: 'failed'; code: string; retryable: boolean; message: string };

export type StatusResult =
  | { status: 'succeeded' }
  | { status: 'pending' }
  | { status: 'failed'; code: string; retryable: boolean }
  | { status: 'not_found' }; // the provider never received this reference

export interface NormalizedWebhookEvent {
  eventId: string;
  reference: string;
  status: 'pending' | 'succeeded' | 'failed';
  failureCode?: string;
  retryable?: boolean;
}

/** Thrown by adapters when a request may or may not have reached the provider. */
export class ProviderTimeoutError extends Error {
  constructor(message = 'Provider request timed out') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}
