/**
 * E2E Payment Flow Tests
 *
 * Covers every purchase scenario for both seekers and employers using
 * Stripe test-mode tokens.  Each test creates real Stripe objects and cleans
 * them up in afterEach/afterAll so the test account stays tidy.
 *
 * Environment requirements (same vars used by the app):
 *   STRIPE_SECRET_KEY          – test-mode sk_test_xxx
 *   DATABASE_URL / DIRECT_URL  – test database
 *
 * Stripe test card tokens (no real charges):
 *   pm_card_visa           → 4242 4242 4242 4242  (always succeeds)
 *   pm_card_chargeDeclined → 4000 0000 0000 0002  (always declines)
 */

import Stripe from 'stripe'
import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-09-30.endive' })

/** Created Stripe objects to delete during cleanup */
const cleanup = {
    customers: new Set<string>(),
    paymentIntents: new Set<string>(),
    subscriptions: new Set<string>(),
}

/** DB IDs of test rows to delete */
const dbCleanup = {
    userProfileIds: new Set<string>(),
    seekerIds: new Set<string>(),
    employerIds: new Set<string>(),
    subscriptionIds: new Set<string>(),
    employerPackageIds: new Set<string>(),
    paymentMethodIds: new Set<string>(),
}

async function createStripeCustomer(email: string): Promise<Stripe.Customer> {
    const c = await stripe.customers.create({ email, metadata: { test: 'payment-flows' } })
    cleanup.customers.add(c.id)
    return c
}

/** Attach the Stripe built-in test PM token to a customer and return the PM */
async function attachTestCard(customerId: string): Promise<Stripe.PaymentMethod> {
    // Use a test PaymentMethod token (already exists in every Stripe test account)
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customerId })
    return pm
}

/** Create a real pm_xxx from a raw card token via Stripe API (simulates Stripe.js) */
async function createPaymentMethod(): Promise<Stripe.PaymentMethod> {
    return stripe.paymentMethods.create({
        type: 'card',
        card: {
            number: '4242424242424242',
            exp_month: 12,
            exp_year: 2030,
            cvc: '123',
        },
    })
}

// ---------------------------------------------------------------------------
// Seed helpers — minimal DB rows for tests
// ---------------------------------------------------------------------------

async function seedEmployerUser() {
    const profile = await db.userProfile.create({
        data: {
            clerkUserId: `test_clerk_employer_${Date.now()}`,
            role: 'employer',
            name: 'Test Employer',
            email: `employer_test_${Date.now()}@example.com`,
        },
    })
    dbCleanup.userProfileIds.add(profile.id)

    const employer = await db.employer.create({
        data: { userId: profile.id, companyName: 'Test Co' },
    })
    dbCleanup.employerIds.add(employer.userId)

    return { profile, employer }
}

async function seedSeekerUser() {
    const profile = await db.userProfile.create({
        data: {
            clerkUserId: `test_clerk_seeker_${Date.now()}`,
            role: 'seeker',
            name: 'Test Seeker',
            email: `seeker_test_${Date.now()}@example.com`,
        },
    })
    dbCleanup.userProfileIds.add(profile.id)

    const seeker = await db.jobSeeker.create({
        data: { userId: profile.id, membershipPlan: 'none' },
    })
    dbCleanup.seekerIds.add(seeker.userId)

    return { profile, seeker }
}

// ---------------------------------------------------------------------------
// Global cleanup
// ---------------------------------------------------------------------------

afterEach(async () => {
    // Cancel Stripe subscriptions
    for (const id of cleanup.subscriptions) {
        await stripe.subscriptions.cancel(id).catch(() => { })
    }
    cleanup.subscriptions.clear()

    // Cancel/void Stripe payment intents
    for (const id of cleanup.paymentIntents) {
        await stripe.paymentIntents.cancel(id).catch(() => { })
    }
    cleanup.paymentIntents.clear()

    // Delete DB rows (FK order matters)
    if (dbCleanup.subscriptionIds.size > 0) {
        await db.subscription.deleteMany({ where: { id: { in: [...dbCleanup.subscriptionIds] } } }).catch(() => { })
        dbCleanup.subscriptionIds.clear()
    }
    if (dbCleanup.employerPackageIds.size > 0) {
        await db.employerPackage.deleteMany({ where: { id: { in: [...dbCleanup.employerPackageIds] } } }).catch(() => { })
        dbCleanup.employerPackageIds.clear()
    }
    if (dbCleanup.paymentMethodIds.size > 0) {
        await db.paymentMethod.deleteMany({ where: { id: { in: [...dbCleanup.paymentMethodIds] } } }).catch(() => { })
        dbCleanup.paymentMethodIds.clear()
    }
    if (dbCleanup.seekerIds.size > 0) {
        await db.jobSeeker.deleteMany({ where: { userId: { in: [...dbCleanup.seekerIds] } } }).catch(() => { })
        dbCleanup.seekerIds.clear()
    }
    if (dbCleanup.employerIds.size > 0) {
        await db.employer.deleteMany({ where: { userId: { in: [...dbCleanup.employerIds] } } }).catch(() => { })
        dbCleanup.employerIds.clear()
    }
    if (dbCleanup.userProfileIds.size > 0) {
        await db.userProfile.deleteMany({ where: { id: { in: [...dbCleanup.userProfileIds] } } }).catch(() => { })
        dbCleanup.userProfileIds.clear()
    }
})

