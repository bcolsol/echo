import {
  Connection,
  PublicKey,
  Logs,
  Commitment,
  ParsedTransactionWithMeta,
} from "@solana/web3.js"; // Added ParsedTransactionWithMeta
import { SolanaClient } from "../solana/client";
import { TokenMetadataService } from "../solana/tokenMetadata";
import { TradeExecutor } from "./executor";
import { analyzeTrade, isDexInteraction } from "../solana/analyzer";
import {
  COMMITMENT_LEVEL,
  MONITORED_WALLETS,
  MANAGE_WITH_SLTP,
} from "../config";
import { logError, logInfo, logWarn } from "../utils/logging";
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
      logWarn("WalletMonitor initialized with zero wallets to monitor.");
    }
  }

  startMonitoring(): void {
    logInfo(
      `Starting wallet monitoring for ${this.monitoredWallets.length} wallets...`
    );
    logInfo(
      `SL/TP Management Mode: ${
        MANAGE_WITH_SLTP ? "ENABLED" : "DISABLED (Full Copy)"
      }`
    );
    this.subscriptionIds = [];

    this.monitoredWallets.forEach(({ address, pubkey }) => {
      try {
        const subscriptionId = this.connection.onLogs(
          pubkey,
          (logs: Logs, context) => {
            this.handleLog(logs, pubkey, address).catch((err) => {
              logError(
                `[${shortenAddress(
                  address
                )}] Error in async handleLog for signature ${logs.signature}:`,
                err
              );
            });
          },
          this.subscriptionCommitment
        );
        this.subscriptionIds.push(subscriptionId);
        logInfo(
          ` --> Subscribed to logs for wallet: ${address} (Sub ID: ${subscriptionId})`
        );
      } catch (error) {
        logError(
          `CRITICAL: Failed to subscribe to logs for wallet ${address}:`,
          error
        );
      }
    });

    if (this.subscriptionIds.length > 0) {
      logInfo(
        `--- ${this.subscriptionIds.length} wallet log subscriptions initialized ---`
      );
    } else if (this.monitoredWallets.length > 0) {
      logError("--- Failed to initialize any wallet log subscriptions ---");
    } else {
      logWarn("--- No wallets configured to monitor ---");
    }
  }

  private async handleLog(
    logs: Logs,
    walletPubKey: PublicKey,
    walletAddress: string
  ): Promise<void> {
    const signature = logs.signature;
    const shortAddr = shortenAddress(walletAddress);
    logInfo(`[${shortAddr}] Received log for signature: ${signature}`);

    if (logs.err) {
      logInfo(`[${shortAddr}] Skipping tx ${signature}: Log contains error.`);
      return;
    }

    try {
      const transaction = await this.solanaClient.getParsedTransaction(
        signature,
        this.fetchCommitment
      );

      if (!transaction) {
        logWarn(
          `[${shortAddr}] Could not fetch transaction details for ${signature}. It might be dropped or not yet finalized at ${this.fetchCommitment} commitment.`
        );
        return;
      }

      if (isDexInteraction(transaction)) {
        logInfo(
          `[${shortAddr}] DEX interaction detected in tx ${signature}. Analyzing trade...`
        );

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
                `[${shortAddr}] Monitored wallet sold ${detectedTrade.tokenInfo.symbol}. Bot holds and manages this with SL/TP. Ignoring copy-sell for tx ${signature}.`
              );
              return; // Do not process this copy-sell
            }
          }

          // If it's a buy, or a sell in full-copy mode, or a sell of a non-SL/TP managed token
          logInfo(
            `[${shortAddr}] Trade detected for ${detectedTrade.tokenInfo.symbol} (Type: ${detectedTrade.type}) in tx ${signature}. Passing to executor.`
          );
          await this.tradeExecutor.processTrade(detectedTrade);
        } else {
          logInfo(
            `[${shortAddr}] DEX interaction in ${signature} analyzed, but no copyable trade pattern found.`
          );
        }
      } else {
        logInfo(
          `[${shortAddr}] Tx ${signature} is not a DEX interaction. Skipping detailed analysis.`
        );
      }
    } catch (err) {
      logError(`[${shortAddr}] Error processing signature ${signature}:`, err);
    }
  }

  async stopMonitoring(): Promise<void> {
    logInfo("Stopping wallet monitoring...");
    if (this.subscriptionIds.length === 0) {
      logInfo("No active subscriptions to remove.");
      return;
    }
    const promises = this.subscriptionIds.map((id) => {
      logInfo(`Removing subscription ID: ${id}`);
      return this.connection
        .removeOnLogsListener(id)
        .catch((err) => logError(`Error removing subscription ${id}:`, err));
    });
    await Promise.all(promises);
    this.subscriptionIds = [];
    logInfo("All log subscriptions removed.");
  }
}
