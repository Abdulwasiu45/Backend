/**
 * WhatsApp message handler.
 *
 * Entry point: handleWhatsAppMessage(from, message). For each inbound message
 * it:
 *   1. normalizes the sender's phone number and finds/creates their user;
 *   2. if the user is not yet verified, runs the OTP flow (send or check a
 *      6-digit code) and stops there;
 *   3. otherwise parses the message into an intent (balance, deposit,
 *      withdraw, earnings, help) and returns the matching reply.
 *
 * The small format* helpers below only build reply text; all state changes go
 * through the functions imported from ./userManager.
 */

import { parseIntent } from '../nlp/parser'
import {
  normalizePhone,
  createOrGetUser,
  generateOtp,
  verifyOtp,
  getBalance,
  getUserWalletAddress,
  getPortfolioYieldSummary,
  decrementBalance,
} from './userManager'

/** What the webhook sends back to the user: a single plain-text message. */
export type WhatsAppResponse = {
  body: string
}

/** Command menu shown on /help, after verification, and on unrecognised input. */
function formatHelpMessage(): string {
  return [
    'Welcome to NeuroWealth! Here are some things you can ask me:',
    '- "balance" → check your wallet balance',
    '- "deposit <amount>" → get deposit instructions',
    '- "withdraw <amount>" → withdraw funds (if available)',
    '- "earnings" → see your performance',
    '- "help" → show this message again',
  ].join('\n')
}

/** Message carrying the one-time code sent to unverified users. */
function formatOtpMessage(code: string): string {
  return `Welcome to NeuroWealth! Your verification code is: ${code}\n\nReply with the 6-digit code to activate your account.`
}

/** Balance in XLM (2 decimal places) plus the user's wallet address. */
function formatBalanceMessage(balance: number, address: string): string {
  return `Your current balance is ${balance.toFixed(2)} XLM.\nWallet: ${address}`
}

/** Tells the user where to send funds; the deposit itself happens on-chain. */
function formatDepositInstruction(amount: number, address: string): string {
  return `To deposit, send ${amount.toFixed(2)} XLM to your wallet address:\n${address}\n\nOnce the transaction is confirmed, reply "balance" to see your updated balance.`
}

/** Acknowledges a withdrawal and shows the balance that will result from it. */
function formatWithdrawConfirmation(
  amount: number,
  newBalance: number
): string {
  return `Withdrawal request received for ${amount.toFixed(2)} XLM.\nYour new balance will be ${newBalance.toFixed(2)} XLM once processed.`
}

/** Shown when a withdrawal request exceeds the available balance. */
function formatInsufficientFunds(balance: number, requested: number): string {
  return `You only have ${balance.toFixed(2)} XLM available, but you requested ${requested.toFixed(2)} XLM.\nTry a smaller amount or deposit more funds.`
}

/**
 * Earnings summary in plain text. `averageApy` is a fraction (0.05) and is
 * shown as a percentage. The "30 days" wording is fixed, so `periodEarnings`
 * is expected to be the 30-day figure.
 */
function formatEarnings(input: {
  totalBalance: number
  totalEarnings: number
  periodEarnings: number
  averageApy: number
}): string {
  return [
    `Your portfolio balance is ${input.totalBalance.toFixed(2)} XLM equivalent.`,
    `Total earnings to date: ${input.totalEarnings.toFixed(2)} XLM.`,
    `Earnings over the last 30 days: ${input.periodEarnings.toFixed(2)} XLM.`,
    `Average APY across your tracked positions: ${(input.averageApy * 100).toFixed(2)}%.`,
  ].join('\n')
}

/** Fallback reply: apologise, then show the help menu so the user can retry. */
function formatUnknownMessage(): string {
  return `Sorry, I didn't understand that.\n${formatHelpMessage()}`
}

/**
 * Find a 6-digit code anywhere in the message, e.g. "my code is 123456".
 * `\b` word boundaries mean a longer digit run (like a 7+ digit number) will
 * not match. Returns null if no code is found.
 */