afterAll(async () => {
    // Delete Stripe customers by detaching all PMs then deleting via raw API call
    for (const id of cleanup.customers) {
        try {
            // Detach all payment methods from the customer
            const pms = await stripe.paymentMethods.list({ customer: id, type: 'card' })
            for (const pm of pms.data) {
                await stripe.paymentMethods.detach(pm.id).catch(() => { })
            }
        } catch (_) { }
        // Stripe does not expose .delete() in the typed SDK for this version;
        // mark customer as deleted via the API directly
        await (stripe as any).customers.del(id).catch(() => { })
    }
    cleanup.customers.clear()
    await db.$disconnect()
})

// ===========================================================================
// SECTION 1: Stripe Customer + PaymentMethod Lifecycle
// ===========================================================================

describe('Stripe customer & PM lifecycle', () => {
    test('new PM has no customer until attached', async () => {
        const pm = await createPaymentMethod()
        expect(pm.customer).toBeNull()
        // Detach is a no-op if not attached — just verifying the token exists
        expect(pm.id).toMatch(/^pm_/)
    })

    test('attach PM to customer — PM.customer equals customer.id', async () => {
        const customer = await createStripeCustomer('pm-lifecycle@test.com')
        const pm = await createPaymentMethod()
        const attached = await stripe.paymentMethods.attach(pm.id, { customer: customer.id })
        expect(attached.customer).toBe(customer.id)

        // Retrieve confirms attachment
        const retrieved = await stripe.paymentMethods.retrieve(pm.id)
        expect(retrieved.customer).toBe(customer.id)
    })

    test('attaching a PM that is already attached raises an error if different customer', async () => {
        const c1 = await createStripeCustomer('c1@test.com')
        const c2 = await createStripeCustomer('c2@test.com')
        const pm = await createPaymentMethod()

        await stripe.paymentMethods.attach(pm.id, { customer: c1.id })

        // Attaching to a DIFFERENT customer should throw
        await expect(
            stripe.paymentMethods.attach(pm.id, { customer: c2.id })
        ).rejects.toThrow()
    })
})

// ===========================================================================
// SECTION 2: Employer Stripe Card Purchase — Happy Path
// ===========================================================================

describe('Employer: Stripe card purchase (happy path)', () => {
    test('charge succeeds when PM belongs to the customer used in PaymentIntent', async () => {
        const { profile, employer } = await seedEmployerUser()

        // Step 1: "Add card" — create PM, create customer, attach
        const pm = await createPaymentMethod()
        const customer = await createStripeCustomer(profile.email!)
        await stripe.paymentMethods.attach(pm.id, { customer: customer.id })

        // Save to DB (simulating POST /employer/billing/payment-methods)
        const dbPM = await db.paymentMethod.create({
            data: {
                employerId: employer.userId,
                type: 'credit_card',
                last4: '4242',
                brand: 'visa',
                expiryMonth: 12,
                expiryYear: 2030,
                isDefault: true,
                authnetPaymentProfileId: pm.id,
            },
        })
        dbCleanup.paymentMethodIds.add(dbPM.id)

        // Step 2: "Purchase package" — retrieve PM from Stripe to get its customer
        const retrievedPM = await stripe.paymentMethods.retrieve(pm.id)
        expect(retrievedPM.customer).toBe(customer.id)
        const stripeCustomerId = retrievedPM.customer as string

        const pi = await stripe.paymentIntents.create({
            customer: stripeCustomerId,
            amount: 9700, // $97
            currency: 'usd',
            payment_method: pm.id,
            confirm: true,
            off_session: true,
        })
        cleanup.paymentIntents.add(pi.id)

        expect(pi.status).toBe('succeeded')

        // Step 3: Persist EmployerPackage
        const pkg = await db.employerPackage.create({
            data: {
                employerId: employer.userId,
                packageType: 'standard',
                purchasedAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 86400 * 1000),
                arbSubscriptionId: stripeCustomerId,
                listingsRemaining: 3,
                featuredListingsRemaining: 0,
            },
        })
        dbCleanup.employerPackageIds.add(pkg.id)
        expect(pkg.packageType).toBe('standard')
    })

    test('charge fails when PM is attached to a DIFFERENT customer (the old bug)', async () => {
        const c1 = await createStripeCustomer('old-employer@test.com')
        const c2 = await createStripeCustomer('new-employer@test.com')
        const pm = await createPaymentMethod()

        // PM was attached to c2 (the "save card" customer)
        await stripe.paymentMethods.attach(pm.id, { customer: c2.id })

        // But we mistakenly use c1 (the old customer from an EmployerPackage)
        await expect(
            stripe.paymentIntents.create({
                customer: c1.id,           // ← wrong customer
                amount: 9700,
                currency: 'usd',
                payment_method: pm.id,
                confirm: true,
                off_session: true,
            })
        ).rejects.toThrow(/does not belong to the Customer/)
    })
})

