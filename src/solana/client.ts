import {
  Connection,
  VersionedTransaction,
  SendOptions,
  Commitment,
  PublicKey,
  TransactionSignature,
  RpcResponseAndContext,
  SimulatedTransactionResponse,
  TransactionConfirmationStrategy,
  BlockhashWithExpiryBlockHeight,
  AddressLookupTableAccount,
  VersionedMessage,
  SimulateTransactionConfig, // Import the config type
  Finality, // Import Finality type
  GetVersionedTransactionConfig, // Import config type for getParsedTransaction
} from "@solana/web3.js";
import { logError, logInfo, logWarn } from "../utils/logging";
import { COMMITMENT_LEVEL } from "../config"; // Import commitment levels

/**
 * A higher-level client for interacting with the Solana blockchain.
 * Wraps the Connection object to provide convenient methods for common tasks
 * like sending transactions, confirming, simulating, and fetching data.
 * Makes mocking for tests easier.
 */
export class SolanaClient {
  public readonly connection: Connection;

  /**
   * Creates an instance of SolanaClient.
   * @param connection The Solana Connection object.
   */
  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Fetches a parsed transaction.
   * @param signature The transaction signature.
   * @param commitment Optional commitment level. Defaults to config.fetch.
   * @returns The parsed transaction or null if not found/error.
   */
  async getParsedTransaction(
    signature: TransactionSignature,
    commitment: Commitment = COMMITMENT_LEVEL.fetch
  ) {
    const finalityCommitment = (
      commitment === "processed" ? "confirmed" : commitment
    ) as Finality;
    if (commitment === "processed") {
      logWarn(
        `Commitment 'processed' may not be suitable for getParsedTransaction in all scenarios. Using 'confirmed' instead for config object for tx ${signature}.`
      );
    }

    const config: GetVersionedTransactionConfig = {
      maxSupportedTransactionVersion: 0,
      commitment: finalityCommitment,
    };

    try {
      const transaction = await this.connection.getParsedTransaction(
        signature,
        config
      );
      if (!transaction) {
        logWarn(
          `Transaction not found or not yet processed: ${signature} at commitment ${finalityCommitment}`
        );
        return null;
      }
      return transaction;
    } catch (error: any) {
      logError(
        `Error fetching parsed transaction ${signature}:`,
        error.message ?? error
      );
      return null;
    }
  }

  /**
   * Sends a serialized transaction (Versioned or Legacy).
   * @param serializedTransaction The raw transaction buffer.
   * @param options Send options (e.g., skipPreflight, maxRetries).
   * @returns The transaction signature.
   * @throws Error if sending fails.
   */
  async sendRawTransaction(
    serializedTransaction: Buffer | Uint8Array,
    options: SendOptions = { skipPreflight: true, maxRetries: 5 }
  ): Promise<TransactionSignature> {
    try {
      const signature = await this.connection.sendRawTransaction(
        serializedTransaction,
        options
      );

      return signature;
    } catch (error: any) {
      logError(`Error sending raw transaction:`, error.message ?? error);
      throw error;
    }
  }

  /**
   * Confirms a transaction using a strategy (signature, blockhash, lastValidBlockHeight).
   * @param strategy The confirmation strategy.
   * @param commitment Optional commitment level. Defaults to config.
   * @returns The RPC response and context of the confirmation.
   * @throws Error if confirmation fails or times out.
   */
  async confirmTransaction(
    strategy: TransactionConfirmationStrategy,
    commitment: Commitment = COMMITMENT_LEVEL.confirmation
  ): Promise<RpcResponseAndContext<any>> {
    // Using 'any' for the value type as it varies
    logInfo(
      `Confirming transaction ${strategy.signature} with commitment: ${commitment}`
    );

    try {
      const result = await this.connection.confirmTransaction(
        strategy,
        commitment
      );
      if (result.value.err) {
        logError(
          `Transaction ${strategy.signature} confirmation failed:`,
          result.value.err
        );
        // Throw an error with structured information
        throw new Error(
          `Transaction confirmation failed: ${JSON.stringify(result.value.err)}`
        );
      }
      logInfo(`Transaction ${strategy.signature} confirmed successfully.`);
      return result;
    } catch (error: any) {
      logError(
        `Error during transaction confirmation for ${strategy.signature}:`,
        error.message ?? error
      );
      // Re-throw the error to be handled by the caller
      throw error;
    }
  }

