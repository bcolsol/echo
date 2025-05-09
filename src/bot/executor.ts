import {
  Keypair,
  VersionedTransaction,
  TransactionConfirmationStrategy,
} from "@solana/web3.js";
import { SolanaClient } from "../solana/client";
import { getJupiterQuote, getJupiterSwap } from "../jupiter/api";
import { DetectedTrade, TokenInfo } from "../types";
import {
  JUPITER_QUOTE_API_URL,
  JUPITER_SWAP_API_URL,
  TRADE_AMOUNT_LAMPORTS, // Used in constructor default
  COPY_TRADE_AMOUNT_SOL, // Used for logging
  SLIPPAGE_BPS,
  EXECUTE_TRADES,
  EXPLORER_URL,
  BOT_KEYPAIR,
  COMMITMENT_LEVEL,
  WSOL_MINT,
} from "../config";
import { logError, logInfo, logWarn, logDebug } from "../utils/logging";
import { shortenAddress } from "../utils/helpers";
import { StateManager } from "./stateManager";

// Define the non-null trade type for internal use after checks
type ValidTrade = Omit<DetectedTrade & { type: "buy" | "sell" }, "type"> & {
  type: "buy" | "sell";
};

// Define return types for execution/simulation methods
type ExecuteResult =
  | { success: true; signature: string }
  | { success: false; signature?: undefined };
type SimulateResult = { success: true } | { success: false };

/**
 * Handles the execution or simulation of a copy trade.
 * It fetches quotes and swap instructions from Jupiter, signs the transaction,
 * and then either sends it to the network or simulates it based on configuration.
 * Manages bot holdings using a StateManager.
 */
export class TradeExecutor {
  private readonly solanaClient: SolanaClient;
  private readonly botKeypair: Keypair;
  private readonly tradeAmountLamports: bigint; // Use bigint internally
  private readonly tradeAmountSol: number; // Store SOL amount for logging
  private readonly slippageBps: number;
  private readonly executeTrades: boolean;
  private readonly explorerUrl: string;
  private readonly jupiterQuoteApiUrl: string;
  private readonly jupiterSwapApiUrl: string;
  private readonly stateManager: StateManager;

  /**
   * Creates an instance of TradeExecutor.
   * @param solanaClient Instance of the SolanaClient.
   * @param botKeypair The Keypair for the bot's wallet.
   * @param tradeAmountLamports The amount of SOL (in lamports) to use for copy buys.
   * @param tradeAmountSol The amount of SOL (for logging buys).
   * @param slippageBps The slippage tolerance in basis points.
   * @param executeTrades Boolean flag indicating whether to execute trades or simulate.
   * @param explorerUrl Base URL for the Solana explorer.
   * @param jupiterQuoteApiUrl Jupiter Quote API endpoint.
   * @param jupiterSwapApiUrl Jupiter Swap API endpoint.
   * @param stateManager Instance of the StateManager.
   */
  constructor(
    solanaClient: SolanaClient,
    botKeypair: Keypair = BOT_KEYPAIR,
    tradeAmountLamports: number = TRADE_AMOUNT_LAMPORTS,
    tradeAmountSol: number = COPY_TRADE_AMOUNT_SOL,
    slippageBps: number = SLIPPAGE_BPS,
    executeTrades: boolean = EXECUTE_TRADES,
    explorerUrl: string = EXPLORER_URL,
    jupiterQuoteApiUrl: string = JUPITER_QUOTE_API_URL,
    jupiterSwapApiUrl: string = JUPITER_SWAP_API_URL,
    stateManager: StateManager
  ) {
    this.solanaClient = solanaClient;
    this.botKeypair = botKeypair;
    this.tradeAmountLamports = BigInt(tradeAmountLamports); // Convert to bigint internally
    this.tradeAmountSol = tradeAmountSol;
    this.slippageBps = slippageBps;
    this.executeTrades = executeTrades;
    this.explorerUrl = explorerUrl;
    this.jupiterQuoteApiUrl = jupiterQuoteApiUrl;
    this.jupiterSwapApiUrl = jupiterSwapApiUrl;
    this.stateManager = stateManager;
  }

  /**
   * Processes a detected trade (buy or sell).
   * Routes to specific buy/sell handlers.
   * @param detectedTrade The trade information detected by the analyzer (can be null).
   */
  async processTrade(detectedTrade: DetectedTrade): Promise<void> {
    if (!detectedTrade) {
      return; // Ignore null trades
    }

    const botWalletShort = shortenAddress(
      this.botKeypair.publicKey.toBase58(),
      6
    );

    if (detectedTrade.type === "buy") {
      await this.processBuyTrade(
        detectedTrade as ValidTrade & { type: "buy" },
        botWalletShort
      );
    } else if (detectedTrade.type === "sell") {
      await this.processSellTrade(
        detectedTrade as ValidTrade & { type: "sell" },
        botWalletShort
      );
    }
  }

