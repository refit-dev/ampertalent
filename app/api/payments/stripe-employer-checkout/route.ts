import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2026-09-30.endive' as any
})

const PACKAGE_NAMES: Record<string, string> = {
    standard: 'Standard Job Post',
    featured: 'Featured Job Post',
    email_blast: 'Email Blast Job Post',
    gold_plus: 'Gold Plus Job Post',
    concierge_lite: 'Concierge Lite Package',
    concierge_level_1: 'Concierge Level 1 Package',
    concierge_level_2: 'Concierge Level 2 Package',
    concierge_level_3: 'Concierge Level 3 Package',
}

export async function POST(request: NextRequest) {
    try {
        const currentUser = await getCurrentUser(request)
        if (!currentUser?.clerkUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { planId, amount, pendingJobPostId, sessionToken, addOnIds } = await request.json()

        if (!planId || !amount || !pendingJobPostId) {
            return NextResponse.json(
                { error: 'planId, amount, and pendingJobPostId are required' },
                { status: 400 }
            )
        }

        const email = currentUser.clerkUser.emailAddresses[0]?.emailAddress || ''
        const planName = PACKAGE_NAMES[planId] || `Job Post - ${planId}`

        // Create Stripe checkout session
        const session = await stripe.checkout.sessions.create({
            allowed_payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: { name: planName },
                        unit_amount: Math.round(amount * 100) // amount is in dollars
                    },
                    quantity: 1
                }
            ],
            mode: 'payment',
            payment_intent_data: {
                setup_future_usage: 'off_session'
            },
            customer_creation: 'always',
            success_url: `${process.env.NEXT_PUBLIC_APP_URL}/api/payments/stripe-job-success?session_id={CHECKOUT_SESSION_ID}&pendingJobPostId=${pendingJobPostId}`,
            cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/employer/jobs/new`,
            customer_email: email,
            metadata: {
                planId,
                pendingJobPostId,
                sessionToken: sessionToken || '',
                addOnIds: addOnIds ? JSON.stringify(addOnIds) : '',
                clerkUserId: currentUser.clerkUser.id,
                paymentType: 'employer_job_post'
            }
        })

        console.log('✅ STRIPE-EMPLOYER-CHECKOUT: Created session:', {
            sessionId: session.id,
            planId,
            amount,
            pendingJobPostId
        })

        return NextResponse.json({ sessionId: session.id, url: session.url })

    } catch (error) {
        console.error('Error creating employer Stripe checkout session:', error)
        return NextResponse.json(
            { error: 'Failed to create checkout session' },
            { status: 500 }
        )
    }
}
