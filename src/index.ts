import { Metaplex, guestIdentity } from "@metaplex-foundation/js";
import { connection } from "./solana/connection";
import { SolanaClient } from "./solana/client";
import { TokenMetadataService } from "./solana/tokenMetadata";
import { TradeExecutor } from "./bot/executor";
import { WalletMonitor } from "./bot/monitor";
import { logCritical, logInfo, logWarn, logError } from "./utils/logging";
import { sleep } from "./utils/helpers";
import {
  BOT_KEYPAIR,
  TRADE_AMOUNT_LAMPORTS,
  SLIPPAGE_BPS,
  EXECUTE_TRADES,
  EXPLORER_URL,
  JUPITER_QUOTE_API_URL,
  JUPITER_SWAP_API_URL,
  MONITORED_WALLETS,
  COMMITMENT_LEVEL,
  COPY_TRADE_AMOUNT_SOL,
  MANAGE_WITH_SLTP,
  TAKE_PROFIT_PERCENTAGE,
  STOP_LOSS_PERCENTAGE,
  PRICE_CHECK_INTERVAL_MS,
  WSOL_MINT,
  RPC_ENDPOINT, // Added for logging
} from "./config";

import { StateManager } from "./bot/stateManager";
import { getJupiterQuote } from "./jupiter/api";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

/**
 * Main application entry point.
 */

// Global variable to control the price monitoring loop
let isPriceMonitoringRunning = true;
// let priceMonitoringIntervalId: NodeJS.Timeout | null = null; // Not used, can be removed if no other plans for it

async function priceMonitoringLoop(
  stateManager: StateManager,
  tradeExecutor: TradeExecutor,
  tokenMetadataService: TokenMetadataService
) {
  if (!MANAGE_WITH_SLTP) {
    return;
  }
  logInfo(
    `[PriceEngine] SL/TP price monitoring active. Interval: ${
      PRICE_CHECK_INTERVAL_MS / 1000
    }s`
  );

  while (isPriceMonitoringRunning) {
    try {
      const holdings = stateManager.getAllHoldings();
      if (holdings.size === 0) {
      } else {
        logInfo(
          `[PriceEngine] Checking prices for ${holdings.size} SL/TP managed holdings...`
        );
      }

      for (const [tokenMint, holding] of holdings.entries()) {
        if (!isPriceMonitoringRunning) break;

        if (
          holding.avgPurchasePriceInSol === undefined ||
          holding.tokenDecimals === undefined ||
          holding.amountLamports <= 0n
        ) {
          continue;
        }

        const tokenInfo = await tokenMetadataService.getTokenInfo(tokenMint);

        const currentPriceQuote = await getJupiterQuote(
          JUPITER_QUOTE_API_URL,
          tokenMint,
          WSOL_MINT,
          holding.amountLamports.toString(),
          SLIPPAGE_BPS
        );

        if (!currentPriceQuote || !currentPriceQuote.outAmount) {
          logWarn(
            `[PriceEngine] Could not get price quote for ${tokenInfo.symbol} (${tokenMint}) to check SL/TP. Skipping this cycle.`
          );
          continue;
        }

        const currentValueInSolLamports = BigInt(currentPriceQuote.outAmount);
        const currentValueInSol =
          Number(currentValueInSolLamports) / LAMPORTS_PER_SOL;
        const tokensHeld =
          Number(holding.amountLamports) / 10 ** holding.tokenDecimals;

        if (tokensHeld <= 0) {
          continue;
        }

        const currentPricePerTokenSol = currentValueInSol / tokensHeld;

        logInfo(
          `[PriceEngine] ${
            tokenInfo.symbol
          } | Avg Buy: ${holding.avgPurchasePriceInSol.toFixed(
            6
          )} SOL | Current: ${currentPricePerTokenSol.toFixed(6)} SOL`
        );

        const tpPrice =
          holding.avgPurchasePriceInSol * (1 + TAKE_PROFIT_PERCENTAGE / 100);
        if (currentPricePerTokenSol >= tpPrice) {
          logInfo(
            `[PriceEngine] 🎉 TAKE PROFIT for ${
              tokenInfo.symbol
            } at ${currentPricePerTokenSol.toFixed(
              6
            )} SOL (Target: >=${tpPrice.toFixed(6)} SOL)`
          );
          await tradeExecutor.executeSlTpSell(
            tokenMint,
            holding,
            tokenInfo,
            "TP"
          );
          await sleep(1000);
          continue;
        }

        const slPrice =
          holding.avgPurchasePriceInSol * (1 - STOP_LOSS_PERCENTAGE / 100);
        if (currentPricePerTokenSol <= slPrice) {
          logInfo(
            `[PriceEngine] 🛡️ STOP LOSS for ${
              tokenInfo.symbol
            } at ${currentPricePerTokenSol.toFixed(
              6
            )} SOL (Target: <=${slPrice.toFixed(6)} SOL)`
          );
          await tradeExecutor.executeSlTpSell(
            tokenMint,
            holding,
            tokenInfo,
            "SL"
          );
          await sleep(1000);
          continue;
        }
      }
    } catch (error) {
      logError("[PriceEngine] Error in SL/TP price monitoring loop:", error);
    }
    await sleep(PRICE_CHECK_INTERVAL_MS);
  }
  logInfo("[PriceEngine] SL/TP Price monitoring loop stopped.");
}