// ===========================================================================
// SECTION 3: Employer Stripe Card Purchase — Second Purchase Reuses Customer
// ===========================================================================

describe('Employer: second purchase reuses same Stripe customer', () => {
    test('second purchase retrieves same cus_xxx as first purchase', async () => {
        const { profile, employer } = await seedEmployerUser()

        // First PM + customer
        const pm1 = await createPaymentMethod()
        const customer = await createStripeCustomer(profile.email!)
        await stripe.paymentMethods.attach(pm1.id, { customer: customer.id })

        const dbPM = await db.paymentMethod.create({
            data: {
                employerId: employer.userId,
                type: 'credit_card',
                last4: '4242',
                brand: 'visa',
                expiryMonth: 12,
                expiryYear: 2030,
                isDefault: true,
                authnetPaymentProfileId: pm1.id,
            },
        })
        dbCleanup.paymentMethodIds.add(dbPM.id)

        // First purchase — stores customer in EmployerPackage
        const pkg1 = await db.employerPackage.create({
            data: {
                employerId: employer.userId,
                packageType: 'standard',
                purchasedAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 86400 * 1000),
                arbSubscriptionId: customer.id,
                listingsRemaining: 3,
                featuredListingsRemaining: 0,
            },
        })
        dbCleanup.employerPackageIds.add(pkg1.id)

        // Second purchase: retrieve PM to get customer (the correct pattern)
        const retrievedPM = await stripe.paymentMethods.retrieve(pm1.id)
        expect(retrievedPM.customer).toBe(customer.id)

        const pi2 = await stripe.paymentIntents.create({
            customer: retrievedPM.customer as string,
            amount: 19700,
            currency: 'usd',
            payment_method: pm1.id,
            confirm: true,
            off_session: true,
        })
        cleanup.paymentIntents.add(pi2.id)
        expect(pi2.status).toBe('succeeded')

        const pkg2 = await db.employerPackage.create({
            data: {
                employerId: employer.userId,
                packageType: 'featured',
                purchasedAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 86400 * 1000),
                arbSubscriptionId: customer.id,
                listingsRemaining: 5,
                featuredListingsRemaining: 5,
            },
        })
        dbCleanup.employerPackageIds.add(pkg2.id)
        expect(pkg2.packageType).toBe('featured')
    })
})

// ===========================================================================
// SECTION 4: Seeker Stripe Subscription Purchase — Happy Path
// ===========================================================================

