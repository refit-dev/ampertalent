import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { db } from '@/lib/db'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2026-09-30.endive' as any
})

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser(request)

    if (!currentUser?.clerkUser || !currentUser.profile) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      )
    }

    // Log impersonation context for debugging
    if (currentUser.isImpersonating) {
      console.log('🎭 IMPERSONATION: Seeker billing-history API called with impersonated user', {
        adminId: currentUser.isImpersonating ? (currentUser as any).adminProfile?.id : undefined,
        impersonatedUserId: currentUser.profile?.id,
        impersonatedRole: currentUser.profile?.role
      })
    }

    // Verify user is a job seeker or admin impersonating a seeker
    if (currentUser.profile.role !== 'seeker' && !(currentUser.isImpersonating && currentUser.profile.role === 'seeker')) {
      console.log('🚫 SEEKER BILLING HISTORY: Access denied', {
        userRole: currentUser.profile.role,
        isImpersonating: currentUser.isImpersonating,
        userId: currentUser.profile.id,
        adminId: currentUser.isImpersonating ? (currentUser as any).adminProfile?.id : undefined
      })
      return NextResponse.json(
        { error: 'Only job seekers can access billing history' },
        { status: 403 }
      )
    }

    // Use the current user's profile directly (already loaded by getCurrentUser)
    const userProfile = currentUser.profile

    if (!userProfile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 404 })
    }

    // For now, return empty billing history since Stripe integration is still being set up
    // In a full implementation, this would query Stripe charges/invoices for the user
    console.log('📊 SEEKER BILLING HISTORY: Returning empty history (Stripe integration pending)', {
      userId: userProfile.id,
      email: userProfile.email
    })

    return NextResponse.json({
      transactions: [],
      totalCount: 0,
      hasMore: false
    })

  } catch (error) {
    console.error('Error fetching billing history:', error)
    return NextResponse.json(
      { error: 'Failed to fetch billing history' },
      { status: 500 }
    )
  }
}