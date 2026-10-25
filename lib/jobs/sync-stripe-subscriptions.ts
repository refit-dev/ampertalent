/**
 * Sync Stripe Subscriptions Job
 * 
 * Handles Stripe webhook events for subscription lifecycle.
 * This job SYNCS Stripe subscription state to our database.
 * Actual recurring billing is handled automatically by Stripe.
 * 
 * Events:
 * - invoice.paid → subscription renewed successfully
 * - customer.subscription.updated → plan change or billing cycle update
 * 
 * Note: This is NOT a cron job - it's called by Stripe webhooks
 */

import { db } from '@/lib/db'
import Stripe from 'stripe'

type PeriodItem = { price?: { id?: string } | null };
type PeriodField = 'current_period_start' | 'current_period_end';
type PlanItem = (items: PeriodItem[]) => PeriodItem | undefined;

// Typed like the removed field, which was also absent at runtime when Stripe omitted it.
function subscriptionPeriod(subscription: object, field: PeriodField, planItem?: PlanItem): number {
  const legacy: unknown = Reflect.get(subscription, field);
  if (typeof legacy === 'number') return legacy;
  const list: unknown = Reflect.get(subscription, 'items');
  const data: unknown = list && typeof list === 'object' ? Reflect.get(list, 'data') : undefined;
  const items = (Array.isArray(data) ? data : []).filter(
    (item): item is PeriodItem => typeof item === 'object' && item !== null,
  );
  const periods = new Set(items.map((item) => Reflect.get(item, field)));
  const chosen = periods.size === 1 ? items[0] : planItem?.(items);
  const value: unknown = chosen ? Reflect.get(chosen, field) : undefined;
  return (typeof value === 'number' ? value : undefined) as number;
}

function getSubscriptionPeriodStart(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_start', planItem);
}

function getSubscriptionPeriodEnd(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_end', planItem);
}

// Typed like the removed field under old stripe types, like the new location under new ones.
type InvoiceSubscription<T> = T extends { subscription: infer S }
  ? S
  : T extends { parent: infer P }
    ? NonNullable<P> extends { subscription_details: infer D }
      ? NonNullable<D> extends { subscription: infer S }
        ? S | null
        : string | null
      : string | null
    : string | null;

// The old top-level field when present (old-version payloads), otherwise the new location.
function getInvoiceSubscription<T extends object>(invoice: T): InvoiceSubscription<T> {
  const legacy: unknown = Reflect.get(invoice, 'subscription');
  const parent: unknown = Reflect.get(invoice, 'parent');
  const details: unknown =
    parent && typeof parent === 'object' ? Reflect.get(parent, 'subscription_details') : undefined;
  const moved: unknown =
    details && typeof details === 'object' ? Reflect.get(details, 'subscription') : undefined;
  return (legacy !== undefined ? legacy : (moved ?? null)) as InvoiceSubscription<T>;
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2026-09-30.endive',
})

/**
 * Handle invoice.paid webhook
 * Called when Stripe successfully charges a subscription renewal
 */
