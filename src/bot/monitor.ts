// src/bot/monitor.ts

import { Connection, PublicKey, Logs, Commitment } from "@solana/web3.js";
import { SolanaClient } from "../solana/client";
import { TokenMetadataService } from "../solana/tokenMetadata";
import { TradeExecutor } from "./executor";
import { analyzeTrade, isDexInteraction } from "../solana/analyzer";
import { COMMITMENT_LEVEL, MONITORED_WALLETS } from "../config";
import { logError, logInfo, logWarn } from "../utils/logging";
import { shortenAddress } from "../utils/helpers";

/**
 * Monitors specified Solana wallets for DEX activity and triggers copy trades.
 */
export class WalletMonitor {
  private readonly connection: Connection; // Direct connection for subscriptions
  private readonly solanaClient: SolanaClient;
  private readonly tokenMetadataService: TokenMetadataService;
  private readonly tradeExecutor: TradeExecutor;
  private readonly monitoredWallets: ReadonlyArray<{
    address: string;
    pubkey: PublicKey;
  }>;
  private readonly subscriptionCommitment: Commitment;
  private readonly fetchCommitment: Commitment;
  private subscriptionIds: number[] = []; // To keep track of active subscriptions

  /**
   * Creates an instance of WalletMonitor.
   * @param connection The raw Solana Connection object (for subscriptions).
   * @param solanaClient The SolanaClient instance (for fetching transactions).
   * @param tokenMetadataService The TokenMetadataService instance.
   * @param tradeExecutor The TradeExecutor instance.
   * @param monitoredWallets Array of wallet objects to monitor.
   * @param subscriptionCommitment Commitment level for log subscriptions.
   * @param fetchCommitment Commitment level for fetching transaction details.
   */
  constructor(
    connection: Connection,
    solanaClient: SolanaClient,
    tokenMetadataService: TokenMetadataService,
    tradeExecutor: TradeExecutor,
    monitoredWallets: ReadonlyArray<{
      address: string;
      pubkey: PublicKey;
    }> = MONITORED_WALLETS,
    subscriptionCommitment: Commitment = COMMITMENT_LEVEL.subscription,
    fetchCommitment: Commitment = COMMITMENT_LEVEL.fetch
  ) {
    this.connection = connection;
    this.solanaClient = solanaClient;
    this.tokenMetadataService = tokenMetadataService;
    this.tradeExecutor = tradeExecutor;
    this.monitoredWallets = monitoredWallets;
    this.subscriptionCommitment = subscriptionCommitment;
    this.fetchCommitment = fetchCommitment;

    if (this.monitoredWallets.length === 0) {
      logWarn("WalletMonitor initialized with zero wallets to monitor.");
    }
  }

  /**
   * Starts monitoring the configured wallets by subscribing to their logs.
   */
  startMonitoring(): void {
    logInfo(
      `Starting wallet monitoring for ${this.monitoredWallets.length} wallets...`
    );
    this.subscriptionIds = []; // Clear any previous subscription IDs

    this.monitoredWallets.forEach(({ address, pubkey }) => {
      try {
        const subscriptionId = this.connection.onLogs(
          pubkey,
          (logs: Logs, context) => {
            // Asynchronously handle log processing to avoid blocking the listener
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

  /**
   * Handles incoming logs for a monitored wallet.
   * Fetches the transaction, checks for DEX interaction, analyzes the trade,
   * and triggers the executor if a relevant trade is detected.
   * @param logs The Logs object from the subscription.
   * @param walletPubKey The PublicKey of the monitored wallet.
   * @param walletAddress The string address of the monitored wallet (for logging).
   */
  private async handleLog(
    logs: Logs,
    walletPubKey: PublicKey,
    walletAddress: string
  ): Promise<void> {
    const signature = logs.signature;
    const shortAddr = shortenAddress(walletAddress);
    logInfo(`[${shortAddr}] Received log for signature: ${signature}`);

    // Check if the log indicates success (basic filter)
    if (logs.err) {
      logInfo(`[${shortAddr}] Skipping tx ${signature}: Log contains error.`);
      return;
    }

    try {
      // Fetch the full parsed transaction details
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

      // Check if it's a potential DEX interaction
      if (isDexInteraction(transaction)) {
        logInfo(
          `[${shortAddr}] DEX interaction detected in tx ${signature}. Analyzing trade...`
        );

        // Analyze the balance changes to identify the trade
        const detectedTrade = await analyzeTrade(
          transaction,
          walletPubKey,
          this.tokenMetadataService
        );

        if (detectedTrade) {
          logInfo(
            `[${shortAddr}] Trade detected for ${detectedTrade.tokenInfo.symbol} in tx ${signature}. Passing to executor.`
          );
          // Trigger the trade executor (handles buy/sell logic internally)
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
      // Catch errors during transaction fetching or analysis
      logError(`[${shortAddr}] Error processing signature ${signature}:`, err);
    }
  }

  /**
   * Stops monitoring by unsubscribing from all active log subscriptions.
   */
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
        .catch((err) => logError(`Error removing subscription ${id}:`, err)); // Catch individual errors
    });
    await Promise.all(promises);
    this.subscriptionIds = []; // Clear the array
    logInfo("All log subscriptions removed.");
  }
}