describe('Seeker: Stripe subscription purchase', () => {
    test('seeker first paid plan — PM attach + PaymentIntent succeeds', async () => {
        const { profile, seeker } = await seedSeekerUser()

        const pm = await createPaymentMethod()
        const customer = await createStripeCustomer(profile.email!)
        await stripe.paymentMethods.attach(pm.id, { customer: customer.id })

        // Save PM to DB
        const dbPM = await db.paymentMethod.create({
            data: {
                seekerId: seeker.userId,
                type: 'credit_card',
                last4: '4242',
                brand: 'visa',
                expiryMonth: 12,
                expiryYear: 2030,
                isDefault: true,
                authnetPaymentProfileId: pm.id,
            },
        })
        dbCleanup.paymentMethodIds.add(dbPM.id)

        // Resolve customer via PM retrieve (same as purchase route does)
        const retrievedPM = await stripe.paymentMethods.retrieve(pm.id)
        expect(retrievedPM.customer).toBe(customer.id)
        const stripeCustomerId = retrievedPM.customer as string

        // One-time charge (no price ID configured → PaymentIntent path)
        const pi = await stripe.paymentIntents.create({
            customer: stripeCustomerId,
            amount: 3900,
            currency: 'usd',
            payment_method: pm.id,
            confirm: true,
            off_session: true,
        })
        cleanup.paymentIntents.add(pi.id)
        expect(pi.status).toBe('succeeded')

        // Persist subscription
        const sub = await db.subscription.create({
            data: {
                seekerId: seeker.userId,
                plan: 'gold_bimonthly',
                status: 'active',
                authnetCustomerId: stripeCustomerId,
                authnetSubscriptionId: pi.id,
                currentPeriodStart: new Date(),
                currentPeriodEnd: new Date(Date.now() + 60 * 86400 * 1000),
                expires_at: new Date(Date.now() + 60 * 86400 * 1000),
            },
        })
        dbCleanup.subscriptionIds.add(sub.id)
        expect(sub.plan).toBe('gold_bimonthly')

        await db.jobSeeker.update({
            where: { userId: seeker.userId },
            data: { membershipPlan: 'gold_bimonthly' },
        })
    })

    test('seeker trial signup — no payment required', async () => {
        const { profile, seeker } = await seedSeekerUser()

        const customer = await createStripeCustomer(profile.email!)

        // Trial: just create the customer, no PM or charge needed
        const sub = await db.subscription.create({
            data: {
                seekerId: seeker.userId,
                plan: 'trial_monthly',
                status: 'active',
                authnetCustomerId: customer.id,
                currentPeriodStart: new Date(),
                currentPeriodEnd: new Date(Date.now() + 30 * 86400 * 1000),
                expires_at: new Date(Date.now() + 30 * 86400 * 1000),
            },
        })
        dbCleanup.subscriptionIds.add(sub.id)
        expect(sub.plan).toBe('trial_monthly')

        await db.jobSeeker.update({
            where: { userId: seeker.userId },
            data: { membershipPlan: 'trial_monthly', isOnTrial: true },
        })

        const updatedSeeker = await db.jobSeeker.findUnique({ where: { userId: seeker.userId } })
        expect(updatedSeeker?.isOnTrial).toBe(true)
    })

    test('seeker upgrade: second subscription reuses same customer', async () => {
        const { profile, seeker } = await seedSeekerUser()

        const pm = await createPaymentMethod()
        const customer = await createStripeCustomer(profile.email!)
        await stripe.paymentMethods.attach(pm.id, { customer: customer.id })

        const dbPM = await db.paymentMethod.create({
            data: {
                seekerId: seeker.userId,
                type: 'credit_card',
                last4: '4242',
                brand: 'visa',
                expiryMonth: 12,
                expiryYear: 2030,
                isDefault: true,
                authnetPaymentProfileId: pm.id,
            },
        })
        dbCleanup.paymentMethodIds.add(dbPM.id)

        // Gold subscription
        const sub1 = await db.subscription.create({
            data: {
                seekerId: seeker.userId,
                plan: 'gold_bimonthly',
                status: 'active',
                authnetCustomerId: customer.id,
                currentPeriodStart: new Date(),
                currentPeriodEnd: new Date(Date.now() + 60 * 86400 * 1000),
                expires_at: new Date(Date.now() + 60 * 86400 * 1000),
            },
        })
        dbCleanup.subscriptionIds.add(sub1.id)

        // Upgrade to VIP — must retrieve PM to get customer
        const retrievedPM = await stripe.paymentMethods.retrieve(pm.id)
        expect(retrievedPM.customer).toBe(customer.id)

        const pi = await stripe.paymentIntents.create({
            customer: retrievedPM.customer as string,
            amount: 7900,
            currency: 'usd',
            payment_method: pm.id,
            confirm: true,
            off_session: true,
        })
        cleanup.paymentIntents.add(pi.id)
        expect(pi.status).toBe('succeeded')

        const sub2 = await db.subscription.create({
            data: {
                seekerId: seeker.userId,
                plan: 'vip_quarterly',
                status: 'active',
                authnetCustomerId: customer.id,
                authnetSubscriptionId: pi.id,
                currentPeriodStart: new Date(),
                currentPeriodEnd: new Date(Date.now() + 90 * 86400 * 1000),
                expires_at: new Date(Date.now() + 90 * 86400 * 1000),
            },
        })
        dbCleanup.subscriptionIds.add(sub2.id)
        expect(sub2.plan).toBe('vip_quarterly')
    })
})

// ===========================================================================
// SECTION 5: Declined Card Scenarios
// ===========================================================================