  // --- Buy Logic ---
  private async processBuyTrade(
    tradeDetails: ValidTrade & { type: "buy" },
    botWalletShort: string
  ): Promise<void> {
    const { tokenInfo, tokenMint, originalTxSignature, monitoredWallet } =
      tradeDetails;

    logInfo(`\n--- ✅ BUY Detected [${monitoredWallet.toBase58()}] ---`);
    logInfo(` Original Tx: ${originalTxSignature}`);
    logInfo(
      ` Swapped: ~${tradeDetails.currencyAmount.toFixed(4)} ${
        tradeDetails.currencySymbol
      } -> ${tradeDetails.tokenAmount.toFixed(tokenInfo.decimals)} ${
        tokenInfo.symbol
      } (${tokenInfo.name})`
    );
    logInfo(` Token Mint: ${tokenMint}`);
    logInfo(`----------------------`);
    logInfo(
      `[${botWalletShort}] Preparing copy trade: Buy ${tokenInfo.symbol} (${tokenMint})`
    );
    logInfo(
      `          Mode: ${
        this.executeTrades ? "REAL EXECUTION" : "SIMULATION ONLY"
      }`
    );

    // --- 1. Get Jupiter Quote for Bot's Buy ---
    const quoteResponse = await getJupiterQuote(
      this.jupiterQuoteApiUrl,
      WSOL_MINT,
      tokenMint,
      this.tradeAmountLamports.toString(), // Use bot's configured buy amount
      this.slippageBps
    );

    if (!quoteResponse) {
      logError(
        `[${botWalletShort}] CRITICAL: Failed to get Jupiter quote for BUYING ${tokenInfo.symbol}. Aborting copy trade.`
      );
      return;
    }
    // Use BigInt for amount calculations
    const botExpectedOutAmount = BigInt(quoteResponse.outAmount);
    logInfo(
      `[${botWalletShort}] Received Jupiter quote (Bot expects ~${(
        Number(botExpectedOutAmount) /
        10 ** tokenInfo.decimals
      ) // Convert to number for display
        .toFixed(tokenInfo.decimals)} ${tokenInfo.symbol}).`
    );

    // --- 2. Get Jupiter Swap Instructions ---
    const swapResponse = await getJupiterSwap(
      this.jupiterSwapApiUrl,
      this.botKeypair.publicKey,
      quoteResponse
    );

    if (!swapResponse || !swapResponse.swapTransaction) {
      logError(
        `[${botWalletShort}] CRITICAL: Failed to get Jupiter swap instructions for BUYING ${tokenInfo.symbol}. Aborting copy trade.`
      );
      return;
    }
    logInfo(`[${botWalletShort}] Received Jupiter swap instructions for BUY.`);

    // --- 3. Process the Transaction ---
    let versionedTx: VersionedTransaction;
    try {
      const swapTransactionBuf = Buffer.from(
        swapResponse.swapTransaction,
        "base64"
      );
      versionedTx = VersionedTransaction.deserialize(swapTransactionBuf);
      versionedTx.sign([this.botKeypair]);
      logDebug(`[${botWalletShort}] BUY Swap transaction signed by bot.`);
    } catch (error: any) {
      logError(
        `[${botWalletShort}] CRITICAL: Error processing BUY transaction object for ${tokenInfo.symbol}:`,
        error.message ?? error
      );
      return;
    }

    // --- 4. Execute or Simulate ---
    let buySuccessResult: ExecuteResult | SimulateResult | null = null;
    if (this.executeTrades) {
      buySuccessResult = await this.executeRealTradeInternal(
        versionedTx,
        tokenInfo,
        "buy"
      );
    } else {
      buySuccessResult = await this.simulateTradeInternal(
        versionedTx,
        tokenInfo,
        "buy",
        this.tradeAmountSol
      );
      logInfo(
        `[${botWalletShort}] BUY execution/simulation result: ${JSON.stringify(
          buySuccessResult
        )}`
      );
    }

    // --- 5. Update Holdings on Successful Bot Buy ---
    if (buySuccessResult?.success && this.executeTrades) {
      const signature =
        (buySuccessResult as ExecuteResult).signature ?? "simulation";
      this.stateManager.addOrUpdateHolding(
        tokenMint,
        botExpectedOutAmount, // Use BigInt amount bot received
        signature,
        monitoredWallet.toBase58() // Store wallet address as string
      );
    } else {
      logWarn(
        `[${botWalletShort}] BUY execution/simulation failed for ${tokenInfo.symbol}. Holdings not updated.`
      );
    }
  }

