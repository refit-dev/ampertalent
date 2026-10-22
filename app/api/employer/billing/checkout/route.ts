import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { db } from '@/lib/db'
import stripe from '@/lib/stripe'
import { JOB_PACKAGES } from '@/lib/employer-packages'

/**
 * POST /api/employer/billing/checkout
 * Creates a Stripe Checkout Session for employer package purchase.
 */
export async function POST(request: NextRequest) {
    try {
        const currentUser = await getCurrentUser(request)
        if (!currentUser?.clerkUser || !currentUser.profile) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { packageId } = await request.json()

        if (!packageId) {
            return NextResponse.json({ error: 'Package selection required' }, { status: 400 })
        }

        const userProfile = await db.userProfile.findUnique({
            where: { clerkUserId: currentUser.clerkUser.id },
            include: {
                employer: {
                    select: { companyName: true, currentPackageId: true },
                },
            },
        })

        if (!userProfile || !userProfile.employer) {
            return NextResponse.json({ error: 'Employer profile not found' }, { status: 404 })
        }

        const selectedPackage = JOB_PACKAGES.find((p) => p.id === packageId)
        if (!selectedPackage) {
            return NextResponse.json({ error: 'Invalid package ID' }, { status: 400 })
        }

        const customerEmail = userProfile.email || currentUser.clerkUser.emailAddresses[0]?.emailAddress || ''
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

        // Create Stripe Checkout Session
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            allowed_payment_method_types: ['card'],
            customer_email: customerEmail,
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        unit_amount: Math.round(selectedPackage.price * 100),
                        product_data: {
                            name: selectedPackage.name,
                            description: `${selectedPackage.listings} job listings for ${selectedPackage.duration} days`,
                        },
                    },
                    quantity: 1,
                },
            ],
            metadata: {
                userId: userProfile.id,
                packageId,
                userType: 'employer',
                companyName: userProfile.employer.companyName || '',
            },
            success_url: `${appUrl}/employer/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${appUrl}/employer/billing?checkout=cancelled`,
        })

        console.log('✅ EMPLOYER-BILLING: Stripe Checkout Session created:', session.id)

        return NextResponse.json({
            checkoutUrl: session.url,
            sessionId: session.id,
            expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
            paymentMethod: 'stripe',
        })
    } catch (error) {
        console.error('Error creating employer checkout:', error)
        return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 })
    }
}
