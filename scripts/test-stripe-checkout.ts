import Stripe from 'stripe'

async function testStripeCheckoutFlow() {
    // Get Stripe key from environment (will be passed via shell)
    const stripeKey = process.env.STRIPE_SECRET_KEY

    if (!stripeKey) {
        console.error('❌ ERROR: STRIPE_SECRET_KEY not found in environment!')
        process.exit(1)
    }

    const stripe = new Stripe(stripeKey, {
        apiVersion: '2026-09-30.endive' as any
    })

    console.log('🧪 Testing Stripe Checkout Session Creation')
    console.log('=========================================')
    console.log('')
    console.log(`Stripe Key loaded: ${stripeKey.substring(0, 10)}...`)
    console.log('')

    try {
        // Create a test checkout session
        const session = await stripe.checkout.sessions.create({
            allowed_payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'Flex Trial'
                        },
                        unit_amount: 3499 // $34.99
                    },
                    quantity: 1
                }
            ],
            mode: 'payment',
            success_url: 'http://localhost:3000/seeker/dashboard?checkout=success&sessionId={CHECKOUT_SESSION_ID}',
            cancel_url: 'http://localhost:3000/checkout?planId=trial',
            customer_email: 'test@example.com',
            metadata: {
                planId: 'trial',
                pendingSignupId: 'test-123',
                sessionToken: 'test-token',
                clerkUserId: 'user_test123'
            }
        })

        console.log('✅ Stripe session created successfully!')
        console.log('')
        console.log('Session Details:')
        console.log(`  • Session ID: ${session.id}`)
        console.log(`  • Checkout URL: ${session.url}`)
        console.log(`  • Status: ${session.payment_status}`)
        console.log(`  • Amount: ${session.amount_total}`)
        console.log(`  • Currency: ${session.currency}`)
        console.log(`  • Mode: ${session.mode}`)
        console.log('')

        if (!session.url) {
            console.error('❌ ERROR: No URL returned from Stripe session!')
            process.exit(1)
        }

        console.log('✅ Checkout URL is valid')
        console.log('')
        console.log('Test Result: PASSED ✓')
        console.log('')
        console.log('Flow to test manually:')
        console.log('1. Visit: http://localhost:3000/checkout')
        console.log('2. Click Stripe tab')
        console.log('3. Click "Pay with Stripe" button')
        console.log('4. You should be redirected to Stripe checkout')
        console.log('5. Test card: 4242 4242 4242 4242')
        console.log('6. Any future expiry and CVC')
        console.log('7. Complete payment')
        console.log('8. Should redirect to /seeker/dashboard with success params')
    } catch (error: any) {
        console.error('❌ ERROR creating Stripe session:', error.message)
        console.error('Details:', error)
        process.exit(1)
    }
}

testStripeCheckoutFlow()