  /**
   * Simulates a versioned transaction.
   * @param transaction The VersionedTransaction to simulate.
   * @param config Optional simulation configuration.
   * @returns The simulation result.
   * @throws Error if simulation API call fails.
   */
  async simulateVersionedTransaction(
    transaction: VersionedTransaction,
    config: SimulateTransactionConfig = {
      commitment: COMMITMENT_LEVEL.confirmation,
      replaceRecentBlockhash: true,
      sigVerify: false,
    }
  ): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
    try {
      const simulationResult = await this.connection.simulateTransaction(
        transaction,
        config
      );
      return simulationResult;
    } catch (error: any) {
      logError(`Error simulating transaction:`, error.message ?? error);
      throw error;
    }
  }

  /**
   * Fetches the latest blockhash.
   * @param commitment Optional commitment level. Defaults to config.
   * @returns Blockhash information.
   * @throws Error if fetching fails.
   */
  async getLatestBlockhash(
    commitment: Commitment = COMMITMENT_LEVEL.fetch
  ): Promise<BlockhashWithExpiryBlockHeight> {
    try {
      const blockhashInfo = await this.connection.getLatestBlockhash(
        commitment
      );
      return blockhashInfo;
    } catch (error: any) {
      logError(`Error fetching latest blockhash:`, error.message ?? error);
      throw error;
    }
  }

  /**
   * Fetches a single address lookup table account.
   * @param lookupTableKey PublicKey of the lookup table.
   * @param commitment Optional commitment level (must be Finality). Defaults to config.fetch.
   * @returns The AddressLookupTableAccount object or null if not found.
   */
  async getAddressLookupTable(
    lookupTableKey: PublicKey,
    commitment: Commitment = COMMITMENT_LEVEL.fetch
  ): Promise<AddressLookupTableAccount | null> {
    const finalityCommitment = (
      commitment === "processed" ? "confirmed" : commitment
    ) as Finality;
    if (commitment === "processed") {
      logWarn(
        `Commitment 'processed' is not valid for getAddressLookupTable. Using 'confirmed' instead for ${lookupTableKey.toBase58()}.`
      );
    }

    try {
      const account = await this.connection.getAddressLookupTable(
        lookupTableKey,
        { commitment: finalityCommitment }
      );
      if (!account.value) {
        logWarn(
          `Lookup table account ${lookupTableKey.toBase58()} not found at commitment ${finalityCommitment}.`
        );
      }
      return account.value;
    } catch (error: any) {
      logError(
        `Error fetching address lookup table account ${lookupTableKey.toBase58()}:`,
        error.message ?? error
      );
      return null;
    }
  }

  /**
   * Fetches multiple address lookup table accounts required for a VersionedMessage.
   * @param message The VersionedMessage from a transaction.
   * @param commitment Optional commitment level (must be Finality). Defaults to config.fetch.
   * @returns An array of fetched AddressLookupTableAccount objects (non-null only).
   */
  async getNeededLookupTableAccounts(
    message: VersionedMessage,
    commitment: Commitment = COMMITMENT_LEVEL.fetch
  ): Promise<AddressLookupTableAccount[]> {
    const lookupTableKeys = message.addressTableLookups.map(
      (lookup) => lookup.accountKey
    );
    if (lookupTableKeys.length === 0) {
      return [];
    }

    const fetchPromises = lookupTableKeys.map((key) =>
      this.getAddressLookupTable(key, commitment)
    );
    const lookupTableAccountsNullable = await Promise.all(fetchPromises);

    const lookupTableAccounts = lookupTableAccountsNullable.filter(
      (acc): acc is AddressLookupTableAccount => acc !== null
    );

    if (lookupTableAccounts.length < lookupTableKeys.length) {
      logWarn(`Could not fetch all required lookup tables for message.`);
    }

    return lookupTableAccounts;
  }
}
