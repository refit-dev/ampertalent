import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2026-09-30.endive' as any
})

interface CheckoutRequest {
  planId: string
  successUrl?: string
  cancelUrl?: string
}

export async function POST(request: NextRequest) {
  try {
    console.log('🔍 API: Creating Stripe payment checkout session')

    const currentUser = await getCurrentUser(request)
    if (!currentUser?.clerkUser || !currentUser.profile) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (currentUser.profile.role !== 'seeker') {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const body: CheckoutRequest = await request.json()
    const { planId, successUrl, cancelUrl } = body

    if (!planId) {
      return NextResponse.json({ error: 'Plan ID is required' }, { status: 400 })
    }

    console.log(`💳 Creating Stripe checkout for plan: ${planId}, user: ${currentUser.profile.id}`)

    // Define membership plans with Stripe pricing
    const membershipPlans = {
      'trial': {
        name: '3 Day Free Trial Subscription',
        price: 3499, // $34.99 in cents
        billing: 'month',
        duration: 33,
        trialDays: 3
      },
      'gold': {
        name: 'Flex Gold Professional',
        price: 4999, // $49.99 in cents
        billing: '2 months',
        duration: 60
      },
      'vip-platinum': {
        name: 'Flex VIP Platinum Professional',
        price: 7999, // $79.99 in cents
        billing: '3 months',
        duration: 90
      },
      'annual-platinum': {
        name: 'Flex Annual Platinum Professional',
        price: 29900, // $299.00 in cents
        billing: 'year',
        duration: 365
      }
    }

    const selectedPlan = membershipPlans[planId as keyof typeof membershipPlans]
    if (!selectedPlan) {
      return NextResponse.json({ error: 'Invalid plan ID' }, { status: 400 })
    }

    const email = currentUser.clerkUser.emailAddresses[0]?.emailAddress || ''

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      allowed_payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: selectedPlan.name,
              description: `${selectedPlan.billing} subscription`
            },
            unit_amount: selectedPlan.price
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      success_url: successUrl || `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/seeker/membership/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/seeker/membership`,
      customer_email: email,
      metadata: {
        planId,
        userId: currentUser.profile.id,
        userRole: currentUser.profile.role
      }
    })

    console.log('✅ Stripe checkout session created:', {
      id: session.id,
      planId,
      amount: selectedPlan.price,
      userId: currentUser.profile.id
    })

    return NextResponse.json({
      checkoutUrl: session.url,
      sessionId: session.id,
      plan: selectedPlan
    })

  } catch (error) {
    console.error('❌ Error creating Stripe checkout session:', error)
    return NextResponse.json(
      { error: 'Failed to create checkout session' },
      { status: 500 }
    )
  }
}