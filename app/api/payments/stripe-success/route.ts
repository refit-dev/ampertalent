import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import Stripe from 'stripe'
import { NotificationService } from '@/lib/notification-service'
import { inAppNotificationService } from '@/lib/in-app-notification-service'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2026-09-30.endive' as any
})

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url)
        const sessionId = searchParams.get('session_id')
        const pendingSignupId = searchParams.get('pendingSignupId')

        console.log('🔄 STRIPE-SUCCESS: Received request:', {
            fullUrl: request.url,
            sessionId,
            pendingSignupId,
            allParams: Object.fromEntries(searchParams.entries())
        })

        if (!sessionId || !pendingSignupId) {
            console.error('Missing required parameters')
            return NextResponse.redirect(new URL('/sign-in?error=invalid_return', request.url))
        }

        // Verify the Stripe session
        const session = await stripe.checkout.sessions.retrieve(sessionId)
        if (!session || session.payment_status !== 'paid') {
            console.error('Invalid or unpaid Stripe session')
            return NextResponse.redirect(new URL('/sign-in?error=payment_failed', request.url))
        }

        // Get the pending signup
        const pendingSignup = await db.pendingSignup.findUnique({
            where: { id: pendingSignupId }
        })

        if (!pendingSignup) {
            console.error('Pending signup not found')
            return NextResponse.redirect(new URL('/sign-in?error=session_expired', request.url))
        }

        // Check if user profile already exists (created by onboarding completion)
        const userProfile = await db.userProfile.findUnique({
            where: { clerkUserId: pendingSignup.clerkUserId }
        })

        if (userProfile) {
            // Payment processed - complete sign-in and redirect
            console.log('✅ STRIPE-SUCCESS: User profile found, completing sign-in')

            // ====== SAVE STRIPE PAYMENT METHOD ======
            try {
                const stripeCustomerId = typeof session.customer === 'string' ? session.customer : null
                const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null

                if (stripeCustomerId) {
                    const latestSub = await db.subscription.findFirst({
                        where: { seekerId: userProfile.id },
                        orderBy: { createdAt: 'desc' },
                    })
                    if (latestSub) {
                        await db.subscription.update({
                            where: { id: latestSub.id },
                            data: { authnetCustomerId: stripeCustomerId }
                        })
                    }
                }

                if (paymentIntentId) {
                    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
                        expand: ['payment_method']
                    })
                    const pm = paymentIntent.payment_method as any
                    if (pm?.card) {
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
                        console.log('✅ STRIPE-SUCCESS: Saved seeker card payment method')
                    }
                }
            } catch (pmError) {
                console.error('⚠️ STRIPE-SUCCESS: Payment method save failed (non-blocking):', pmError)
            }

            // ====== SEND ADMIN + CUSTOMER PAYMENT EMAILS ======
            try {
                const planId = session.metadata?.planId || 'subscription'
                const planLabel = planId.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
                const amountPaid = (session.amount_total || 0) / 100
                const isTrial = planId === 'trial'
                const displayPrice = isTrial ? 0 : amountPaid
                const productDescription = isTrial ? `${planLabel} (Free Trial - No Charge Today)` : planLabel
                const orderDate = new Date()
                const orderNumber = `ORD-${orderDate.toISOString().slice(0, 10).replace(/-/g, '')}-${sessionId.slice(-4)}`

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
                    paymentType: 'card',
                    isRenewal: false,
                    transactionId: typeof session.payment_intent === 'string' ? session.payment_intent : sessionId,
                })

                await NotificationService.sendCustomerPaymentConfirmationEmail({
                    email: userProfile.email || '',
                    firstName: userProfile.firstName || userProfile.name?.split(' ')[0] || 'Valued Customer',
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
                    planLabel
                )

                console.log('✅ STRIPE-SUCCESS: Admin and customer emails sent')
            } catch (emailError) {
                console.error('⚠️ STRIPE-SUCCESS: Email sending failed (non-blocking):', emailError)
            }

            try {
                // Clean up pending signup
                await db.pendingSignup.delete({
                    where: { id: pendingSignupId }
                }).catch(console.error)

                // Redirect to dashboard with welcome message
                const dashboardUrl = new URL('/seeker/dashboard', request.url)
                dashboardUrl.searchParams.set('welcome', 'true')
                if (pendingSignup.clerkUserId) {
                    dashboardUrl.searchParams.set('auto_signin', pendingSignup.clerkUserId)
                }

                return NextResponse.redirect(dashboardUrl)
            } catch (signInError) {
                console.error('Error during redirect:', signInError)
            }

            // Fallback: redirect to dashboard
            const dashboardUrl = new URL('/seeker/dashboard', request.url)
            dashboardUrl.searchParams.set('welcome', 'true')

            return NextResponse.redirect(dashboardUrl)
        } else {
            // Profile not created yet - redirect to onboarding to complete the flow
            console.log('⏳ STRIPE-SUCCESS: Profile not found, redirecting to onboarding for completion')
            const onboardingUrl = new URL('/onboarding', request.url)
            onboardingUrl.searchParams.set('payment_status', 'success')
            onboardingUrl.searchParams.set('session_id', sessionId) // Use session_id (underscore, consistent with parameter name)
            onboardingUrl.searchParams.set('pendingSignupId', pendingSignupId)

            console.log('🔗 STRIPE-SUCCESS: Redirect URL:', onboardingUrl.toString())

            return NextResponse.redirect(onboardingUrl)
        }

    } catch (error) {
        console.error('❌ Error handling Stripe success:', error)
        return NextResponse.redirect(new URL('/sign-in?error=processing_failed', request.url))
    }
}