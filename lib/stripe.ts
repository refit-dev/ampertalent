import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2026-09-30.endive',
});

/**
 * Verify webhook signature using Stripe SDK
 */
export function verifyWebhookSignature(
  body: string,
  signature: string,
  signingSecret: string
): Stripe.Event {
  return stripe.webhooks.constructEvent(body, signature, signingSecret);
}

/**
 * Create or get Stripe customer
 */
export async function createCustomer(params: {
  email: string;
  name?: string;
  metadata?: Record<string, string>;
}) {
  return stripe.customers.create({
    email: params.email,
    name: params.name,
    metadata: params.metadata,
  });
}

/**
 * Get Stripe customer
 */
export async function getCustomer(customerId: string) {
  return stripe.customers.retrieve(customerId);
}

/**
 * Create payment intent
 */
export async function createPaymentIntent(params: {
  amount: number;
  currency?: string;
  customerId?: string;
  description?: string;
  metadata?: Record<string, string>;
}) {
  return stripe.paymentIntents.create({
    amount: params.amount,
    currency: params.currency || 'usd',
    customer: params.customerId,
    description: params.description,
    metadata: params.metadata,
  });
}

/**
 * Get payment intent
 */
export async function getPaymentIntent(paymentIntentId: string) {
  return stripe.paymentIntents.retrieve(paymentIntentId);
}

/**
 * Create subscription
 */
export async function createSubscription(params: {
  customerId: string;
  priceId: string;
  metadata?: Record<string, string>;
}) {
  return stripe.subscriptions.create({
    customer: params.customerId,
    items: [{ price: params.priceId }],
    metadata: params.metadata,
  });
}

/**
 * Get subscription
 */
export async function getSubscription(subscriptionId: string) {
  return stripe.subscriptions.retrieve(subscriptionId);
}

/**
 * Update subscription
 */
export async function updateSubscription(
  subscriptionId: string,
  params: {
    priceId?: string;
    metadata?: Record<string, string>;
  }
) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const itemId = subscription.items.data[0]?.id;

  if (!itemId) {
    throw new Error('No subscription item found');
  }

  return stripe.subscriptions.update(subscriptionId, {
    items: params.priceId ? [{ id: itemId, price: params.priceId }] : undefined,
    metadata: params.metadata,
  });
}

/**
 * Cancel subscription
 */
export async function cancelSubscription(subscriptionId: string) {
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
}

/**
 * List payment methods for customer
 */
export async function listPaymentMethods(customerId: string) {
  return stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
  });
}

/**
 * Attach payment method to customer
 */
export async function attachPaymentMethod(
  paymentMethodId: string,
  customerId: string
) {
  return stripe.paymentMethods.attach(paymentMethodId, {
    customer: customerId,
  });
}

/**
 * Create checkout session
 */
export async function createCheckoutSession(params: {
  customerId?: string;
  priceId: string;
  mode?: 'payment' | 'subscription';
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}) {
  return stripe.checkout.sessions.create({
    customer: params.customerId,
    line_items: [{ price: params.priceId, quantity: 1 }],
    mode: params.mode || 'payment',
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: params.metadata,
  });
}

/**
 * Get checkout session
 */
export async function getCheckoutSession(sessionId: string) {
  return stripe.checkout.sessions.retrieve(sessionId);
}

/**
 * Get invoice
 */
export async function getInvoice(invoiceId: string) {
  return stripe.invoices.retrieve(invoiceId);
}

/**
 * List invoices for customer
 */
export async function listInvoices(customerId: string) {
  return stripe.invoices.list({
    customer: customerId,
    limit: 20,
  });
}

/**
 * Refund charge
 */
export async function refundCharge(chargeId: string, amount?: number) {
  return stripe.refunds.create({
    charge: chargeId,
    amount,
  });
}

export default stripe;
