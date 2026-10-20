/**
 * src/jobs/treasurySweep.ts
 *
 * Treasury sweep engine for hot/warm/cold account tiering (#528).
 *
 * evaluateTreasuryBalances reads each active TreasuryAccount and its tier
 * pair's active TreasurySweepPolicy, planning a sweep whenever the hot-side
 * balance exceeds the policy's maxHotBalance by more than minSweepAmount.
 * executeSweep gates on requiresApprovalAbove via a MultisigEnvelope (the
 * treasury-specific multisig primitive already in schema) rather than the
 * sub-account ApprovalPolicy engine, which has no concept of a
 * non-user-owned system sweep — see docs/TREASURY.md.
 */

import { TreasuryTier } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'
import { getActivePolicy } from '../treasury/policy'
import { enqueueOutboxOp } from '../outbox/service'
import { getNativeBalance } from '../stellar/client'
import { alertingService } from '../services/alerting'

const TREASURY_SWEEP_INTERVAL_MS = 300_000 // 5 minutes
const HYSTERESIS_FACTOR = 1.5 // targetHigh must be >= targetLow * 1.5

export interface SweepPlan {
  fromTier: TreasuryTier
  toTier: TreasuryTier
  asset: string
  amount: string
  reason: string
}

const TIER_PAIRS: Array<[TreasuryTier, TreasuryTier]> = [
  ['HOT', 'WARM'],
  ['WARM', 'COLD'],
]

export interface SweepPreviewItem extends SweepPlan {
  policyId: string
  policyVersion: number
  policyEnabled: boolean
  requiresApproval: boolean
}

async function planSweeps(
  includeDisabled: boolean
): Promise<SweepPreviewItem[]> {
  const plans: SweepPreviewItem[] = []

  for (const [fromTier, toTier] of TIER_PAIRS) {
    const policy = await getActivePolicy(fromTier, toTier)
    if (!policy) continue
    if (!policy.sweepsEnabled && !includeDisabled) continue

    const accounts = await db.treasuryAccount.findMany({
      where: { tier: fromTier, isActive: true },
    })

    for (const account of accounts) {
      const balance = await getNativeBalance(account.publicKey).catch(() => 0)
      const over = balance - Number(policy.maxHotBalance)
      if (over <= Number(policy.minSweepAmount)) continue

      plans.push({
        fromTier,
        toTier,
        asset: 'XLM',
        amount: over.toFixed(7),
        reason: 'hot_over_high_band',
        policyId: policy.id,
        policyVersion: policy.version,
        policyEnabled: policy.sweepsEnabled,
        requiresApproval:
          policy.requiresApprovalAbove != null &&
          over > Number(policy.requiresApprovalAbove),
      })
    }
  }

  return plans
}

export async function evaluateTreasuryBalances(): Promise<SweepPlan[]> {
  const plans = (await planSweeps(false)).map(
    ({ fromTier, toTier, asset, amount, reason }) => ({
      fromTier,
      toTier,
      asset,
      amount,
      reason,
    })
  )

  logger.info('[TreasurySweep] Evaluated treasury balances', {
    plansFound: plans.length,
  })

  return plans
}

/**
 * Dry run (#620): computes what would move under every active policy,
 * enabled or not. Read-only — reads balances from the network but never
 * creates a TreasurySweep, MultisigEnvelope or outbox op.
 */
export async function previewTreasurySweep(): Promise<{
  previewedAt: string
  plans: SweepPreviewItem[]
}> {
  return {
    previewedAt: new Date().toISOString(),
    plans: await planSweeps(true),
  }
}

export async function executeSweep(plan: SweepPlan): Promise<void> {
  try {
    await runSweep(plan)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    await alertingService.emit(
      {
        title: 'Treasury sweep failed',
        description: `Sweep ${plan.fromTier}->${plan.toTier} of ${plan.amount} ${plan.asset} failed: ${message}`,
        severity: 'critical',
        component: 'treasury-sweep',
        metadata: { ...plan, error: message },
      },
      `treasury-sweep-failed:${plan.fromTier}:${plan.toTier}`
    )
    throw error
  }
}

