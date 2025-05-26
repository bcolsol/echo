import { Connection, PublicKey, Logs, Commitment } from "@solana/web3.js";
import { SolanaClient } from "../solana/client";
import { TokenMetadataService } from "../solana/tokenMetadata";
import { TradeExecutor } from "./executor";
import { analyzeTrade, isDexInteraction } from "../solana/analyzer";
import {
  COMMITMENT_LEVEL,
  MONITORED_WALLETS,
  MANAGE_WITH_SLTP,
  EXPLORER_URL,
} from "../config";
import { logError, logInfo, logWarn, logCritical } from "../utils/logging";
import { shortenAddress } from "../utils/helpers";
import { StateManager } from "./stateManager";

export class WalletMonitor {
  private readonly connection: Connection;
  private readonly solanaClient: SolanaClient;
  private readonly tokenMetadataService: TokenMetadataService;
  private readonly tradeExecutor: TradeExecutor;
  private readonly monitoredWallets: ReadonlyArray<{
    address: string;
    pubkey: PublicKey;
  }>;
  private readonly subscriptionCommitment: Commitment;
  private readonly fetchCommitment: Commitment;
  private subscriptionIds: number[] = [];
  private readonly stateManager: StateManager;

  constructor(
    connection: Connection,
    solanaClient: SolanaClient,
    tokenMetadataService: TokenMetadataService,
    tradeExecutor: TradeExecutor,
    stateManager: StateManager, // Add StateManager to constructor
    monitoredWallets: ReadonlyArray<{
      address: string;
      pubkey: PublicKey;
    }> = MONITORED_WALLETS, // Default from config
    subscriptionCommitment: Commitment = COMMITMENT_LEVEL.subscription, // Default from config
    fetchCommitment: Commitment = COMMITMENT_LEVEL.fetch // Default from config
  ) {
    this.connection = connection;
    this.solanaClient = solanaClient;
    this.tokenMetadataService = tokenMetadataService;
    this.tradeExecutor = tradeExecutor;
    this.stateManager = stateManager; // Initialize StateManager
    this.monitoredWallets = monitoredWallets;
    this.subscriptionCommitment = subscriptionCommitment;
    this.fetchCommitment = fetchCommitment;

    if (this.monitoredWallets.length === 0) {
      logWarn("WalletMonitor initialized with zero wallets to monitor."); // Keeping this, it's a valid user warning
    }
  }

  startMonitoring(): void {
    logInfo("-----------------------------------------------------");
    logInfo(
      `🚀 Starting wallet monitoring for ${this.monitoredWallets.length} wallet(s).`
    );
    logInfo(
      ` SL/TP Management: ${
        MANAGE_WITH_SLTP ? "✅ ENABLED" : "❌ DISABLED (Full Copy Mode)"
      }`
    );
    logInfo("-----------------------------------------------------");
    this.subscriptionIds = [];

    this.monitoredWallets.forEach(({ address, pubkey }) => {
      try {
        const subscriptionId = this.connection.onLogs(
          pubkey,
          (logs: Logs, context) => {
            this.handleLog(logs, pubkey, address).catch((err) => {
              logError(
                `[Monitor-${shortenAddress(
                  address
                )}] Error in handleLog for signature ${logs.signature}: ${err}` // Error log is important
              );
            });
          },
          this.subscriptionCommitment
        );
        this.subscriptionIds.push(subscriptionId);
        logInfo(`👂 Listening to logs for wallet: ${address}`);
      } catch (error) {
        logCritical(
          `🚨 CRITICAL: Failed to subscribe to logs for wallet ${address}: ${error}`
        );
      }
    });

    if (this.subscriptionIds.length > 0) {
      logInfo(
        `--- Wallet log monitoring active for ${this.subscriptionIds.length} wallet(s) ---`
      );
    } else if (this.monitoredWallets.length > 0) {
      logError("--- ⚠️ Failed to initialize ANY wallet log subscriptions! ---");
    } else {
      logWarn("--- No wallets configured to monitor ---"); // User should know if nothing is happening
    }
  }

  private async handleLog(
    logs: Logs,
    walletPubKey: PublicKey,
    walletAddress: string
  ): Promise<void> {
    const signature = logs.signature;
    const shortAddr = shortenAddress(walletAddress);
    const explorerTxUrl = `${EXPLORER_URL}/tx/${signature}`;

    if (logs.err) {
      logInfo(
        `[Monitor-${shortAddr}] Skipping tx ${signature} (Log contains error): ${explorerTxUrl}`
      );
      return;
    }

    try {
      const transaction = await this.solanaClient.getParsedTransaction(
        signature,
        this.fetchCommitment
      );

      if (!transaction) {
        logWarn(
          `[Monitor-${shortAddr}] Could not fetch transaction details for ${signature}. It might be dropped or not yet finalized at ${this.fetchCommitment} commitment.`
        );
        return;
      }

      if (isDexInteraction(transaction)) {
        const detectedTrade = await analyzeTrade(
          transaction,
          walletPubKey,
          this.tokenMetadataService
        );

        if (detectedTrade) {
          // Conditional logic for processing based on MANAGE_WITH_SLTP
          if (detectedTrade.type === "sell" && MANAGE_WITH_SLTP) {
            const holding = this.stateManager.getHolding(
              detectedTrade.tokenMint
            );
            // If the bot holds this token AND it has purchase price info (meaning it's SL/TP managed)
            if (
              holding &&
              holding.avgPurchasePriceInSol !== undefined &&
              holding.tokenDecimals !== undefined
            ) {
              logInfo(
                `[Monitor-${shortAddr}] Monitored wallet sold ${detectedTrade.tokenInfo.symbol}. Bot holds and manages this with SL/TP. Ignoring copy-sell for tx ${signature}.`
              );
              return; // Do not process this copy-sell
            }
          }

          // If it's a buy, or a sell in full-copy mode, or a sell of a non-SL/TP managed token
          // TradeExecutor will log the specifics of the action it takes, so no redundant log here like "Passing to executor"
          await this.tradeExecutor.processTrade(detectedTrade);
        } else {
          logInfo(
            `[Monitor-${shortAddr}] DEX interaction in ${signature} analyzed, but no copyable trade pattern found for the bot.`
          );
        }
      } else {
        logInfo(
          `[Monitor-${shortAddr}] Tx ${signature} is not a DEX interaction. Skipping detailed analysis.
          If this is a mistake, please add the program ID to the DEX_PROGRAM_IDS in config/index.ts and restart the bot.`
        );
      }
    } catch (err) {
      logError(
        `[Monitor-${shortAddr}] Error processing signature ${signature}: ${err}`
      );
    }
  }

  async stopMonitoring(): Promise<void> {
    logInfo("🔌 Stopping wallet monitoring...");
    if (this.subscriptionIds.length === 0) {
      logInfo("No active subscriptions to remove.");
      return;
    }
    const promises = this.subscriptionIds.map((id) => {
      return this.connection
        .removeOnLogsListener(id)
        .catch((err) => logError(`Error removing subscription ${id}: ${err}`));
    });
    await Promise.all(promises);
    this.subscriptionIds = [];
    logInfo("✅ All wallet log subscriptions removed.");
  }
}