  // --- Sell Logic ---
  private async processSellTrade(
    tradeDetails: ValidTrade & { type: "sell" },
    botWalletShort: string
  ): Promise<void> {
    const { tokenInfo, tokenMint, originalTxSignature, monitoredWallet } =
      tradeDetails;

    logInfo(`\n--- 🔻 SELL Detected [${monitoredWallet.toBase58()}] ---`);
    logInfo(` Original Tx: ${originalTxSignature}`);
    logInfo(` Token Mint: ${tokenMint} (${tokenInfo.symbol})`);
    logInfo(`-----------------------`);

    // --- 1. Check if Bot Holds This Token ---
    const holding = this.stateManager.getHolding(tokenMint);

    if (!holding) {
      logInfo(
        `[${botWalletShort}] Sell detected for ${tokenInfo.symbol}, but bot does not hold this token. Ignoring.`
      );
      return;
    }

    // Check if sell trigger matches last buy trigger
    // const monitoredWalletStr = monitoredWallet.toBase58();
    // if (holding.monitoredWallet !== monitoredWalletStr) { ... }
    // Skipping for now as we only update the last monitored wallet address in the state manager
    // TODO: Improve sell logic in the future

    const sellAmountToken =
      Number(holding.amountLamports) / 10 ** tokenInfo.decimals; // For logging
    logInfo(
      `[${botWalletShort}] Bot holds ${
        holding.amountLamports
      } lamports (${sellAmountToken.toFixed(tokenInfo.decimals)}) of ${
        tokenInfo.symbol
      }. Preparing to sell...`
    );
    logInfo(
      `Mode: ${this.executeTrades ? "REAL EXECUTION" : "SIMULATION ONLY"}`
    );

    // --- 2. Get Jupiter Quote for Bot's Sell ---
    const sellAmountLamportsStr = holding.amountLamports.toString();
    const quoteResponse = await getJupiterQuote(
      this.jupiterQuoteApiUrl,
      tokenMint, // Input is the token we hold
      WSOL_MINT, // Output is WSOL
      sellAmountLamportsStr,
      this.slippageBps
    );

    if (!quoteResponse) {
      logError(
        `[${botWalletShort}] CRITICAL: Failed to get Jupiter quote for SELLING ${tokenInfo.symbol}. Aborting sell.`
      );
      return;
    }
    const botExpectedOutAmountSOL =
      Number(BigInt(quoteResponse.outAmount)) / 10 ** 9; // WSOL decimals = 9
    logInfo(
      `[${botWalletShort}] Received Jupiter quote for sell (Bot expects ~${botExpectedOutAmountSOL.toFixed(
        9
      )} SOL).`
    );

    // --- 3. Get Jupiter Swap Instructions ---
    const swapResponse = await getJupiterSwap(
      this.jupiterSwapApiUrl,
      this.botKeypair.publicKey,
      quoteResponse
    );

    if (!swapResponse || !swapResponse.swapTransaction) {
      logError(
        `[${botWalletShort}] CRITICAL: Failed to get Jupiter swap instructions for SELLING ${tokenInfo.symbol}. Aborting sell.`
      );
      return;
    }
    logInfo(`[${botWalletShort}] Received Jupiter swap instructions for SELL.`);

    // --- 4. Process the Transaction ---
    let versionedTx: VersionedTransaction;
    try {
      const swapTransactionBuf = Buffer.from(
        swapResponse.swapTransaction,
        "base64"
      );
      versionedTx = VersionedTransaction.deserialize(swapTransactionBuf);
      versionedTx.sign([this.botKeypair]);
      logDebug(`[${botWalletShort}] SELL Swap transaction signed by bot.`);
    } catch (error: any) {
      logError(
        `[${botWalletShort}] CRITICAL: Error processing SELL transaction object for ${tokenInfo.symbol}:`,
        error.message ?? error
      );
      return;
    }

    // --- 5. Execute or Simulate ---
    let sellSuccessResult: ExecuteResult | SimulateResult | null = null;
    if (this.executeTrades) {
      sellSuccessResult = await this.executeRealTradeInternal(
        versionedTx,
        tokenInfo,
        "sell"
      );
    } else {
      sellSuccessResult = await this.simulateTradeInternal(
        versionedTx,
        tokenInfo,
        "sell",
        sellAmountToken
      );
      logInfo(
        `[${botWalletShort}] SELL execution/simulation result: ${JSON.stringify(
          sellSuccessResult
        )}`
      );
    }

    // --- 6. Update Holdings on Successful Bot Sell Only for real execution ---
    if (sellSuccessResult?.success && this.executeTrades) {
      this.stateManager.removeHolding(tokenMint);
    } else {
      logWarn(
        `[${botWalletShort}] SELL execution/simulation failed for ${tokenInfo.symbol}. Holdings not removed.`
      );
    }
  }

