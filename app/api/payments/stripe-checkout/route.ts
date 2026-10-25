import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { db } from '@/lib/db'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2026-09-30.endive' as any
})

export async function POST(request: NextRequest) {
    try {
        const currentUser = await getCurrentUser(request)
        if (!currentUser?.clerkUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { planId, amount, pendingSignupId, sessionToken } = await request.json()

        if (!planId || !amount) {
            return NextResponse.json(
                { error: 'Plan and amount required' },
                { status: 400 }
            )
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
                            name: `Flex ${planId.charAt(0).toUpperCase()}${planId.slice(1).replace('-', ' ')}`
                        },
                        unit_amount: amount
                    },
                    quantity: 1
                }
            ],
            mode: 'payment',
            payment_intent_data: {
                setup_future_usage: 'off_session'
            },
            customer_creation: 'always',
            success_url: `${process.env.NEXT_PUBLIC_APP_URL}/api/payments/stripe-success?session_id={CHECKOUT_SESSION_ID}&pendingSignupId=${pendingSignupId}`,
            cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/paypal?planId=${planId}&pendingSignupId=${pendingSignupId}`,
            customer_email: email,
            metadata: {
                planId,
                pendingSignupId,
                sessionToken,
                clerkUserId: currentUser.clerkUser.id
            }
        })

        console.log('✅ STRIPE-CHECKOUT: Created checkout session:', {
            sessionId: session.id,
            checkoutUrl: session.url,
            planId,
            amount,
            email
        })

        if (!session.url) {
            throw new Error('No checkout URL returned from Stripe')
        }

        return NextResponse.json({
            sessionId: session.id,
            url: session.url
        })
    } catch (error) {
        console.error('Error creating Stripe checkout session:', error)
        return NextResponse.json(
            { error: 'Failed to create checkout session' },
            { status: 500 }
        )
    }
}