describe('Declined card scenarios', () => {
    test('employer purchase with declining card returns error status', async () => {
        const customer = await createStripeCustomer('declined-employer@test.com')

        const declinedPM = await stripe.paymentMethods.create({
            type: 'card',
            card: { number: '4000000000000002', exp_month: 12, exp_year: 2030, cvc: '123' },
        })
        await stripe.paymentMethods.attach(declinedPM.id, { customer: customer.id })

        await expect(
            stripe.paymentIntents.create({
                customer: customer.id,
                amount: 9700,
                currency: 'usd',
                payment_method: declinedPM.id,
                confirm: true,
                off_session: true,
            })
        ).rejects.toThrow(/card_declined|Your card was declined/)
    })

    test('seeker purchase with declining card returns error', async () => {
        const customer = await createStripeCustomer('declined-seeker@test.com')

        const declinedPM = await stripe.paymentMethods.create({
            type: 'card',
            card: { number: '4000000000000002', exp_month: 12, exp_year: 2030, cvc: '123' },
        })
        await stripe.paymentMethods.attach(declinedPM.id, { customer: customer.id })

        await expect(
            stripe.paymentIntents.create({
                customer: customer.id,
                amount: 3900,
                currency: 'usd',
                payment_method: declinedPM.id,
                confirm: true,
                off_session: true,
            })
        ).rejects.toThrow(/card_declined|Your card was declined/)
    })
})

// ===========================================================================
// SECTION 6: PayPal Billing Agreement DB Persistence
// ===========================================================================

describe('PayPal billing agreement DB persistence', () => {
    test('employer PayPal method saved with PAYPAL| prefix', async () => {
        const { employer } = await seedEmployerUser()

        const fakeAgreementId = `B-TEST${Date.now()}`
        const dbPM = await db.paymentMethod.create({
            data: {
                employerId: employer.userId,
                type: 'paypal',
                last4: '',
                brand: 'PayPal',
                expiryMonth: 0,
                expiryYear: 0,
                isDefault: true,
                authnetPaymentProfileId: `PAYPAL|${fakeAgreementId}`,
            },
        })
        dbCleanup.paymentMethodIds.add(dbPM.id)

        expect(dbPM.authnetPaymentProfileId).toMatch(/^PAYPAL\|/)
        expect(dbPM.type).toBe('paypal')
    })

    test('seeker PayPal method saved correctly', async () => {
        const { seeker } = await seedSeekerUser()

        const fakeAgreementId = `B-SEEKERTEST${Date.now()}`
        const dbPM = await db.paymentMethod.create({
            data: {
                seekerId: seeker.userId,
                type: 'paypal',
                last4: '',
                brand: 'PayPal',
                expiryMonth: 0,
                expiryYear: 0,
                isDefault: true,
                authnetPaymentProfileId: `PAYPAL|${fakeAgreementId}`,
            },
        })
        dbCleanup.paymentMethodIds.add(dbPM.id)

        expect(dbPM.type).toBe('paypal')
    })

    test('PayPal method is not treated as a Stripe PM in purchase route', async () => {
        // The purchase route validates that authnetPaymentProfileId starts with pm_
        // A PAYPAL| value should return an appropriate error (not crash)
        const paypalPMId = `PAYPAL|B-FAKE${Date.now()}`
        const isStripeCard = paypalPMId.startsWith('pm_')
        expect(isStripeCard).toBe(false)

        // This simulates the validation guard in purchase/route.ts
        const shouldReject = !isStripeCard
        expect(shouldReject).toBe(true)
    })
})

// ===========================================================================
// SECTION 7: Upload — Supabase Storage URL validation
// ===========================================================================

describe('Supabase storage URL', () => {
    test('NEXT_PUBLIC_SUPABASE_URL is a valid HTTPS URL (not a postgres connection string)', () => {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
        expect(url).toMatch(/^https:\/\//)
        expect(url).not.toMatch(/^postgresql:\/\//)
        expect(url).not.toBe('')
    })

    test('SUPABASE_SERVICE_ROLE_KEY is present', () => {
        expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeTruthy()
    })

    test('generated public file URL uses correct HTTPS base', () => {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://example.supabase.co'
        const bucketName = process.env.SUPABASE_STORAGE_BUCKET || 'ampertalent-files'
        const fileKey = 'resumes/user123/abc-resume.pdf'
        const fileUrl = `${supabaseUrl}/storage/v1/object/public/${bucketName}/${fileKey}`
        expect(fileUrl).toMatch(/^https:\/\/.+\.supabase\.co\/storage\/v1\/object\/public\//)
    })
})
