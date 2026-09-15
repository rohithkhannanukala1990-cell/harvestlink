/**
 * In-memory Stripe stand-in for Vitest.
 * createSale / refundSale hit these instead of the network.
 * Webhook signature verification uses Stripe's real constructEvent + test header helper.
 */
import Stripe from "stripe";

type RefundCall = {
  payment_intent: string;
  amount?: number;
  metadata?: Record<string, string>;
};

const refundCalls: RefundCall[] = [];
let refundSeq = 0;
let sessionSeq = 0;
let intentSeq = 0;

const webhookSecret = () =>
  process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_harvestlink_webhook";

function makeStripe(): Stripe {
  // Real Stripe SDK instance only for webhook helpers (no network).
  return new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_harvestlink");
}

export const mockStripeModule = {
  getStripe(): {
    checkout: {
      sessions: {
        create: (params: unknown) => Promise<Stripe.Checkout.Session>;
        retrieve: (id: string) => Promise<Stripe.Checkout.Session>;
      };
    };
    paymentIntents: {
      create: (params: { amount: number; metadata?: Record<string, string> }) => Promise<Stripe.PaymentIntent>;
      retrieve: (id: string) => Promise<Stripe.PaymentIntent>;
    };
    refunds: {
      create: (params: RefundCall) => Promise<Stripe.Refund>;
      retrieve: (id: string) => Promise<Stripe.Refund>;
      list: (params: { payment_intent: string; limit?: number }) => Promise<{ data: Stripe.Refund[] }>;
    };
    webhooks: Stripe["webhooks"];
  } {
    const real = makeStripe();
    return {
      checkout: {
        sessions: {
          async create() {
            sessionSeq += 1;
            const id = `cs_test_${sessionSeq}`;
            return {
              id,
              url: `https://checkout.stripe.test/pay/${id}`,
              payment_intent: `pi_test_from_session_${sessionSeq}`,
              payment_status: "unpaid",
            } as Stripe.Checkout.Session;
          },
          async retrieve(id: string) {
            return {
              id,
              payment_status: "paid",
              payment_intent: `pi_test_from_session_retrieved`,
            } as Stripe.Checkout.Session;
          },
        },
      },
      paymentIntents: {
        async create(params) {
          intentSeq += 1;
          const id = `pi_test_${intentSeq}`;
          return {
            id,
            client_secret: `${id}_secret_test`,
            amount: params.amount,
            status: "requires_payment_method",
            metadata: params.metadata ?? {},
          } as Stripe.PaymentIntent;
        },
        async retrieve(id: string) {
          return {
            id,
            status: "succeeded",
            client_secret: `${id}_secret_test`,
          } as Stripe.PaymentIntent;
        },
      },
      refunds: {
        async create(params: RefundCall) {
          refundSeq += 1;
          refundCalls.push(params);
          return {
            id: `re_test_${refundSeq}`,
            status: "succeeded",
            amount: params.amount,
            payment_intent: params.payment_intent,
            metadata: params.metadata ?? {},
          } as Stripe.Refund;
        },
        async retrieve(id: string) {
          return { id, status: "succeeded" } as Stripe.Refund;
        },
        async list() {
          return { data: [] };
        },
      },
      webhooks: real.webhooks,
    };
  },

  constructStripeEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const stripe = makeStripe();
    return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret());
  },

  getRefundCalls(): RefundCall[] {
    return [...refundCalls];
  },
};

export function resetStripeMocks(): void {
  refundCalls.length = 0;
  refundSeq = 0;
  sessionSeq = 0;
  intentSeq = 0;
}

export function signStripeWebhookPayload(payload: string): string {
  const stripe = makeStripe();
  return stripe.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret(),
  });
}
