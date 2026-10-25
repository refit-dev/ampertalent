import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import Stripe from 'stripe'
import { NotificationService } from '@/lib/notification-service'
import { inAppNotificationService } from '@/lib/in-app-notification-service'
import { ensureDemoRoleRows } from '@/lib/demo-role-backfill'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2026-09-30.endive' as any
})

const PACKAGE_LISTINGS: Record<string, number> = {
    standard: 1, featured: 1, email_blast: 1, gold_plus: 1,
    concierge_lite: 1, concierge_level_1: 1, concierge_level_2: 1, concierge_level_3: 1,
}

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

const JOB_TYPE_MAPPING: Record<string, string> = {
    'FULL_TIME': 'FULL_TIME', 'PART_TIME': 'PART_TIME',
    'PERMANENT': 'PERMANENT', 'TEMPORARY': 'TEMPORARY',
    'full-time': 'FULL_TIME', 'part-time': 'PART_TIME',
    'contract': 'TEMPORARY', 'freelance': 'TEMPORARY',
}

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url)
        const sessionId = searchParams.get('session_id')
        const pendingJobPostId = searchParams.get('pendingJobPostId')

        console.log('🔄 STRIPE-JOB-SUCCESS: Received request:', { sessionId, pendingJobPostId })

        if (!sessionId || !pendingJobPostId) {
            console.error('Missing required parameters')
            return NextResponse.redirect(new URL('/employer/jobs/new?error=invalid_return', request.url))
        }

        // Verify the Stripe session
        const session = await stripe.checkout.sessions.retrieve(sessionId)
        if (!session || session.payment_status !== 'paid') {
            console.error('Invalid or unpaid Stripe session')
            return NextResponse.redirect(new URL('/employer/jobs/new?error=payment_failed', request.url))
        }

        // Get the pending job post
        const pendingJobPost = await db.pendingJobPost.findUnique({
            where: { id: pendingJobPostId }
        })

        if (!pendingJobPost || !pendingJobPost.clerkUserId) {
            console.error('Pending job post not found')
            return NextResponse.redirect(new URL('/employer/jobs/new?error=session_expired', request.url))
        }

        // Check if already processed (idempotent)
        if (pendingJobPost.checkoutSessionId === sessionId) {
            console.log('Already processed, redirecting to jobs page')
            return NextResponse.redirect(new URL('/employer/jobs?checkout=success', request.url))
        }

        // Get employer profile
        let employer = await db.employer.findFirst({
            where: { user: { clerkUserId: pendingJobPost.clerkUserId } }
        })

        if (!employer) {
            // Demo backfill: a freshly-created demo account hasn't been
            // through onboarding yet, so the Employer row may not exist.
            // Create it on the fly so the visitor's Stripe sandbox payment
            // doesn't fail with an "employer_not_found" redirect. Real
            // (non-demo) accounts fall through to the existing error.
            const pendingProfile = await db.userProfile.findUnique({
                where: { clerkUserId: pendingJobPost.clerkUserId },
                select: { id: true, name: true, role: true },
            })
            if (pendingProfile) {
                const demoState = await ensureDemoRoleRows(pendingProfile.id)
                if (demoState.isDemo && demoState.created === 'employer') {
                    console.log('💳 STRIPE-JOB-SUCCESS: demo backfill created missing Employer row for', pendingJobPost.clerkUserId)
                    employer = await db.employer.findFirst({
                        where: { user: { clerkUserId: pendingJobPost.clerkUserId } }
                    })
                }
            }
        }

        if (!employer) {
            console.error('Employer not found for clerkUserId:', pendingJobPost.clerkUserId)
            return NextResponse.redirect(new URL('/employer/jobs/new?error=employer_not_found', request.url))
        }

        const planId = session.metadata?.planId || pendingJobPost.selectedPackage || 'standard'
        const addOnIds: string[] = session.metadata?.addOnIds ? JSON.parse(session.metadata.addOnIds) : []

        // Parse job data from pending post
        let jobData: any = {}
        try {
            jobData = JSON.parse(pendingJobPost.jobData)
        } catch {
            console.error('Failed to parse job data')
            return NextResponse.redirect(new URL('/employer/jobs/new?error=invalid_job_data', request.url))
        }

        // Mark pending job post as processed (idempotency guard)
        await db.pendingJobPost.update({
            where: { id: pendingJobPostId },
            data: { checkoutSessionId: sessionId }
        })

        // Create employer package record
        const isEmailBlast = planId === 'email_blast'
        const employerPackage = await db.employerPackage.create({
            data: {
                employerId: employer.userId,
                packageType: planId as any,
                listingsRemaining: PACKAGE_LISTINGS[planId] ?? 1,
                purchasedAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            }
        })

        // Update employer's current package
        await db.employer.update({
            where: { userId: employer.userId },
            data: { currentPackageId: employerPackage.id }
        })

        // Determine vetting status
        const hasApprovedJob = await db.job.count({
            where: { employerId: employer.userId, status: 'approved' }
        }) > 0
        const isVetted = employer.isVetted || hasApprovedJob
        const jobStatus = isVetted ? 'approved' : 'pending_vetting'

        const mappedJobType = JOB_TYPE_MAPPING[jobData.jobType] || jobData.jobType || 'NOT_SPECIFIED'
        const emailBlastRequestedAt = isEmailBlast ? new Date() : null
        const emailBlastExpiresAt = isEmailBlast ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null

        // Create the actual job
        const job = await db.job.create({
            data: {
                employer: { connect: { userId: employer.userId } },
                title: jobData.title || 'Untitled',
                description: jobData.description || '',
                requirements: jobData.requirements || null,
                category: jobData.category || 'OTHER',
                experienceLevel: jobData.experienceLevel || null,
                payRangeMin: jobData.commissionOnly ? null : (jobData.salaryMin || jobData.payRangeMin || null),
                payRangeMax: jobData.commissionOnly ? null : (jobData.salaryMax || jobData.payRangeMax || null),
                payRangeText: jobData.commissionOnly ? 'Commission Only' : (jobData.payRangeText || null),
                salaryType: jobData.salaryType || null,
                type: mappedJobType as any,
                skillsRequired: jobData.skills || jobData.skillsRequired || [],
                benefits: jobData.benefits || null,
                applicationDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                website: jobData.website || null,
                linkedinProfile: jobData.linkedinProfile || null,
                contactPhone: jobData.contactPhone || null,
                isFlexibleHours: jobData.isFlexibleHours || false,
                hoursPerWeek: jobData.hoursPerWeek || null,
                remoteSchedule: jobData.remoteSchedule || null,
                locationText: jobData.location || jobData.locationText || 'Remote',
                conciergeRequested: jobData.conciergeRequested || false,
                status: jobStatus,
                isCompanyPrivate: jobData.isCompanyPrivate || false,
                isEmailBlast: isEmailBlast,
                emailBlastRequestedAt,
                emailBlastExpiresAt,
            }
        })

        // Decrement listing credits
        await db.employerPackage.update({
            where: { id: employerPackage.id },
            data: { listingsRemaining: { decrement: 1 } }
        })

        if (addOnIds.length > 0) {
            console.log('Add-ons purchased:', addOnIds)
        }

        // Clean up pending job post
        await db.pendingJobPost.delete({ where: { id: pendingJobPostId } }).catch(console.error)

        console.log('✅ STRIPE-JOB-SUCCESS: Job created:', { jobId: job.id, planId, status: jobStatus })

        // ====== SAVE STRIPE PAYMENT METHOD FOR EMPLOYER ======
        try {
            const stripeCustomerId = typeof session.customer === 'string' ? session.customer : null
            const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null

            if (stripeCustomerId) {
                // Store Stripe customer ID in employer package so billing page can fetch payment methods
                await db.employerPackage.update({
                    where: { id: employerPackage.id },
                    data: { arbSubscriptionId: stripeCustomerId }
                })
                console.log('✅ STRIPE-JOB-SUCCESS: Saved Stripe customer ID to employer package:', stripeCustomerId)
            }

            if (paymentIntentId) {
                const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
                    expand: ['payment_method']
                })
                const pm = paymentIntent.payment_method as Stripe.PaymentMethod | null
                if (pm?.card) {
                    const existing = await db.$queryRaw<Array<{ id: string }>>`
                        SELECT id FROM payment_methods WHERE employer_id = ${employer.userId} LIMIT 1
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
                                employerId: employer.userId,
                                type: 'credit_card',
                                last4: pm.card.last4,
                                brand: pm.card.brand,
                                expiryMonth: pm.card.exp_month,
                                expiryYear: pm.card.exp_year,
                                isDefault: true,
                            }
                        })
                    }
                    console.log('✅ STRIPE-JOB-SUCCESS: Saved employer card:', pm.card.brand, '****' + pm.card.last4)
                }
            }
        } catch (pmError) {
            console.error('⚠️ STRIPE-JOB-SUCCESS: Payment method save failed (non-blocking):', pmError)
        }

        // ====== SEND ADMIN + CUSTOMER PAYMENT EMAILS ======
        try {
            const employerProfile = await db.userProfile.findFirst({
                where: { employer: { userId: employer.userId } },
                include: { employer: true }
            })

            const packageNameLabel = PACKAGE_NAMES[planId] || planId
            const amountPaid = (session.amount_total || 0) / 100
            const orderDate = new Date()
            const orderNumber = `ORD-${orderDate.toISOString().slice(0, 10).replace(/-/g, '')}-${job.id.slice(-4)}`

            await NotificationService.sendAdminPaymentNotification({
                orderNumber,
                orderDate: orderDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
                customerName: employerProfile?.employer?.companyName || employerProfile?.name || 'Employer',
                customerType: 'Employer',
                customerId: employer.userId,
                customerEmail: employerProfile?.email || session.customer_email || '',
                productDescription: packageNameLabel,
                quantity: 1,
                price: amountPaid,
                lineItems: [{ name: packageNameLabel, quantity: 1, price: amountPaid }],
                paymentType: 'card',
                isRenewal: false,
                transactionId: typeof session.payment_intent === 'string' ? session.payment_intent : sessionId,
            })

            await NotificationService.sendCustomerPaymentConfirmationEmail({
                email: employerProfile?.email || session.customer_email || '',
                firstName: employerProfile?.firstName || employerProfile?.name?.split(' ')[0] || 'Valued Customer',
                lastName: employerProfile?.lastName || undefined,
                amount: amountPaid,
                description: packageNameLabel,
                transactionId: typeof session.payment_intent === 'string' ? session.payment_intent : sessionId,
                lineItems: [{ name: packageNameLabel, amount: amountPaid }],
                isRecurring: false,
                paymentType: 'card',
            })

            // ====== IN-APP NOTIFICATIONS ======
            const txId = typeof session.payment_intent === 'string' ? session.payment_intent : sessionId
            const customerName = employerProfile?.employer?.companyName || employerProfile?.name || 'Employer'
            await inAppNotificationService.notifyPaymentReceived(
                employer.userId,
                customerName,
                amountPaid,
                packageNameLabel,
                'employer'
            )
            await inAppNotificationService.notifyEmployerPaymentConfirmation(
                employer.userId,
                amountPaid,
                packageNameLabel,
                txId,
                packageNameLabel
            )

            console.log('✅ STRIPE-JOB-SUCCESS: Admin and customer emails sent')
        } catch (emailError) {
            console.error('⚠️ STRIPE-JOB-SUCCESS: Email sending failed (non-blocking):', emailError)
        }

        return NextResponse.redirect(new URL(`/employer/jobs?checkout=success&jobId=${job.id}`, request.url))

    } catch (error) {
        console.error('Error processing Stripe job success:', error)
        return NextResponse.redirect(new URL('/employer/jobs/new?error=processing_failed', request.url))
    }
}