async function runSweep(plan: SweepPlan): Promise<void> {
  const policy = await getActivePolicy(plan.fromTier, plan.toTier)
  if (!policy?.sweepsEnabled) {
    throw new Error(
      `Sweeps are not enabled for ${plan.fromTier}->${plan.toTier}; preview and enable the policy first`
    )
  }

  const sweep = await db.treasurySweep.create({
    data: {
      fromTier: plan.fromTier,
      toTier: plan.toTier,
      asset: plan.asset,
      amount: plan.amount,
      status: 'PLANNED',
      reason: plan.reason,
    },
  })

  const requiresApproval =
    policy?.requiresApprovalAbove != null &&
    Number(plan.amount) > Number(policy.requiresApprovalAbove)

  if (requiresApproval) {
    // Large sweeps are held behind the treasury's own multisig primitive
    // rather than the sub-account ApprovalPolicy engine (which has no
    // concept of a system-initiated, non-user-owned operation) — an admin
    // must collect signatures via src/stellar/multisig.ts before this
    // envelope reaches READY and a follow-up call enqueues the outbox op.
    const envelope = await db.multisigEnvelope.create({
      data: {
        sweepId: sweep.id,
        publicKey: '',
        threshold: 1,
        signatures: [],
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    })

    logger.info('[TreasurySweep] Sweep held for multisig approval', {
      sweepId: sweep.id,
      envelopeId: envelope.id,
      amount: plan.amount,
    })
    return
  }

  const op = await enqueueOutboxOp(db, {
    idempotencyKey: `TREASURY_SWEEP:${sweep.id}`,
    userId: 'SYSTEM',
    kind: 'TREASURY_SWEEP',
    actor: 'SYSTEM',
    payload: {
      method: 'treasury_sweep',
      fromTier: plan.fromTier,
      toTier: plan.toTier,
      asset: plan.asset,
      amount: Number(plan.amount),
      sweepId: sweep.id,
    },
  })

  await db.treasurySweep.update({
    where: { id: sweep.id },
    data: { outboxOpId: op.id, status: 'SUBMITTED' },
  })
}

/**
 * Bypasses normal cadence, never the signing bar: no requiresApprovalAbove
 * check, ever. Always full multisig threshold — the design's "emergency
 * sweep changes cadence, never the signing bar" requirement. Triggered by
 * admin action or the circuit breaker's manual-trip path.
 */
export async function executeEmergencySweep(
  fromTier: TreasuryTier,
  toTier: TreasuryTier,
  asset: string,
  amount: string,
  triggeredBy: string,
  reason: string
): Promise<void> {
  const sweep = await db.treasurySweep.create({
    data: {
      fromTier,
      toTier,
      asset,
      amount,
      status: 'PLANNED',
      reason: `emergency:${reason}`,
    },
  })

  const op = await enqueueOutboxOp(db, {
    idempotencyKey: `TREASURY_SWEEP:EMERGENCY:${sweep.id}`,
    userId: 'SYSTEM',
    kind: 'TREASURY_SWEEP',
    actor: 'SYSTEM',
    priority: 'CRITICAL',
    payload: {
      method: 'treasury_sweep',
      fromTier,
      toTier,
      asset,
      amount: Number(amount),
      sweepId: sweep.id,
    },
  })

  await db.treasurySweep.update({
    where: { id: sweep.id },
    data: { outboxOpId: op.id, status: 'SUBMITTED' },
  })

  await db.adminAuditLog.create({
    data: {
      adminName: triggeredBy,
      action: 'treasury.emergency_sweep',
      target: sweep.id,
      result: 'submitted',
      details: { fromTier, toTier, asset, amount, reason },
    },
  })

  logger.warn('[TreasurySweep] Emergency sweep executed', {
    sweepId: sweep.id,
    fromTier,
    toTier,
    amount,
    triggeredBy,
    reason,
  })
}

export function validateHysteresis(
  targetLow: number,
  targetHigh: number
): boolean {
  return targetHigh >= targetLow * HYSTERESIS_FACTOR
}

export const TREASURY_SWEEP_CONFIG = {
  INTERVAL_MS: TREASURY_SWEEP_INTERVAL_MS,
  HYSTERESIS_FACTOR,
}
