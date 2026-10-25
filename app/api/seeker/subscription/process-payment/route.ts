import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { db } from '@/lib/db'
import Stripe from 'stripe'
import { Decimal } from '@prisma/client/runtime/library'
import { NotificationService } from '@/lib/notification-service'
import { inAppNotificationService } from '@/lib/in-app-notification-service'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2026-09-30.endive' as any
})

// Map planId to MembershipPlan enum
const planIdToMembershipPlan: Record<string, any> = {
    'trial': 'trial_monthly',
    'gold': 'gold_bimonthly',
    'vip-platinum': 'vip_quarterly',
    'annual-platinum': 'annual_platinum'
}

export async function POST(request: NextRequest) {
    try {
        const currentUser = await getCurrentUser(request)
        if (!currentUser?.clerkUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { sessionId, paymentMethod, paymentStatus } = await request.json()

        if (!sessionId || !paymentMethod) {
            return NextResponse.json(
                { error: 'sessionId and paymentMethod required' },
                { status: 400 }
            )
        }

        console.log('💳 PROCESS-PAYMENT: Processing payment:', {
            userId: currentUser.clerkUser.id,
            sessionId,
            paymentMethod,
            paymentStatus
        })

        if (paymentStatus !== 'success') {
            console.log('⚠️ PROCESS-PAYMENT: Payment status is not success, skipping processing')
            return NextResponse.json(
                { error: 'Payment not successful' },
                { status: 400 }
            )
        }

        // For Stripe payments, retrieve the session and verify payment
        if (paymentMethod === 'stripe') {
            try {
                const session = await stripe.checkout.sessions.retrieve(sessionId)

                if (!session) {
                    console.error('❌ PROCESS-PAYMENT: Stripe session not found:', sessionId)
                    return NextResponse.json(
                        { error: 'Stripe session not found' },
                        { status: 404 }
                    )
                }

                console.log('✅ PROCESS-PAYMENT: Stripe session retrieved:', {
                    sessionId: session.id,
                    paymentStatus: session.payment_status,
                    customer: session.customer_email
                })

                // Only process if payment_status is 'paid'
                if (session.payment_status !== 'paid') {
                    console.log('⚠️ PROCESS-PAYMENT: Stripe payment not yet paid, status:', session.payment_status)
                    return NextResponse.json(
                        { error: 'Payment not yet completed' },
                        { status: 400 }
                    )
                }

                // Get the plan from metadata
                const planId = session.metadata?.planId as string
                if (!planId) {
                    console.error('❌ PROCESS-PAYMENT: No planId in session metadata')
                    return NextResponse.json(
                        { error: 'Plan not found in session' },
                        { status: 400 }
                    )
                }

                const membershipPlan = planIdToMembershipPlan[planId]
                if (!membershipPlan) {
                    console.error('❌ PROCESS-PAYMENT: Unknown planId:', planId)
                    return NextResponse.json(
                        { error: 'Unknown plan' },
                        { status: 400 }
                    )
                }

                // Get or create user profile
                let userProfile = await db.userProfile.findUnique({
                    where: { clerkUserId: currentUser.clerkUser.id }
                })

                if (!userProfile) {
                    console.log('📝 PROCESS-PAYMENT: Creating new user profile')
                    userProfile = await db.userProfile.create({
                        data: {
                            clerkUserId: currentUser.clerkUser.id,
                            email: currentUser.clerkUser.emailAddresses[0]?.emailAddress || '',
                            name: `${currentUser.clerkUser.firstName || ''} ${currentUser.clerkUser.lastName || ''}`.trim(),
                            role: 'seeker'
                        }
                    })
                }

                // Get or create job seeker profile
                let jobSeeker = await db.jobSeeker.findUnique({
                    where: { userId: userProfile.id }
                })

                if (!jobSeeker) {
                    console.log('📝 PROCESS-PAYMENT: Creating new job seeker profile')
                    jobSeeker = await db.jobSeeker.create({
                        data: {
                            userId: userProfile.id
                        }
                    })
                }

                // CRITICAL FIX: Create ExternalPayment record FIRST
                // The Subscription table has a foreign key constraint on externalPaymentId
                console.log('💳 PROCESS-PAYMENT: Creating external payment record for Stripe session')
                const amountInDollars = ((session.amount_total || 0) / 100).toFixed(2)
                const externalPayment = await db.externalPayment.create({
                    data: {
                        userId: userProfile.id,
                        amount: new Decimal(amountInDollars),
                        planId: planId,
                        status: 'completed',
                        webhookProcessedAt: new Date()
                    }
                })

                console.log('✅ PROCESS-PAYMENT: External payment created:', {
                    id: externalPayment.id,
                    amount: externalPayment.amount,
                    planId: externalPayment.planId
                })

                // Create subscription record with the external payment ID
                const trialEndsAt = planId === 'trial' ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) : null
                const subscription = await db.subscription.create({
                    data: {
                        seekerId: jobSeeker.userId,
                        plan: membershipPlan,
                        status: 'active',
                        externalPaymentId: externalPayment.id,  // Link to the external payment we just created
                        currentPeriodStart: new Date(),
                        currentPeriodEnd: new Date(Date.now() + (planId === 'trial' ? 3 : 30) * 24 * 60 * 60 * 1000),
                        nextBillingDate: new Date(Date.now() + (planId === 'trial' ? 3 : 30) * 24 * 60 * 60 * 1000)
                    }
                })

                // Update job seeker membership info
                await db.jobSeeker.update({
                    where: { userId: jobSeeker.userId },
                    data: {
                        membershipPlan,
                        membershipExpiresAt: subscription.currentPeriodEnd,
                        isOnTrial: planId === 'trial',
                        trialEndsAt
                    }
                })

                console.log('✅ PROCESS-PAYMENT: Subscription created:', {
                    subscriptionId: subscription.id,
                    plan: subscription.plan,
                    seekerId: subscription.seekerId
                })

                // ====== SAVE STRIPE PAYMENT METHOD ======
                try {
                    const stripeCustomerId = typeof session.customer === 'string' ? session.customer : null
                    const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null

                    if (stripeCustomerId) {
                        // Store Stripe customer ID so the subscription page can fetch payment methods
                        await db.subscription.update({
                            where: { id: subscription.id },
                            data: { authnetCustomerId: stripeCustomerId }
                        })
                        console.log('✅ PROCESS-PAYMENT: Saved Stripe customer ID to subscription:', stripeCustomerId)
                    }

                    if (paymentIntentId) {
                        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
                            expand: ['payment_method']
                        })
                        const pm = paymentIntent.payment_method as Stripe.PaymentMethod | null
                        if (pm?.card) {
                            // Check for existing card payment method for this seeker
                            const existing = await db.$queryRaw<Array<{ id: string }>>`
                                SELECT id FROM payment_methods WHERE seeker_id = ${userProfile.id} LIMIT 1
                            `
                            if (existing.length > 0) {
                                await db.$executeRaw`
                                    UPDATE payment_methods
                                    SET type = 'credit_card', last4 = ${pm.card.last4}, brand = ${pm.card.brand},
                                        expiry_month = ${pm.card.exp_month}, expiry_year = ${pm.card.exp_year},
                                        is_default = true, updated_at = NOW()
                                    WHERE id = ${existing[0].id}
                                `
                            } else {
                                await db.paymentMethod.create({
                                    data: {
                                        seekerId: userProfile.id,
                                        type: 'credit_card',
                                        last4: pm.card.last4,
                                        brand: pm.card.brand,
                                        expiryMonth: pm.card.exp_month,
                                        expiryYear: pm.card.exp_year,
                                        isDefault: true,
                                    }
                                })
                            }
                            console.log('✅ PROCESS-PAYMENT: Saved Stripe card payment method:', pm.card.brand, '****' + pm.card.last4)
                        }
                    }
                } catch (pmError) {
                    console.error('⚠️ PROCESS-PAYMENT: Payment method save failed (non-blocking):', pmError)
                }

                // ====== SEND ADMIN + CUSTOMER PAYMENT EMAILS ======
                try {
                    const isTrial = planId === 'trial'
                    const displayPrice = isTrial ? 0 : (session.amount_total || 0) / 100
                    const planName = membershipPlan.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
                    const productDescription = isTrial ? `${planName} (Free Trial - No Charge Today)` : planName
                    const orderDate = new Date()
                    const orderNumber = `ORD-${orderDate.toISOString().slice(0, 10).replace(/-/g, '')}-${subscription.id.slice(-4)}`
                    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

                    await NotificationService.sendAdminPaymentNotification({
                        orderNumber,
                        orderDate: orderDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
                        customerName: userProfile.name || 'Seeker',
                        customerType: 'Seeker',
                        customerId: userProfile.id,
                        customerEmail: userProfile.email || '',
                        productDescription,
                        quantity: 1,
                        price: displayPrice,
                        lineItems: [{ name: productDescription, quantity: 1, price: displayPrice }],
                        subscriptionStartDate: orderDate.toLocaleDateString('en-US'),
                        paymentType: 'card',
                        isRenewal: false,
                        transactionId: typeof session.payment_intent === 'string' ? session.payment_intent : sessionId,
                    })

                    await NotificationService.sendCustomerPaymentConfirmationEmail({
                        email: userProfile.email || '',
                        firstName: userProfile.firstName || userProfile.name?.split(' ')[0] || 'Valued Customer',
                        lastName: userProfile.lastName || undefined,
                        amount: displayPrice,
                        description: productDescription,
                        transactionId: typeof session.payment_intent === 'string' ? session.payment_intent : sessionId,
                        lineItems: [{ name: productDescription, amount: displayPrice }],
                        isTrial,
                        isRecurring: false,
                        paymentType: 'card',
                    })

                    // ====== IN-APP NOTIFICATIONS ======
                    const txId = typeof session.payment_intent === 'string' ? session.payment_intent : sessionId
                    await inAppNotificationService.notifyPaymentReceived(
                        userProfile.id,
                        userProfile.name || 'Seeker',
                        displayPrice,
                        productDescription,
                        'seeker'
                    )
                    await inAppNotificationService.notifySeekerPaymentConfirmation(
                        userProfile.id,
                        displayPrice,
                        productDescription,
                        txId,
                        planName
                    )

                    console.log('✅ PROCESS-PAYMENT: Admin and customer emails sent')
                } catch (emailError) {
                    console.error('⚠️ PROCESS-PAYMENT: Email sending failed (non-blocking):', emailError)
                }

                return NextResponse.json({
                    success: true,
                    subscriptionId: subscription.id,
                    plan: subscription.plan
                })
            } catch (error) {
                console.error('❌ PROCESS-PAYMENT: Error processing Stripe payment:', error)
                return NextResponse.json(
                    { error: 'Failed to verify Stripe payment' },
                    { status: 500 }
                )
            }
        }

        // For PayPal payments (already processed via webhook/return page)
        if (paymentMethod === 'paypal') {
            console.log('ℹ️ PROCESS-PAYMENT: PayPal payment processing is handled via return page, skipping')
            return NextResponse.json({
                success: true,
                message: 'PayPal payment already processed'
            })
        }

        return NextResponse.json(
            { error: 'Unknown payment method' },
            { status: 400 }
        )
    } catch (error) {
        console.error('❌ PROCESS-PAYMENT: Unexpected error:', error)
        return NextResponse.json(
            { error: 'Failed to process payment' },
            { status: 500 }
        )
    }
}