  /**
   * Internal method to execute a trade (buy or sell).
   * Sends the transaction to the network and waits for confirmation.
   * @param transaction The signed VersionedTransaction.
   * @param tokenInfo Information about the token being traded.
   * @param tradeType 'buy' or 'sell' for logging purposes.
   * @returns ExecuteResult indicating success/failure and signature.
   */
  private async executeRealTradeInternal(
    transaction: VersionedTransaction,
    tokenInfo: TokenInfo, // Use specific TokenInfo type
    tradeType: "buy" | "sell" // Add tradeType parameter
  ): Promise<ExecuteResult> {
    const botWalletShort = shortenAddress(
      this.botKeypair.publicKey.toBase58(),
      6
    );
    const typeUpper = tradeType.toUpperCase(); // For logging
    logInfo(
      `[${botWalletShort}] -------- REAL ${typeUpper} EXECUTION START --------`
    );
    let copyTradeTxId: string | undefined = undefined;

    try {
      const rawTransaction = transaction.serialize();
      copyTradeTxId = await this.solanaClient.sendRawTransaction(
        rawTransaction
      );
      logInfo(
        `[${botWalletShort}] 🚀 ${typeUpper} Copy Trade Sent! Sig: ${copyTradeTxId}`
      );
      logInfo(`-> Explorer: ${this.explorerUrl}/tx/${copyTradeTxId}`);
      logInfo(
        `[${botWalletShort}] ⏳ Waiting for confirmation ('${COMMITMENT_LEVEL.confirmation}')...`
      );

      const latestBlockhash = await this.solanaClient.getLatestBlockhash(
        COMMITMENT_LEVEL.confirmation
      );
      const confirmationStrategy: TransactionConfirmationStrategy = {
        signature: copyTradeTxId,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      };

      await this.solanaClient.confirmTransaction(
        confirmationStrategy,
        COMMITMENT_LEVEL.confirmation
      );
      logInfo(
        `[${botWalletShort}] ✅ ${typeUpper} Transaction Confirmed Successfully!`
      );
      // Return success status and signature
      return { success: true, signature: copyTradeTxId };
    } catch (execError: any) {
      logError(
        `[${botWalletShort}] CRITICAL: Error during real ${typeUpper} execution for ${tokenInfo.symbol}:`,
        execError.message ?? execError
      );
      if (execError instanceof Error) {
        if (
          execError.message.includes(
            "TransactionExpiredBlockheightExceededError"
          ) ||
          execError.message.includes("blockhash not found") ||
          execError.message.includes("confirmation failed")
        ) {
          logError(
            `          -> Diagnosis: Confirmation timed out or blockhash expired.`
          );
        } else if (execError.message.includes("insufficient lamports")) {
          logError(
            `          -> Diagnosis: Insufficient SOL in bot wallet for fees.`
          );
        }
      }
      if (copyTradeTxId) {
        logError(
          `          -> Check Tx Status Manually: ${this.explorerUrl}/tx/${copyTradeTxId}`
        );
      }
      // Return failure status
      return { success: false };
    } finally {
      logInfo(
        `[${botWalletShort}] -------- REAL ${typeUpper} EXECUTION END --------`
      );
    }
  }

