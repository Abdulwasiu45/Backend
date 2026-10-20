/**
 * Chat reply formatters.
 *
 * Each function is a pure formatter: it takes already-fetched data and
 * returns a single multi-line string ready to send as a chat message. No I/O
 * happens here.
 *
 * Formatting conventions used throughout:
 *  - `*text*` renders as bold and `_text_` as italic (Markdown-style chat
 *    syntax, as used by messengers such as Telegram/WhatsApp).
 *  - Each reply is built as an array of lines joined with '\n'.
 *  - Lists are capped (3-5 items) so replies stay short enough for chat.
 *  - Money is shown to 2 decimal places; APY values arrive as fractions
 *    (0.05) and are shown as percentages (5.00%).
 */

// Minimal view of a user's position in a protocol; only what the reply needs.
type PositionSummary = {
  protocolName: string
  assetSymbol: string
  currentValue: number
}

// Minimal view of a transaction. `txHash` is null until the transaction has
// been submitted on-chain, which the formatters display as "pending".
type TxSummary = {
  txHash: string | null
  type: string
  status: string
  amount: number
  assetSymbol: string
}

// Minimal view of a protocol's current supply rate. `supplyApy` is a
// fraction (0.05 = 5%).
type ProtocolRateSummary = {
  protocolName: string
  assetSymbol: string
  supplyApy: number
}

/**
 * Portfolio snapshot: totals plus up to the first 3 positions.
 * Positions are shown in the order given, so callers should sort them
 * (e.g. by value) beforehand if they want the largest ones first.
 */
export function formatPortfolioReply(input: {
  totalBalance: number
  totalEarnings: number
  activePositions: number
  positions: PositionSummary[]
}): string {
  // Cap at 3 positions to keep the message short.
  const lines = input.positions.slice(0, 3).map((position) => {
    return `• ${position.protocolName} ${position.assetSymbol}: $${position.currentValue.toFixed(2)}`
  })

  return [
    '💼 *Portfolio Snapshot*',
    `Balance: *$${input.totalBalance.toFixed(2)}*`,
    `Earnings: *$${input.totalEarnings.toFixed(2)}*`,
    `Active positions: *${input.activePositions}*`,
    // Fall back to a friendly empty-state line when there is nothing to list.
    lines.length ? lines.join('\n') : 'No active positions yet.',
  ].join('\n')
}

/**
 * Yield history for a chosen period, showing only the first 5 data points.
 * Points are displayed in the order given, so callers decide whether that is
 * oldest-first or newest-first.
 */
export function formatPortfolioHistoryReply(input: {
  period: '7d' | '30d' | '90d'
  points: Array<{ date: string; yieldAmount: number }>
}): string {
  const lines = input.points.slice(0, 5).map((point) => {
    // The "+" prefix is hardcoded, so a negative yieldAmount would render
    // as "+$-1.23".
    return `• ${point.date}: +$${point.yieldAmount.toFixed(2)}`
  })

  return [
    `📈 *History (${input.period})*`,
    lines.length ? lines.join('\n') : 'No history available for this period.',
  ].join('\n')
}

/**
 * Earnings summary: lifetime total, recent-period total, and average APY.
 * `averageApy` is a fraction and is converted to a percentage here.
 */
export function formatPortfolioEarningsReply(input: {
  totalEarnings: number
  averageApy: number
  periodEarnings: number
}): string {
  return [
    '🧾 *Earnings Summary*',
    `Total earned: *$${input.totalEarnings.toFixed(2)}*`,
    // The label is fixed at "30d", so callers must pass 30-day earnings here.
    `30d earnings: *$${input.periodEarnings.toFixed(2)}*`,
    `Average APY: *${(input.averageApy * 100).toFixed(2)}%*`,
  ].join('\n')
}

/**
 * One page of the transaction list. The caller is expected to have already
 * paginated the data; this function only formats what it is given and does
 * not slice by `limit` (the limit is just echoed in the header).
 */
export function formatTransactionsReply(input: {
  page: number
  limit: number
  transactions: TxSummary[]
}): string {
  const lines = input.transactions.map((tx) => {
    // Show a shortened hash (first 8 chars) to keep lines compact, or
    // "pending" if the transaction has no on-chain hash yet.
    const hash = tx.txHash ? `${tx.txHash.slice(0, 8)}...` : 'pending'
    return `• ${tx.type} ${tx.amount} ${tx.assetSymbol} (${tx.status}) [${hash}]`
  })

  return [
    `📜 *Transactions* (page ${input.page}, showing ${input.limit})`,
    lines.length ? lines.join('\n') : 'No transactions found.',
  ].join('\n')
}

/**
 * Full detail for a single transaction. Unlike the list view, this shows the
 * complete hash (italicised so it is easy to spot and copy).
 */
export function formatTransactionDetailReply(input: TxSummary): string {
  return [
    '🔎 *Transaction Detail*',
    `Type: *${input.type}*`,
    `Status: *${input.status}*`,
    `Amount: *${input.amount} ${input.assetSymbol}*`,
    // `||` (not `??`) so an empty-string hash also falls back to "pending".
    `Hash: _${input.txHash || 'pending'}_`,
  ].join('\n')
}

/**
 * Current supply APYs, showing the first 5 rates. Rates are shown in the
 * order given, so callers should sort best-first if that is the intent.
 */
export function formatProtocolRatesReply(input: {
  rates: ProtocolRateSummary[]
}): string {
  const lines = input.rates.slice(0, 5).map((rate) => {
    return `• ${rate.protocolName} ${rate.assetSymbol}: *${(rate.supplyApy * 100).toFixed(2)}% APY*`
  })

  // Unlike the other list formatters, there is no empty-state message here:
  // with no rates, the reply is just the header followed by a blank line.
  return ['🏦 *Protocol Rates*', lines.join('\n')].join('\n')
}

/**
 * Latest status of the automated agent: its most recent action, its current
 * state, and when it was last updated. `updatedAt` is displayed as given, so
 * pass an already human-readable string.
 */
export function formatAgentStatusReply(input: {
  status: string
  action: string
  updatedAt: string
}): string {
  return [
    '🤖 *Agent Status*',
    `Latest action: *${input.action}*`,
    `State: *${input.status}*`,
    `Updated: _${input.updatedAt}_`,
  ].join('\n')
}

/**
 * Confirmation sent after a deposit has been accepted into the queue (not
 * yet settled on-chain). If no protocol was chosen, it is shown as "Auto",
 * meaning the system picks one.
 */
export function formatDepositReply(input: {
  amount: number
  assetSymbol: string
  protocolName?: string | null
}): string {
  return [
    '✅ *Deposit queued*',
    `Amount: *${input.amount} ${input.assetSymbol}*`,
    // Covers both undefined and null (and empty string) -> "Auto".
    `Protocol: *${input.protocolName || 'Auto'}*`,
    '_Your transaction is being processed._',
  ].join('\n')
}

/**
 * Confirmation sent after a withdrawal has been accepted into the queue.
 * Mirrors formatDepositReply; the closing line tells the user a follow-up
 * message will arrive once it settles.
 */
export function formatWithdrawReply(input: {
  amount: number
  assetSymbol: string
  protocolName?: string | null
}): string {
  return [
    '💸 *Withdrawal queued*',
    `Amount: *${input.amount} ${input.assetSymbol}*`,
    `Protocol: *${input.protocolName || 'Auto'}*`,
    '_You will receive a confirmation once settled._',
  ].join('\n')
}
