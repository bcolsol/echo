// src/index.ts

import { Metaplex, guestIdentity } from "@metaplex-foundation/js";
import { connection } from "./solana/connection"; // Import the shared connection
import { SolanaClient } from "./solana/client";
import { TokenMetadataService } from "./solana/tokenMetadata";
import { TradeExecutor } from "./bot/executor";
import { WalletMonitor } from "./bot/monitor";
import { logCritical, logInfo } from "./utils/logging";

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
} from "./config";
import { StateManager } from "./bot/stateManager";
/**
 * Main application entry point.
 * Initializes services and starts the copy trading bot.
 */
async function main() {
  logInfo("=================================");
  logInfo(" Solana Copy Trading Bot Starting ");
  logInfo(` Bot Wallet: ${BOT_KEYPAIR.publicKey.toBase58()}`);
  logInfo("=================================");

  // --- Initialize Solana and Metaplex ---
  // SolanaClient wraps the connection for easier interaction and testing
  const solanaClient = new SolanaClient(connection);

  // Metaplex is used for fetching token metadata
  const metaplex = Metaplex.make(connection).use(guestIdentity());
  logInfo("Metaplex initialized.");

  // --- Initialize Services ---
  // TokenMetadataService handles fetching/caching token info
  const tokenMetadataService = new TokenMetadataService(connection, metaplex);

  // Initialize the cache with Jupiter's list (async)
  await tokenMetadataService.initializeTokenMap();

  // Initialize the state manager
  const stateManager = new StateManager("bot_holdings.json");
  stateManager.loadHoldings();

  // TradeExecutor handles the logic for executing/simulating trades
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
  logInfo("TradeExecutor initialized with explicit dependencies.");

  // WalletMonitor listens for logs and orchestrates the process
  const walletMonitor = new WalletMonitor(
    connection,
    solanaClient,
    tokenMetadataService,
    tradeExecutor,
    MONITORED_WALLETS,
    COMMITMENT_LEVEL.subscription,
    COMMITMENT_LEVEL.fetch
  );
  logInfo("WalletMonitor initialized with explicit dependencies.");

  // --- Start Monitoring ---
  walletMonitor.startMonitoring();

  logInfo("Bot is now running and monitoring wallets...");
  logInfo("Press CTRL+C to stop.");

  // Keep the process running indefinitely
  // Handle graceful shutdown by saving holdings to json file
  process.on("SIGINT", async () => {
    logInfo("\nGracefully shutting down...");
    await walletMonitor.stopMonitoring();
    stateManager.saveHoldings();
    logInfo("Shutdown complete. Exiting.");
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logInfo("\nReceived SIGTERM. Gracefully shutting down...");
    await walletMonitor.stopMonitoring();
    stateManager.saveHoldings();
    logInfo("Shutdown complete. Exiting.");
    process.exit(0);
  });

  // Keep the main thread alive, otherwise the script would exit immediately
  await new Promise(() => {});
}

// --- Run the Application ---
main().catch((err) => {
  logCritical("CRITICAL UNHANDLED ERROR in main function:", err);
  process.exit(1);
});
