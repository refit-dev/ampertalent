/**
 * POST /api/demo/employer-stripe-sandbox
 *
 * One-click Stripe sandbox checkout for the employer billing page. Creates a
 * real Stripe test-mode checkout session for a tiny amount ($1.00) and
 * returns the hosted-checkout URL. The visitor completes payment using
 * Stripe's standard test card `4242 4242 4242 4242` — no real money is
 * charged because we're in test mode (`sk_test_...`).
 *
 * Mirrors aims-commerce's "one-click sandbox" button so admins, prospects,
 * and demo visitors can experience the real Stripe payment UI (including
 * 3DS / declined-card flows) without having to set up a card.
 *
 * Defence in depth:
 *   - The caller MUST be authenticated (handled by `getCurrentUser`).
 *   - The session's `metadata.isStripeSandbox = '1'` is what the success
 *     handler uses to recognise and discard the sandbox payment so it
 *     never grants the user a real subscription.
 *   - The amount is hard-capped to $1.00 server-side — the client can't
 *     inject a higher amount even if the request body is tampered with.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2026-09-30.endive' as any,
})

// Hard cap to prevent anyone from charging more than a dollar via this
// sandbox endpoint, regardless of what the client sends.
const SANDBOX_AMOUNT_CENTS = 100 // $1.00
const SANDBOX_PRODUCT_NAME = 'AmperTalent Stripe Sandbox (test card 4242 4242 4242 4242)'

export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser(request)
    if (!currentUser?.clerkUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const email = currentUser.clerkUser.emailAddresses[0]?.emailAddress || ''
    if (!email) {
      return NextResponse.json(
        { error: 'No email on file — cannot create a Stripe checkout session' },
        { status: 400 }
      )
    }

    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      `http${request.headers.get('x-forwarded-proto') === 'https' ? 's' : ''}://${request.headers.get('host') || 'localhost:3000'}`

    const session = await stripe.checkout.sessions.create({
      allowed_payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: SANDBOX_PRODUCT_NAME },
            unit_amount: SANDBOX_AMOUNT_CENTS,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      customer_creation: 'always',
      success_url: `${baseUrl}/employer/billing?stripe_sandbox=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/employer/billing?stripe_sandbox=cancelled`,
      customer_email: email,
      metadata: {
        isStripeSandbox: '1',
        clerkUserId: currentUser.clerkUser.id,
        source: 'employer-billing-sandbox',
      },
    })

    return NextResponse.json({
      success: true,
      sessionId: session.id,
      url: session.url,
    })
  } catch (err: any) {
    console.error('🚨 DEMO EMPLOYER STRIPE SANDBOX: failed', err)
    return NextResponse.json(
      { error: 'Failed to create Stripe sandbox session', details: String(err?.message ?? err) },
      { status: 500 }
    )
  }
}
