import { Metaplex, guestIdentity } from "@metaplex-foundation/js";
import { connection } from "./solana/connection";
import { SolanaClient } from "./solana/client";
import { TokenMetadataService } from "./solana/tokenMetadata";
import { TradeExecutor } from "./bot/executor";
import { WalletMonitor } from "./bot/monitor";
import {
  logCritical,
  logInfo,
  logWarn,
  logDebug,
  logError,
} from "./utils/logging";
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
} from "./config";

import { StateManager } from "./bot/stateManager";
import { getJupiterQuote } from "./jupiter/api";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

/**
 * Main application entry point.
 */

// Global variable to control the price monitoring loop
let isPriceMonitoringRunning = true;
let priceMonitoringIntervalId: NodeJS.Timeout | null = null;

async function priceMonitoringLoop(
  stateManager: StateManager,
  tradeExecutor: TradeExecutor,
  tokenMetadataService: TokenMetadataService
) {
  if (!MANAGE_WITH_SLTP) {
    logInfo(
      "[PriceMonitor] SL/TP management is disabled. Price monitoring loop will not run."
    );
    return;
  }
  logInfo(
    `[PriceMonitor] Starting SL/TP price monitoring loop. Interval: ${PRICE_CHECK_INTERVAL_MS}ms`
  );

  while (isPriceMonitoringRunning) {
    try {
      const holdings = stateManager.getAllHoldings();
      if (holdings.size === 0) {
      } else {
        logInfo(
          `[PriceMonitor] Checking prices for ${holdings.size} holdings...`
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
            `[PriceMonitor] Could not get price quote for ${tokenInfo.symbol} (${tokenMint}). Skipping this cycle.`
          );
          continue;
        }

        const currentValueInSolLamports = BigInt(currentPriceQuote.outAmount);
        const currentValueInSol =
          Number(currentValueInSolLamports) / LAMPORTS_PER_SOL;
        const tokensHeld =
          Number(holding.amountLamports) / 10 ** holding.tokenDecimals;

        if (tokensHeld <= 0) {
          logWarn(
            `[PriceMonitor] Zero tokens held for ${tokenInfo.symbol}, skipping SL/TP check.`
          );
          continue;
        }

        const currentPricePerTokenSol = currentValueInSol / tokensHeld;

        logDebug(
          `[PriceMonitor] ${
            tokenInfo.symbol
          }: AvgBuyPrice: ${holding.avgPurchasePriceInSol.toFixed(
            6
          )}, CurrPrice: ${currentPricePerTokenSol.toFixed(6)} SOL`
        );

        const tpPrice =
          holding.avgPurchasePriceInSol * (1 + TAKE_PROFIT_PERCENTAGE / 100);
        if (currentPricePerTokenSol >= tpPrice) {
          logInfo(
            `[PriceMonitor] TAKE PROFIT triggered for ${
              tokenInfo.symbol
            } at ${currentPricePerTokenSol.toFixed(
              6
            )} SOL (Target: >= ${tpPrice.toFixed(6)} SOL)`
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
            `[PriceMonitor] STOP LOSS triggered for ${
              tokenInfo.symbol
            } at ${currentPricePerTokenSol.toFixed(
              6
            )} SOL (Target: <= ${slPrice.toFixed(6)} SOL)`
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
      logError("[PriceMonitor] Error in price monitoring loop:", error);
    }
    await sleep(PRICE_CHECK_INTERVAL_MS);
  }
  logInfo("[PriceMonitor] Price monitoring loop stopped.");
}

async function main() {
  logInfo("=================================");
  logInfo(" Solana Copy Trading Bot Starting ");
  logInfo(` Bot Wallet: ${BOT_KEYPAIR.publicKey.toBase58()}`);
  logInfo("=================================");

  const solanaClient = new SolanaClient(connection);
  const metaplex = Metaplex.make(connection).use(guestIdentity());
  logInfo("Metaplex initialized.");

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
  logInfo("TradeExecutor initialized.");

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
  logInfo("WalletMonitor initialized.");

  walletMonitor.startMonitoring();

  if (MANAGE_WITH_SLTP) {
    priceMonitoringLoop(
      stateManager,
      tradeExecutor,
      tokenMetadataService
    ).catch((err) => {
      logCritical(
        "[PriceMonitor] Unhandled critical error in price monitoring loop:",
        err
      );
    });
  }

  logInfo("Bot is now running and monitoring wallets...");
  logInfo("Press CTRL+C to stop.");

  const shutdown = async () => {
    logInfo("\nGracefully shutting down...");
    isPriceMonitoringRunning = false;
    if (priceMonitoringIntervalId) clearInterval(priceMonitoringIntervalId);

    await walletMonitor.stopMonitoring();
    await sleep(
      PRICE_CHECK_INTERVAL_MS > 2000 ? 2000 : PRICE_CHECK_INTERVAL_MS + 200
    );
    stateManager.saveHoldings();
    logInfo("Shutdown complete. Exiting.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logCritical("CRITICAL UNHANDLED ERROR in main function:", err);
  process.exit(1);
});
