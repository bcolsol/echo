import {
  Keypair,
  VersionedTransaction,
  TransactionConfirmationStrategy,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { SolanaClient } from "../solana/client";
import { getJupiterQuote, getJupiterSwap } from "../jupiter/api";
import { DetectedTrade, TokenInfo } from "../types"; // Added JupiterQuoteResponse
import {
  WSOL_MINT,
  MANAGE_WITH_SLTP,
  TAKE_PROFIT_PERCENTAGE,
  STOP_LOSS_PERCENTAGE,
} from "../config";
import { logError, logInfo, logWarn, logDebug } from "../utils/logging";
import { shortenAddress } from "../utils/helpers";
import { StateManager, BotHolding } from "./stateManager";

type ValidTrade = Omit<DetectedTrade & { type: "buy" | "sell" }, "type"> & {
  type: "buy" | "sell";
};

type ExecuteResult =
  | { success: true; signature: string }
  | { success: false; signature?: undefined };
type SimulateResult = { success: true } | { success: false };

export class TradeExecutor {
  private readonly solanaClient: SolanaClient;
  private readonly botKeypair: Keypair;
  private readonly tradeAmountLamports: bigint;
  private readonly tradeAmountSol: number;
  private readonly slippageBps: number;
  private readonly executeTrades: boolean;
  private readonly explorerUrl: string;
  private readonly jupiterQuoteApiUrl: string;
  private readonly jupiterSwapApiUrl: string;
  private readonly stateManager: StateManager;

  constructor(
    solanaClient: SolanaClient,
    botKeypair: Keypair,
    tradeAmountLamports: number,
    tradeAmountSol: number,
    slippageBps: number,
    executeTrades: boolean,
    explorerUrl: string,
    jupiterQuoteApiUrl: string,
    jupiterSwapApiUrl: string,
    stateManager: StateManager
  ) {
    this.solanaClient = solanaClient;
    this.botKeypair = botKeypair;
    this.tradeAmountLamports = BigInt(tradeAmountLamports);
    this.tradeAmountSol = tradeAmountSol;
    this.slippageBps = slippageBps;
    this.executeTrades = executeTrades;
    this.explorerUrl = explorerUrl;
    this.jupiterQuoteApiUrl = jupiterQuoteApiUrl;
    this.jupiterSwapApiUrl = jupiterSwapApiUrl;
    this.stateManager = stateManager;

    // Log the SL/TP mode being used by the executor
    logInfo(`[TradeExecutor] MANAGE_WITH_SLTP: ${MANAGE_WITH_SLTP}`);
    if (MANAGE_WITH_SLTP) {
      logInfo(
        `[TradeExecutor] TP: ${TAKE_PROFIT_PERCENTAGE}%, SL: ${STOP_LOSS_PERCENTAGE}%`
      );
    }
  }

  async processTrade(detectedTrade: DetectedTrade): Promise<void> {
    if (!detectedTrade) {
      return;
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
      // If SL/TP is active, copy-sells are conditional
      if (MANAGE_WITH_SLTP) {
        const holding = this.stateManager.getHolding(detectedTrade.tokenMint);
        // If holding exists and has purchase price, it's managed by SL/TP, so ignore copy-sell.
        if (
          holding?.avgPurchasePriceInSol !== undefined &&
          holding?.tokenDecimals !== undefined
        ) {
          logInfo(
            `[${botWalletShort}] Sell detected for ${detectedTrade.tokenInfo.symbol} by monitored wallet, but bot is managing this token with SL/TP. Ignoring copy-sell.`
          );
          return;
        }
      }
      // Proceed with copy-sell if not managed by SL/TP or if SL/TP is disabled
      await this.processSellTrade(
        detectedTrade as ValidTrade & { type: "sell" },
        botWalletShort
      );
    }
  }

  private async processBuyTrade(
    tradeDetails: ValidTrade & { type: "buy" },
    botWalletShort: string
  ): Promise<void> {
    const { tokenInfo, tokenMint, originalTxSignature, monitoredWallet } =
      tradeDetails;

    logInfo(
      `\n--- ✅ BUY Detected [${shortenAddress(
        monitoredWallet.toBase58()
      )}] ---`
    );
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

    const quoteResponse = await getJupiterQuote(
      this.jupiterQuoteApiUrl,
      WSOL_MINT, // Bot always buys with SOL (which Jupiter wraps to WSOL)
      tokenMint,
      this.tradeAmountLamports.toString(), // Bot's configured SOL amount for buy
      this.slippageBps
    );

    if (!quoteResponse) {
      logError(
        `[${botWalletShort}] CRITICAL: Failed to get Jupiter quote for BUYING ${tokenInfo.symbol}. Aborting copy trade.`
      );
      return;
    }

    const botExpectedTokensLamports = BigInt(quoteResponse.outAmount);
    const botSolCostLamports = BigInt(quoteResponse.inAmount); // Actual SOL cost for the quoted amount

    logInfo(
      `[${botWalletShort}] Received Jupiter quote: Spend ~${(
        Number(botSolCostLamports) / LAMPORTS_PER_SOL
      ).toFixed(6)} SOL to get ~${(
        Number(botExpectedTokensLamports) /
        10 ** tokenInfo.decimals
      ).toFixed(tokenInfo.decimals)} ${tokenInfo.symbol}.`
    );

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
        this.tradeAmountSol // Logged amount for simulation
      );
    }
    logInfo(
      `[${botWalletShort}] BUY execution/simulation result: ${JSON.stringify(
        buySuccessResult
      )}`
    );

    if (buySuccessResult?.success && this.executeTrades) {
      const signature =
        (buySuccessResult as ExecuteResult).signature ?? "simulation_error";
      this.stateManager.addOrUpdateHolding(
        tokenMint,
        botExpectedTokensLamports, // Actual amount of tokens the bot expects to receive
        botSolCostLamports, // Actual amount of SOL the bot expects to spend
        signature,
        monitoredWallet.toBase58(),
        tokenInfo.decimals,
        MANAGE_WITH_SLTP // Pass the global config
      );
    } else if (!buySuccessResult?.success) {
      // Check for explicit failure
      logWarn(
        `[${botWalletShort}] BUY execution/simulation failed for ${tokenInfo.symbol}. Holdings not updated.`
      );
    }
  }

  private async processSellTrade(
    tradeDetails: ValidTrade & { type: "sell" },
    botWalletShort: string
  ): Promise<void> {
    const { tokenInfo, tokenMint, originalTxSignature, monitoredWallet } =
      tradeDetails;

    logInfo(
      `\n--- 🔻 COPY-SELL Detected [${shortenAddress(
        monitoredWallet.toBase58()
      )}] ---`
    );
    logInfo(` Original Tx: ${originalTxSignature}`);
    logInfo(` Token Mint: ${tokenMint} (${tokenInfo.symbol})`);
    logInfo(`-----------------------`);

    const holding = this.stateManager.getHolding(tokenMint);
    if (!holding) {
      logInfo(
        `[${botWalletShort}] Monitored wallet sold ${tokenInfo.symbol}, but bot does not hold this token. Ignoring copy-sell.`
      );
      return;
    }

    // Additional check: if MANAGE_WITH_SLTP is true, this path should ideally not be hit
    // for SLTP-managed tokens due to the check in processTrade. This is a safeguard.
    if (MANAGE_WITH_SLTP && holding.avgPurchasePriceInSol !== undefined) {
      logWarn(
        `[${botWalletShort}] Attempted to copy-sell ${tokenInfo.symbol}, but it's under SL/TP. This should have been filtered earlier. Ignoring.`
      );
      return;
    }

    const sellAmountTokenLamports = holding.amountLamports;
    const sellAmountTokenDisplay =
      Number(sellAmountTokenLamports) / 10 ** tokenInfo.decimals;

    logInfo(
      `[${botWalletShort}] Bot holds ${sellAmountTokenDisplay.toFixed(
        tokenInfo.decimals
      )} ${tokenInfo.symbol}. Preparing to COPY-SELL...`
    );
    logInfo(
      `Mode: ${this.executeTrades ? "REAL EXECUTION" : "SIMULATION ONLY"}`
    );

    const quoteResponse = await getJupiterQuote(
      this.jupiterQuoteApiUrl,
      tokenMint,
      WSOL_MINT,
      sellAmountTokenLamports.toString(),
      this.slippageBps
    );

    if (!quoteResponse) {
      logError(
        `[${botWalletShort}] CRITICAL: Failed to get Jupiter quote for COPY-SELLING ${tokenInfo.symbol}. Aborting.`
      );
      return;
    }
    const botExpectedSolLamports = BigInt(quoteResponse.outAmount);
    logInfo(
      `[${botWalletShort}] Received Jupiter quote for copy-sell (Bot expects ~${(
        Number(botExpectedSolLamports) / LAMPORTS_PER_SOL
      ).toFixed(9)} SOL).`
    );

    const swapResponse = await getJupiterSwap(
      this.jupiterSwapApiUrl,
      this.botKeypair.publicKey,
      quoteResponse
    );

    if (!swapResponse || !swapResponse.swapTransaction) {
      logError(
        `[${botWalletShort}] CRITICAL: Failed to get Jupiter swap instructions for COPY-SELLING ${tokenInfo.symbol}. Aborting.`
      );
      return;
    }
    logInfo(
      `[${botWalletShort}] Received Jupiter swap instructions for COPY-SELL.`
    );

    let versionedTx: VersionedTransaction;
    try {
      const swapTransactionBuf = Buffer.from(
        swapResponse.swapTransaction,
        "base64"
      );
      versionedTx = VersionedTransaction.deserialize(swapTransactionBuf);
      versionedTx.sign([this.botKeypair]);
      logDebug(`[${botWalletShort}] COPY-SELL Swap transaction signed by bot.`);
    } catch (error: any) {
      logError(
        `[${botWalletShort}] CRITICAL: Error processing COPY-SELL transaction object for ${tokenInfo.symbol}:`,
        error.message ?? error
      );
      return;
    }

    let sellSuccessResult: ExecuteResult | SimulateResult | null = null;
    if (this.executeTrades) {
      sellSuccessResult = await this.executeRealTradeInternal(
        versionedTx,
        tokenInfo,
        "sell (copy)"
      );
    } else {
      sellSuccessResult = await this.simulateTradeInternal(
        versionedTx,
        tokenInfo,
        "sell (copy)",
        sellAmountTokenDisplay
      );
    }
    logInfo(
      // Moved logging outside
      `[${botWalletShort}] COPY-SELL execution/simulation result: ${JSON.stringify(
        sellSuccessResult
      )}`
    );

    if (sellSuccessResult?.success && this.executeTrades) {
      this.stateManager.removeHolding(tokenMint);
    } else if (!sellSuccessResult?.success) {
      logWarn(
        `[${botWalletShort}] COPY-SELL execution/simulation failed for ${tokenInfo.symbol}. Holdings not removed.`
      );
    }
  }

  /**
   * Executes a sell based on Stop-Loss or Take-Profit.
   */
  public async executeSlTpSell(
    tokenMint: string,
    holding: BotHolding, // Pass the current holding data
    tokenInfo: TokenInfo,
    reason: "SL" | "TP"
  ): Promise<void> {
    const botWalletShort = shortenAddress(
      this.botKeypair.publicKey.toBase58(),
      6
    );
    const reasonFull = reason === "SL" ? "Stop-Loss" : "Take-Profit";

    logInfo(
      `\n--- 📈 SL/TP Triggered: ${reasonFull} for ${tokenInfo.symbol} (${tokenMint}) ---`
    );
    const sellAmountTokenLamports = holding.amountLamports;
    const sellAmountTokenDisplay =
      Number(sellAmountTokenLamports) /
      10 ** (holding.tokenDecimals || tokenInfo.decimals);

    logInfo(
      `[${botWalletShort}] Bot holds ${sellAmountTokenDisplay.toFixed(
        holding.tokenDecimals || tokenInfo.decimals
      )} ${tokenInfo.symbol}. Preparing ${reasonFull} sell...`
    );
    logInfo(
      `          Mode: ${
        this.executeTrades ? "REAL EXECUTION" : "SIMULATION ONLY"
      }`
    );

    const quoteResponse = await getJupiterQuote(
      this.jupiterQuoteApiUrl,
      tokenMint,
      WSOL_MINT,
      sellAmountTokenLamports.toString(),
      this.slippageBps
    );

    if (!quoteResponse) {
      logError(
        `[${botWalletShort}] CRITICAL: Failed to get Jupiter quote for ${reasonFull} SELLING ${tokenInfo.symbol}. Aborting.`
      );
      return;
    }
    const botExpectedSolLamports = BigInt(quoteResponse.outAmount);
    logInfo(
      `[${botWalletShort}] Received Jupiter quote for ${reasonFull} sell (Bot expects ~${(
        Number(botExpectedSolLamports) / LAMPORTS_PER_SOL
      ).toFixed(9)} SOL).`
    );

    const swapResponse = await getJupiterSwap(
      this.jupiterSwapApiUrl,
      this.botKeypair.publicKey,
      quoteResponse
    );

    if (!swapResponse || !swapResponse.swapTransaction) {
      logError(
        `[${botWalletShort}] CRITICAL: Failed to get Jupiter swap instructions for ${reasonFull} SELLING ${tokenInfo.symbol}. Aborting.`
      );
      return;
    }
    logInfo(
      `[${botWalletShort}] Received Jupiter swap instructions for ${reasonFull} SELL.`
    );

    let versionedTx: VersionedTransaction;
    try {
      const swapTransactionBuf = Buffer.from(
        swapResponse.swapTransaction,
        "base64"
      );
      versionedTx = VersionedTransaction.deserialize(swapTransactionBuf);
      versionedTx.sign([this.botKeypair]);
      logDebug(
        `[${botWalletShort}] ${reasonFull} SELL Swap transaction signed by bot.`
      );
    } catch (error: any) {
      logError(
        `[${botWalletShort}] CRITICAL: Error processing ${reasonFull} SELL transaction object for ${tokenInfo.symbol}:`,
        error.message ?? error
      );
      return;
    }

    let sellSuccessResult: ExecuteResult | SimulateResult | null = null;
    if (this.executeTrades) {
      sellSuccessResult = await this.executeRealTradeInternal(
        versionedTx,
        tokenInfo,
        `sell (${reason})`
      );
    } else {
      sellSuccessResult = await this.simulateTradeInternal(
        versionedTx,
        tokenInfo,
        `sell (${reason})`,
        sellAmountTokenDisplay
      );
    }
    logInfo(
      // Moved logging outside
      `[${botWalletShort}] ${reasonFull} SELL execution/simulation result: ${JSON.stringify(
        sellSuccessResult
      )}`
    );

    if (sellSuccessResult?.success && this.executeTrades) {
      this.stateManager.removeHolding(tokenMint);
      logInfo(
        `[${botWalletShort}] ${reasonFull} successful for ${tokenInfo.symbol}. Holding removed.`
      );
    } else if (!sellSuccessResult?.success) {
      logWarn(
        `[${botWalletShort}] ${reasonFull} SELL execution/simulation failed for ${tokenInfo.symbol}. Holdings not removed.`
      );
    }
  }

  private async executeRealTradeInternal(
    transaction: VersionedTransaction,
    tokenInfo: TokenInfo,
    tradeTypeContext: string
  ): Promise<ExecuteResult> {
    const botWalletShort = shortenAddress(
      this.botKeypair.publicKey.toBase58(),
      6
    );
    const typeUpper = tradeTypeContext.toUpperCase();
    logInfo(
      `[${botWalletShort}] -------- REAL ${typeUpper} EXECUTION START --------`
    );
    let copyTradeTxId: string | undefined = undefined;

    try {
      const rawTransaction = transaction.serialize();
      // Use sendOptions from SolanaClient for consistency if needed, or define here.
      copyTradeTxId = await this.solanaClient.sendRawTransaction(
        rawTransaction
        // { skipPreflight: true, maxRetries: 5 } // Default options
      );
      logInfo(
        `[${botWalletShort}] 🚀 ${typeUpper} Trade Sent! Sig: ${copyTradeTxId}`
      );
      logInfo(`-> Explorer: ${this.explorerUrl}/tx/${copyTradeTxId}`);
      logInfo(
        `[${botWalletShort}] ⏳ Waiting for confirmation ('${
          (await this.solanaClient.connection.commitment) || "default"
        }')...` // Using connection's commitment
      );

      const latestBlockhash = await this.solanaClient
        .getLatestBlockhash
        // COMMITMENT_LEVEL.confirmation // from config
        ();
      const confirmationStrategy: TransactionConfirmationStrategy = {
        signature: copyTradeTxId,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      };

      await this.solanaClient.confirmTransaction(
        confirmationStrategy
        // COMMITMENT_LEVEL.confirmation // from config
      );
      logInfo(
        `[${botWalletShort}] ✅ ${typeUpper} Transaction Confirmed Successfully!`
      );
      return { success: true, signature: copyTradeTxId };
    } catch (execError: any) {
      logError(
        `[${botWalletShort}] CRITICAL: Error during real ${typeUpper} execution for ${tokenInfo.symbol}:`,
        execError.message ?? execError
      );
      // ... (existing error diagnosis logic)
      if (copyTradeTxId) {
        logError(
          `          -> Check Tx Status Manually: ${this.explorerUrl}/tx/${copyTradeTxId}`
        );
      }
      return { success: false };
    } finally {
      logInfo(
        `[${botWalletShort}] -------- REAL ${typeUpper} EXECUTION END --------`
      );
    }
  }

  private async simulateTradeInternal(
    transaction: VersionedTransaction,
    tokenInfo: TokenInfo,
    tradeTypeContext: string, // e.g., "buy", "sell (copy)", "sell (SL)"
    amount: number
  ): Promise<SimulateResult> {
    const botWalletShort = shortenAddress(
      this.botKeypair.publicKey.toBase58(),
      6
    );
    const typeUpper = tradeTypeContext.toUpperCase();
    logInfo(
      `[${botWalletShort}] -------- ${typeUpper} SIMULATION START --------`
    );

    const direction = tradeTypeContext.startsWith("buy")
      ? `SOL -> ${tokenInfo.symbol}`
      : `${tokenInfo.symbol} -> SOL`;
    const amountSymbol = tradeTypeContext.startsWith("buy")
      ? "SOL"
      : tokenInfo.symbol;
    logInfo(
      `[${botWalletShort}] Simulating ${typeUpper} trade: ${amount.toFixed(
        4 // Consider token decimals for amount display accuracy
      )} ${amountSymbol} (${direction})`
    );

    try {
      const lookupTableAccounts =
        await this.solanaClient.getNeededLookupTableAccounts(
          transaction.message
        );

      const simConfig = {
        commitment:
          (await this.solanaClient.connection.commitment) || "confirmed", // Using connection's commitment
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
          simConfig
        );

      if (simulationResult.value.err) {
        logError(`[${botWalletShort}] ❌ ${typeUpper} SIMULATION FAILED!`);
        logError(
          `          -> Error:`,
          JSON.stringify(simulationResult.value.err)
        );
        // ... (existing error diagnosis logic)
        if (simulationResult.value.logs?.length) {
          logWarn(`          -> Simulation Logs:`);
          simulationResult.value.logs.forEach((log) =>
            logWarn(`             | ${log}`)
          );
        } else {
          logWarn(`          -> No simulation logs available.`);
        }
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
        return { success: true };
      }
    } catch (simError: any) {
      logError(
        `[${botWalletShort}] CRITICAL: Error calling simulation API for ${typeUpper} ${tokenInfo.symbol}:`,
        simError.message ?? simError
      );
      // ... (existing error diagnosis logic)
      return { success: false };
    } finally {
      logInfo(
        `[${botWalletShort}] -------- ${typeUpper} SIMULATION END --------`
      );
    }
  }
}