  /**
   * Internal method to simulate a trade (buy or sell).
   * @param transaction The signed VersionedTransaction.
   * @param tokenInfo Information about the token being traded.
   * @param tradeType 'buy' or 'sell' for logging purposes.
   * @param amount The amount being bought (SOL) or sold (Token) for logging.
   * @returns SimulateResult indicating success/failure.
   */
  private async simulateTradeInternal(
    transaction: VersionedTransaction,
    tokenInfo: TokenInfo, // Use specific TokenInfo type
    tradeType: "buy" | "sell", // Add tradeType parameter
    amount: number // Add amount parameter for logging
  ): Promise<SimulateResult> {
    const botWalletShort = shortenAddress(
      this.botKeypair.publicKey.toBase58(),
      6
    );
    const typeUpper = tradeType.toUpperCase(); // For logging
    logInfo(
      `[${botWalletShort}] -------- ${typeUpper} SIMULATION START --------`
    );

    const direction =
      tradeType === "buy"
        ? `SOL -> ${tokenInfo.symbol}`
        : `${tokenInfo.symbol} -> SOL`;
    const amountSymbol = tradeType === "buy" ? "SOL" : tokenInfo.symbol;
    logInfo(
      `[${botWalletShort}] Simulating ${typeUpper} trade: ${amount.toFixed(
        4
      )} ${amountSymbol} (${direction})`
    );

    try {
      const lookupTableAccounts =
        await this.solanaClient.getNeededLookupTableAccounts(
          transaction.message
        );

      // Pass undefined for accounts config if no ALTs are needed
      const simConfig = {
        commitment: COMMITMENT_LEVEL.confirmation,
        replaceRecentBlockhash: true,
        sigVerify: false,
        accounts:
          lookupTableAccounts.length > 0
            ? {
                encoding: "base64" as const,

                addresses: transaction.message
                  .getAccountKeys({
                    addressLookupTableAccounts: lookupTableAccounts,
                  })
                  .staticAccountKeys.map((k) => k.toBase58()),
              }
            : undefined,
      };

      const simulationResult =
        await this.solanaClient.simulateVersionedTransaction(
          transaction,
          simConfig // Pass potentially undefined accounts config
        );

      if (simulationResult.value.err) {
        logError(`[${botWalletShort}] ❌ ${typeUpper} SIMULATION FAILED!`);
        logError(
          `          -> Error:`,
          JSON.stringify(simulationResult.value.err)
        );
        const errStr = JSON.stringify(simulationResult.value.err);
        if (
          errStr.includes("AccountNotFound") ||
          errStr.includes("AccountInUse")
        ) {
          logError(
            "          -> Diagnosis: Often means missing pool/ATA, ALT resolution failure, insufficient rent/fees, or account omitted. Check ALTs/Jupiter details."
          );
        } else if (errStr.includes("InstructionError")) {
          logError(
            "          -> Diagnosis: Error within the program's execution. Check program logs below."
          );
        } else if (errStr.includes("InsufficientFundsForRent")) {
          logError(
            "          -> Diagnosis: An account needs more SOL for rent exemption."
          );
        }

        if (simulationResult.value.logs?.length) {
          logWarn(`          -> Simulation Logs:`);
          simulationResult.value.logs.forEach((log) =>
            logWarn(`             | ${log}`)
          );
        } else {
          logWarn(`          -> No simulation logs available.`);
        }
        // Return failure status
        return { success: false };
      } else {
        logInfo(`[${botWalletShort}] ✅ ${typeUpper} SIMULATION SUCCEEDED!`);
        logInfo(
          `          -> Compute Units Consumed: ${
            simulationResult.value.unitsConsumed ?? "N/A"
          }`
        );
        if (simulationResult.value.logs?.length) {
          logDebug(`          -> Simulation Logs (Success):`);
          simulationResult.value.logs.forEach((log) =>
            logDebug(`             | ${log}`)
          );
        }
        // Return success status
        return { success: true };
      }
    } catch (simError: any) {
      logError(
        `[${botWalletShort}] CRITICAL: Error calling simulation API for ${typeUpper} ${tokenInfo.symbol}:`,
        simError.message ?? simError
      );
      if (simError instanceof Error) {
        if (simError.message.includes("AccountNotFound")) {
          logError(
            "          -> Diagnosis: API call failed with AccountNotFound. Check ALTs, accounts involved, RPC health."
          );
        } else if (simError.message.includes("insufficient lamports")) {
          logError(
            `          -> Diagnosis: Insufficient SOL in bot wallet (${this.botKeypair.publicKey.toBase58()}) for simulation fees.`
          );
        } else if (simError.message.includes("Node is behind")) {
          logError(`          -> Diagnosis: RPC node might be lagging.`);
        } else if (simError.message.includes("Blockhash not found")) {
          logError(
            "          -> Diagnosis: Simulation failed due to expired blockhash. Should be less common with replaceRecentBlockhash=true."
          );
        } else if (simError.message.includes("Failed to fetch")) {
          logError(
            "          -> Diagnosis: RPC failed to fetch account/ALT. Check RPC health/limits."
          );
        }
      }
      // Return failure status
      return { success: false };
    } finally {
      logInfo(
        `[${botWalletShort}] -------- ${typeUpper} SIMULATION END --------`
      );
    }
  }
}