async function main() {
  const solanaClient = new SolanaClient(connection);
  const metaplex = Metaplex.make(connection).use(guestIdentity());

  const tokenMetadataService = new TokenMetadataService(connection, metaplex);
  await tokenMetadataService.initializeTokenMap();

  const stateManager = new StateManager("bot_holdings.json");
  stateManager.loadHoldings();

  const tradeExecutor = new TradeExecutor(
    solanaClient,
    BOT_KEYPAIR,
    TRADE_AMOUNT_LAMPORTS,
    COPY_TRADE_AMOUNT_SOL,
    SLIPPAGE_BPS,
    EXECUTE_TRADES,
    EXPLORER_URL,
    JUPITER_QUOTE_API_URL,
    JUPITER_SWAP_API_URL,
    stateManager
  );

  const walletMonitor = new WalletMonitor(
    connection,
    solanaClient,
    tokenMetadataService,
    tradeExecutor,
    stateManager,
    MONITORED_WALLETS,
    COMMITMENT_LEVEL.subscription,
    COMMITMENT_LEVEL.fetch
  );

  walletMonitor.startMonitoring();

  if (MANAGE_WITH_SLTP) {
    priceMonitoringLoop(
      stateManager,
      tradeExecutor,
      tokenMetadataService
    ).catch((err) => {
      logCritical(
        "🚨 CRITICAL: Unhandled error in SL/TP price monitoring loop:",
        err
      );
    });
  }

  logInfo("✅ Bot is now running. Press CTRL+C to stop.");

  const shutdown = async () => {
    logInfo("\n🛑 Gracefully shutting down bot...");
    isPriceMonitoringRunning = false;

    await walletMonitor.stopMonitoring();

    const shutdownPause = Math.min(
      2000,
      PRICE_CHECK_INTERVAL_MS > 0 ? PRICE_CHECK_INTERVAL_MS + 200 : 200
    );
    await sleep(shutdownPause);

    stateManager.saveHoldings();
    logInfo("👋 Bot shutdown complete. Exiting.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (error) => {
    logCritical("🚨 UNCAUGHT EXCEPTION:", error);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason, promise) => {
    logCritical("🚨 UNHANDLED PROMISE REJECTION:", reason);
    process.exit(1);
  });
}

main().catch((err) => {
  logCritical("🚨 CRITICAL ERROR in main function:", err); // User needs to see this
  process.exit(1); // Ensure exit on critical main error
});