function extractOtpCode(message: string): string | null {
  const match = message.match(/\b(\d{6})\b/)
  return match ? match[1] : null
}

/**
 * Handle one inbound WhatsApp message and produce the reply to send back.
 *
 * @param from    Sender's phone number as provided by WhatsApp (normalized
 *                before use so the same person always maps to one user).
 * @param message Raw text the user sent.
 */
export async function handleWhatsAppMessage(
  from: string,
  message: string
): Promise<WhatsAppResponse> {
  const normalizedPhone = normalizePhone(from)
  // First contact creates the user; later contacts return the existing one.
  const user = await createOrGetUser(normalizedPhone)

  // --- Verification gate ----------------------------------------------------
  // Unverified users can't use any commands; the only things they can do are
  // submit an OTP or be sent a new one.

  // If user is not verified, treat any 6-digit code as an OTP attempt.
  if (!user.verified) {
    const codeFromMessage = extractOtpCode(message)
    if (codeFromMessage) {
      const success = verifyOtp(normalizedPhone, codeFromMessage)
      if (success) {
        // Verified: show the wallet address and the command menu.
        const wallet = getUserWalletAddress(normalizedPhone)
        return {
          body: `✅ Your account is now verified!\nYour wallet address is: ${wallet}\n\n${formatHelpMessage()}`,
        }
      }

      // Wrong or expired code. No new code is sent in this branch; the user
      // gets one the next time they send a message without a 6-digit number.
      return {
        body: 'Invalid or expired OTP. Please request a new code by sending any message.',
      }
    }

    // Send OTP for new user or re-send if not verified
    // (each non-code message from an unverified user generates a fresh code)
    const otp = generateOtp(normalizedPhone)
    return { body: formatOtpMessage(otp) }
  }

  // --- Verified users: interpret the message and act on it -------------------
  const intent = await parseIntent(message)

  switch (intent.action) {
    case 'balance': {
      // Fall back to safe defaults rather than failing if data is missing.
      const balance = getBalance(normalizedPhone) ?? 0
      const address = getUserWalletAddress(normalizedPhone) ?? 'unknown'
      return { body: formatBalanceMessage(balance, address) }
    }

    case 'deposit': {
      // Deposits are on-chain: we only validate the amount and tell the user
      // where to send funds. No balance is changed here.
      const amount = intent.amount
      if (!amount || amount <= 0) {
        return { body: 'Please specify a deposit amount, e.g. "deposit 10".' }
      }
      const address = getUserWalletAddress(normalizedPhone)
      return { body: formatDepositInstruction(amount, address ?? 'unknown') }
    }

    case 'withdraw': {
      const balance = getBalance(normalizedPhone) ?? 0
      // "withdraw all" uses the full balance; otherwise the parsed amount.
      // (With a zero balance, "withdraw all" falls into the "specify an
      // amount" reply below because the amount is 0.)
      const amount = intent.all ? balance : intent.amount
      if (!amount || amount <= 0) {
        return {
          body: 'Please specify a withdrawal amount, e.g. "withdraw 5" or "withdraw all".',
        }
      }
      if (amount > balance) {
        return { body: formatInsufficientFunds(balance, amount) }
      }
      // The balance is reduced immediately, and the reply says the request
      // is "received" with the new balance applying "once processed".
      const newBalance = decrementBalance(normalizedPhone, amount)
      return { body: formatWithdrawConfirmation(amount, newBalance) }
    }

    case 'help':
      return { body: formatHelpMessage() }

    case 'earnings': {
      // May be null when the user has no tracked portfolio data yet.
      const summary = await getPortfolioYieldSummary(normalizedPhone)
      if (!summary) {
        return {
          body: 'I could not find any tracked portfolio data for your account yet.',
        }
      }

      return { body: formatEarnings(summary) }
    }

    // 'unknown' and any action the parser might add later land here, so the
    // user always gets a reply instead of silence.
    case 'unknown':
    default:
      return { body: formatUnknownMessage() }
  }
}