export async function handleInvoicePaid(invoice: Stripe.Invoice) {
  const invoiceSubscription = getInvoiceSubscription(invoice)
  if (!invoiceSubscription) {
    return
  }

  const subscriptionId = typeof invoiceSubscription === 'string'
    ? invoiceSubscription
    : invoiceSubscription.id

  // Find subscription by Stripe ID
  const subscription = await db.subscription.findFirst({
    where: {
      authnetSubscriptionId: subscriptionId,
    },
  })

  if (!subscription) {
    console.log(`[Stripe Sync] Subscription ${subscriptionId} not found in DB`)
    return
  }

  // Retrieve Stripe subscription to get current period info
  const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId)

  // Update subscription record with current period dates
  await db.subscription.update({
    where: { id: subscription.id },
    data: {
      currentPeriodStart: new Date((getSubscriptionPeriodStart(stripeSubscription)) * 1000),
      currentPeriodEnd: new Date((getSubscriptionPeriodEnd(stripeSubscription)) * 1000),
      status: 'active',
    },
  })

  // Grant new resume credits on renewal
  const jobSeeker = await db.jobSeeker.findUnique({
    where: { userId: subscription.seekerId },
  })

  if (jobSeeker) {
    // Map plan to resume credits
    const creditMap: Record<string, number> = {
      trial_monthly: 1,
      gold_bimonthly: 5,
      vip_quarterly: 10,
      annual_platinum: 20,
    }

    const newCredits = creditMap[subscription.plan] || 0

    // Add credits to existing balance
    await db.jobSeeker.update({
      where: { userId: subscription.seekerId },
      data: {
        resumeCredits: (jobSeeker.resumeCredits || 0) + newCredits,
        membershipExpiresAt: new Date((getSubscriptionPeriodEnd(stripeSubscription)) * 1000),
      },
    })

    console.log(
      `[Stripe Sync] Renewed subscription ${subscription.id}: added ${newCredits} credits`
    )
  }

  // TODO: Send renewal notification email to user
}

/**
 * Handle customer.subscription.updated webhook
 * Called when subscription status or details change
 */
export async function handleSubscriptionUpdated(
  stripeSubscription: Stripe.Subscription
) {
  const subscription = await db.subscription.findFirst({
    where: {
      authnetSubscriptionId: stripeSubscription.id,
    },
  })

  if (!subscription) {
    return
  }

  // Map Stripe status to our status
  let dbStatus: string = 'active'
  if (stripeSubscription.status === 'canceled') {
    dbStatus = 'canceled'
  } else if (stripeSubscription.status === 'past_due') {
    dbStatus = 'past_due'
  } else if (stripeSubscription.status === 'paused') {
    dbStatus = 'paused'
  }

  // Update subscription
  const updateData: any = {
    status: dbStatus,
  }

  if (stripeSubscription.cancel_at_period_end) {
    updateData.cancelAtPeriodEnd = true
  }

  if ((getSubscriptionPeriodEnd(stripeSubscription))) {
    updateData.currentPeriodEnd = new Date((getSubscriptionPeriodEnd(stripeSubscription)) * 1000)
  }

  await db.subscription.update({
    where: { id: subscription.id },
    data: updateData,
  })

  console.log(
    `[Stripe Sync] Updated subscription ${subscription.id}: status=${dbStatus}`
  )

  // Handle trial to paid transition
  if (stripeSubscription.trial_end && stripeSubscription.trial_end < Date.now() / 1000) {
    const jobSeeker = await db.jobSeeker.findUnique({
      where: { userId: subscription.seekerId },
    })

    if (jobSeeker?.isOnTrial) {
      await db.jobSeeker.update({
        where: { userId: subscription.seekerId },
        data: {
          isOnTrial: false,
          trialEndsAt: new Date(stripeSubscription.trial_end * 1000),
        },
      })

      console.log(
        `[Stripe Sync] Transitioned subscription ${subscription.id} from trial to paid`
      )

      // TODO: Send "trial ended" email with payment confirmation
    }
  }
}

/**
 * Handle customer.subscription.deleted webhook
 * Called when subscription is canceled
 */
export async function handleSubscriptionDeleted(subscriptionId: string) {
  const subscription = await db.subscription.findFirst({
    where: {
      authnetSubscriptionId: subscriptionId,
    },
  })

  if (!subscription) {
    return
  }

  await db.subscription.update({
    where: { id: subscription.id },
    data: {
      status: 'canceled',
    },
  })

  // Update job seeker to reflect inactive membership
  await db.jobSeeker.update({
    where: { userId: subscription.seekerId },
    data: {
      membershipPlan: 'none',
      isOnTrial: false,
    },
  })

  console.log(`[Stripe Sync] Canceled subscription ${subscription.id}`)

  // TODO: Send "subscription canceled" email
}
