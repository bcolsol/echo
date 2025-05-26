import {
  Keypair,
  VersionedTransaction,
  TransactionConfirmationStrategy,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { SolanaClient } from "../solana/client";
import { getJupiterQuote, getJupiterSwap } from "../jupiter/api";
import { DetectedTrade, TokenInfo } from "../types";
import {
  WSOL_MINT,
  MANAGE_WITH_SLTP,
  TAKE_PROFIT_PERCENTAGE,
  STOP_LOSS_PERCENTAGE,
} from "../config";
import { logError, logInfo, logWarn } from "../utils/logging";
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
            `[Bot-${botWalletShort}] Monitored wallet sold ${detectedTrade.tokenInfo.symbol}. Bot is managing this token with SL/TP. Ignoring copy-sell.`
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
      `\n[Bot-${botWalletShort}] ---> BUY DETECTED for ${
        tokenInfo.symbol
      } from ${shortenAddress(monitoredWallet.toBase58())} <---`
    );
    logInfo(` Original Tx: ${this.explorerUrl}/tx/${originalTxSignature}`);
    logInfo(
      ` Detected Swap: ~${tradeDetails.currencyAmount.toFixed(4)} ${
        tradeDetails.currencySymbol
      } -> ${tradeDetails.tokenAmount.toFixed(tokenInfo.decimals)} ${
        tokenInfo.symbol
      } (${tokenInfo.name})`
    );
    // logInfo(` Token Mint: ${tokenMint}`);

    const tradeModeStatus = this.executeTrades
      ? "REAL EXECUTION"
      : "SIMULATION ONLY";

    const quoteResponse = await getJupiterQuote(
      this.jupiterQuoteApiUrl,
      WSOL_MINT, // Bot always buys with SOL (which Jupiter wraps to WSOL)
      tokenMint,
      this.tradeAmountLamports.toString(), // Bot's configured SOL amount for buy
      this.slippageBps
    );

    if (!quoteResponse) {
      logError(
        `[Bot-${botWalletShort}] CRITICAL: Failed to get Jupiter quote for BUYING ${tokenInfo.symbol}. Aborting copy trade.`
      );
      return;
    }

    const botExpectedTokensLamports = BigInt(quoteResponse.outAmount);
    const botSolCostLamports = BigInt(quoteResponse.inAmount); // Actual SOL cost for the quoted amount

    const swapResponse = await getJupiterSwap(
      this.jupiterSwapApiUrl,
      this.botKeypair.publicKey,
      quoteResponse
    );

    if (!swapResponse || !swapResponse.swapTransaction) {
      logError(
        `[Bot-${botWalletShort}] CRITICAL: Failed to get Jupiter swap instructions for BUYING ${tokenInfo.symbol}. Aborting copy trade.`
      );
      return;
    }

    let versionedTx: VersionedTransaction;
    try {
      const swapTransactionBuf = Buffer.from(
        swapResponse.swapTransaction,
        "base64"
      );
      versionedTx = VersionedTransaction.deserialize(swapTransactionBuf);
      versionedTx.sign([this.botKeypair]);
    } catch (error: any) {
      logError(
        `[Bot-${botWalletShort}] CRITICAL: Error processing BUY transaction object for ${
          tokenInfo.symbol
        }: ${error.message ?? error}`
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
    // logInfo( // Redundant, specific outcomes logged below
    //   `[Bot-${botWalletShort}] BUY execution/simulation result: ${JSON.stringify(
    //     buySuccessResult
    //   )}`
    // );

    if (buySuccessResult?.success) {
      if (this.executeTrades) {
        const signature =
          (buySuccessResult as ExecuteResult).signature ??
          "error_getting_signature";
        logInfo(
          `[Bot-${botWalletShort}] ✅ Successful BUY of ${tokenInfo.symbol}. Explorer: ${this.explorerUrl}/tx/${signature}`
        );
        this.stateManager.addOrUpdateHolding(
          tokenMint,
          botExpectedTokensLamports, // Actual amount of tokens the bot expects to receive
          botSolCostLamports, // Actual amount of SOL the bot expects to spend
          signature,
          monitoredWallet.toBase58(),
          tokenInfo.decimals,
          MANAGE_WITH_SLTP // Pass the global config
        );
      } else {
        logInfo(
          `[Bot-${botWalletShort}] ✅ SIMULATED BUY of ${tokenInfo.symbol} successful.`
        );
      }
    } else {
      logWarn(
        `[Bot-${botWalletShort}] ❌ ${tradeModeStatus} BUY of ${tokenInfo.symbol} FAILED. Holdings not updated.`
      );
    }
    logInfo(
      `[Bot-${botWalletShort}] --- BUY processing for ${tokenInfo.symbol} END ---`
    );
  }

  private async processSellTrade(
    tradeDetails: ValidTrade & { type: "sell" },
    botWalletShort: string
  ): Promise<void> {
    const { tokenInfo, tokenMint, originalTxSignature, monitoredWallet } =
      tradeDetails;

    logInfo(
      `\n[Bot-${botWalletShort}] ---> COPY-SELL DETECTED for ${
        tokenInfo.symbol
      } from ${shortenAddress(monitoredWallet.toBase58())} <---`
    );
    logInfo(` Original Tx: ${this.explorerUrl}/tx/${originalTxSignature}`);
    // logInfo(` Token Mint: ${tokenMint} (${tokenInfo.symbol})`); // Already in first line

    const holding = this.stateManager.getHolding(tokenMint);
    if (!holding) {
      logInfo(
        `[Bot-${botWalletShort}] Monitored wallet sold ${tokenInfo.symbol}, but bot does not hold this token. Ignoring copy-sell.`
      );
      return;
    }

    // Additional check: if MANAGE_WITH_SLTP is true, this path should ideally not be hit
    // for SLTP-managed tokens due to the check in processTrade. This is a safeguard.
    if (MANAGE_WITH_SLTP && holding.avgPurchasePriceInSol !== undefined) {
      logWarn(
        `[Bot-${botWalletShort}] Attempted to copy-sell ${tokenInfo.symbol}, but it's under SL/TP. This should have been filtered earlier. Ignoring.`
      );
      return;
    }

    const sellAmountTokenLamports = holding.amountLamports;
    const sellAmountTokenDisplay =
      Number(sellAmountTokenLamports) / 10 ** tokenInfo.decimals;

    const tradeModeStatus = this.executeTrades
      ? "REAL EXECUTION"
      : "SIMULATION ONLY";
    logInfo(
      `[Bot-${botWalletShort}] Bot holds ${sellAmountTokenDisplay.toFixed(
        tokenInfo.decimals
      )} ${
        tokenInfo.symbol
      }. Preparing to ${tradeModeStatus.toLowerCase()} COPY-SELL...`
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
        `[Bot-${botWalletShort}] CRITICAL: Failed to get Jupiter quote for COPY-SELLING ${tokenInfo.symbol}. Aborting.`
      );
      return;
    }
    const botExpectedSolLamports = BigInt(quoteResponse.outAmount);
    logInfo(
      `[Bot-${botWalletShort}] Jupiter quote for copy-sell: Sell ${sellAmountTokenDisplay.toFixed(
        tokenInfo.decimals
      )} ${tokenInfo.symbol} for ~${(
        Number(botExpectedSolLamports) / LAMPORTS_PER_SOL
      ).toFixed(9)} SOL.`
    );

    const swapResponse = await getJupiterSwap(
      this.jupiterSwapApiUrl,
      this.botKeypair.publicKey,
      quoteResponse
    );

    if (!swapResponse || !swapResponse.swapTransaction) {
      logError(
        `[Bot-${botWalletShort}] CRITICAL: Failed to get Jupiter swap instructions for COPY-SELLING ${tokenInfo.symbol}. Aborting.`
      );
      return;
    }

    let versionedTx: VersionedTransaction;
    try {
      const swapTransactionBuf = Buffer.from(
        swapResponse.swapTransaction,
        "base64"
      );
      versionedTx = VersionedTransaction.deserialize(swapTransactionBuf);
      versionedTx.sign([this.botKeypair]);
    } catch (error: any) {
      logError(
        `[Bot-${botWalletShort}] CRITICAL: Error processing COPY-SELL transaction object for ${
          tokenInfo.symbol
        }: ${error.message ?? error}`
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
    // logInfo( // Redundant, specific outcomes logged below
    //   // Moved logging outside
    //   `[Bot-${botWalletShort}] COPY-SELL execution/simulation result: ${JSON.stringify(
    //     sellSuccessResult
    //   )}`
    // );

    if (sellSuccessResult?.success) {
      if (this.executeTrades) {
        const signature =
          (sellSuccessResult as ExecuteResult).signature ??
          "error_getting_signature";
        logInfo(
          `[Bot-${botWalletShort}] ✅ Successful COPY-SELL of ${tokenInfo.symbol}. Explorer: ${this.explorerUrl}/tx/${signature}`
        );
        this.stateManager.removeHolding(tokenMint);
      } else {
        logInfo(
          `[Bot-${botWalletShort}] ✅ SIMULATED COPY-SELL of ${tokenInfo.symbol} successful.`
        );
      }
    } else {
      logWarn(
        `[Bot-${botWalletShort}] ❌ ${tradeModeStatus} COPY-SELL of ${tokenInfo.symbol} FAILED. Holdings not removed.`
      );
    }
    logInfo(
      `[Bot-${botWalletShort}] --- COPY-SELL processing for ${tokenInfo.symbol} END ---`
    );
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
      `\n[Bot-${botWalletShort}] ---> ${reasonFull.toUpperCase()} TRIGGERED for ${
        tokenInfo.symbol
      } (${tokenMint}) <---`
    );
    const sellAmountTokenLamports = holding.amountLamports;
    const sellAmountTokenDisplay =
      Number(sellAmountTokenLamports) /
      10 ** (holding.tokenDecimals || tokenInfo.decimals);

    const tradeModeStatus = this.executeTrades
      ? "REAL EXECUTION"
      : "SIMULATION ONLY";
    logInfo(
      `[Bot-${botWalletShort}] Bot holds ${sellAmountTokenDisplay.toFixed(
        holding.tokenDecimals || tokenInfo.decimals
      )} ${
        tokenInfo.symbol
      }. Preparing ${tradeModeStatus.toLowerCase()} ${reasonFull} sell...`
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
        `[Bot-${botWalletShort}] CRITICAL: Failed to get Jupiter quote for ${reasonFull} SELLING ${tokenInfo.symbol}. Aborting.`
      );
      return;
    }
    const botExpectedSolLamports = BigInt(quoteResponse.outAmount);
    logInfo(
      `[Bot-${botWalletShort}] Jupiter Quote for ${reasonFull} sell: Sell ${sellAmountTokenDisplay.toFixed(
        holding.tokenDecimals || tokenInfo.decimals
      )} ${tokenInfo.symbol} for ~${(
        Number(botExpectedSolLamports) / LAMPORTS_PER_SOL
      ).toFixed(9)} SOL.`
    );

    const swapResponse = await getJupiterSwap(
      this.jupiterSwapApiUrl,
      this.botKeypair.publicKey,
      quoteResponse
    );

    if (!swapResponse || !swapResponse.swapTransaction) {
      logError(
        `[Bot-${botWalletShort}] CRITICAL: Failed to get Jupiter swap instructions for ${reasonFull} SELLING ${tokenInfo.symbol}. Aborting.`
      );
      return;
    }

    let versionedTx: VersionedTransaction;
    try {
      const swapTransactionBuf = Buffer.from(
        swapResponse.swapTransaction,
        "base64"
      );
      versionedTx = VersionedTransaction.deserialize(swapTransactionBuf);
      versionedTx.sign([this.botKeypair]);
    } catch (error: any) {
      logError(
        `[Bot-${botWalletShort}] CRITICAL: Error processing ${reasonFull} SELL transaction object for ${
          tokenInfo.symbol
        }: ${error.message ?? error}`
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
    // logInfo( // Redundant, specific outcomes logged below
    //   // Moved logging outside
    //   `[Bot-${botWalletShort}] ${reasonFull} SELL execution/simulation result: ${JSON.stringify(
    //     sellSuccessResult
    //   )}`
    // );

    if (sellSuccessResult?.success) {
      if (this.executeTrades) {
        const signature =
          (sellSuccessResult as ExecuteResult).signature ??
          "error_getting_signature";
        logInfo(
          `[Bot-${botWalletShort}] ✅ Successful ${reasonFull} SELL of ${tokenInfo.symbol}. Explorer: ${this.explorerUrl}/tx/${signature}`
        );
        this.stateManager.removeHolding(tokenMint);
        // logInfo( // Combined with above
        //   `[Bot-${botWalletShort}] ${reasonFull} successful for ${tokenInfo.symbol}. Holding removed.`
        // );
      } else {
        logInfo(
          `[Bot-${botWalletShort}] ✅ SIMULATED ${reasonFull} SELL of ${tokenInfo.symbol} successful.`
        );
      }
    } else {
      logWarn(
        `[Bot-${botWalletShort}] ❌ ${tradeModeStatus} ${reasonFull} SELL of ${tokenInfo.symbol} FAILED. Holdings not removed.`
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

    let copyTradeTxId: string | undefined = undefined;

    try {
      const rawTransaction = transaction.serialize();
      copyTradeTxId = await this.solanaClient.sendRawTransaction(
        rawTransaction
      );
      logInfo(`[Bot-${botWalletShort}] 🚀 ${typeUpper} Trade Sent!`);
      logInfo(`-> Explorer: ${this.explorerUrl}/tx/${copyTradeTxId}`);
      logInfo(
        `[Bot-${botWalletShort}] ⏳ Waiting for confirmation ('${
          (await this.solanaClient.connection.commitment) || "default"
        }') for ${tokenInfo.symbol}...`
      );

      const latestBlockhash = await this.solanaClient.getLatestBlockhash();
      const confirmationStrategy: TransactionConfirmationStrategy = {
        signature: copyTradeTxId,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      };

      await this.solanaClient.confirmTransaction(confirmationStrategy);
      return { success: true, signature: copyTradeTxId };
    } catch (execError: any) {
      logError(
        `[Bot-${botWalletShort}] CRITICAL: Error during real ${typeUpper} execution for ${
          tokenInfo.symbol
        }: ${execError.message ?? execError}`
      );
      if (copyTradeTxId) {
        logError(
          `          -> Check Tx Status Manually: ${this.explorerUrl}/tx/${copyTradeTxId}`
        );
      }
      return { success: false };
    }
  }

  private async simulateTradeInternal(
    transaction: VersionedTransaction,
    tokenInfo: TokenInfo,
    tradeTypeContext: string,
    amount: number
  ): Promise<SimulateResult> {
    const botWalletShort = shortenAddress(
      this.botKeypair.publicKey.toBase58(),
      6
    );
    const typeUpper = tradeTypeContext.toUpperCase();
    logInfo(
      `[Bot-${botWalletShort}] -------- ${typeUpper} SIMULATION START --------`
    );

    const direction = tradeTypeContext.startsWith("buy")
      ? `SOL -> ${tokenInfo.symbol}`
      : `${tokenInfo.symbol} -> SOL`;
    const amountSymbol = tradeTypeContext.startsWith("buy")
      ? "SOL"
      : tokenInfo.symbol;
    logInfo(
      `[Bot-${botWalletShort}] Simulating ${typeUpper} trade: ${amount.toFixed(
        4
      )} ${amountSymbol} (${direction})`
    );

    try {
      const lookupTableAccounts =
        await this.solanaClient.getNeededLookupTableAccounts(
          transaction.message
        );

      const simConfig = {
        commitment:
          (await this.solanaClient.connection.commitment) || "confirmed",
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
        logError(
          `[Bot-${botWalletShort}] ❌ ${typeUpper} SIMULATION FAILED for ${tokenInfo.symbol}!`
        );
        logError(
          `          -> Error:`,
          JSON.stringify(simulationResult.value.err)
        );
        if (simulationResult.value.logs?.length) {
          logWarn(`          -> Simulation Logs (Failure):`);
          simulationResult.value.logs.forEach((log) =>
            logWarn(`             | ${log}`)
          );
        } else {
          logWarn(
            `          -> No simulation logs available for failed simulation.`
          );
        }
        return { success: false };
      } else {
        return { success: true };
      }
    } catch (simError: any) {
      logError(
        `[Bot-${botWalletShort}] CRITICAL: Error calling simulation API for ${typeUpper} ${
          tokenInfo.symbol
        }: ${simError.message ?? simError}`
      );
      return { success: false };
    } finally {
      logInfo(
        `[Bot-${botWalletShort}] -------- ${typeUpper} SIMULATION END --------`
      );
    }
  }
}
