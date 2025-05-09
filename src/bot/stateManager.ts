import * as fs from "fs";
import * as path from "path";
import { logInfo, logWarn, logError } from "../utils/logging";

// Define the structure of a holding in memory
export interface BotHolding {
  amountLamports: bigint; // Use bigint for precision
  buyTxSignature: string;
  monitoredWallet: string; // Store as string (base58)
  // TODO: other fields like timestamp, buy price later
}

// Define the structure for JSON serialization (convert bigint to string)
interface BotHoldingJson {
  amountLamports: string; // Store as string in JSON
  buyTxSignature: string;
  monitoredWallet: string;
}

// Type for the structure stored in the JSON file (Map serialized as an object)
type HoldingsJson = Record<string, BotHoldingJson>;

/**
 * Manages the bot's holdings state, persisting it to a JSON file.
 */
export class StateManager {
  private holdings = new Map<string, BotHolding>(); // In-memory state <tokenMint, Holding>
  private readonly stateFilePath: string;

  /**
   * Creates an instance of StateManager.
   * @param filename The name of the JSON file to use for persistence ('bot_holdings.json').
   * @param dataDir Optional directory to store the file in (defaults to project root).
   */
  constructor(filename: string = "bot_holdings.json", dataDir: string = ".") {
    // Ensure the data directory exists
    if (dataDir !== "." && !fs.existsSync(dataDir)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        logInfo(`Created data directory: ${dataDir}`);
      } catch (err) {
        logError(`Failed to create data directory ${dataDir}:`, err);
        // Fallback to current directory if creation fails
        dataDir = ".";
      }
    }
    this.stateFilePath = path.join(dataDir, filename);
    logInfo(`State file path set to: ${this.stateFilePath}`);
  }

  /**
   * Loads holdings from the JSON file into the in-memory map.
   * Should be called once at bot startup.
   */
  loadHoldings(): void {
    if (!fs.existsSync(this.stateFilePath)) {
      logInfo(
        `State file not found at ${this.stateFilePath}. Starting with empty holdings.`
      );
      this.holdings = new Map<string, BotHolding>();
      return;
    }

    try {
      const fileContent = fs.readFileSync(this.stateFilePath, "utf-8");
      if (!fileContent) {
        logWarn(
          `State file ${this.stateFilePath} is empty. Starting with empty holdings.`
        );
        this.holdings = new Map<string, BotHolding>();
        return;
      }

      const parsedData: HoldingsJson = JSON.parse(fileContent);
      const loadedHoldings = new Map<string, BotHolding>();

      for (const tokenMint in parsedData) {
        if (Object.prototype.hasOwnProperty.call(parsedData, tokenMint)) {
          const holdingJson = parsedData[tokenMint];
          try {
            // Validate and convert back to internal format (with bigint)
            loadedHoldings.set(tokenMint, {
              amountLamports: BigInt(holdingJson.amountLamports), // Convert string back to bigint
              buyTxSignature: holdingJson.buyTxSignature,
              monitoredWallet: holdingJson.monitoredWallet,
            });
          } catch (convertErr) {
            logWarn(
              `Skipping invalid holding data for mint ${tokenMint} during load:`,
              convertErr
            );
          }
        }
      }
      this.holdings = loadedHoldings;
      logInfo(
        `Successfully loaded ${this.holdings.size} holdings from ${this.stateFilePath}`
      );
    } catch (error: any) {
      logError(
        `Error loading or parsing state file ${this.stateFilePath}:`,
        error.message
      );
      logWarn("Starting with empty holdings due to load error.");
      this.holdings = new Map<string, BotHolding>();
    }
  }

  /**
   * Saves the current in-memory holdings map to the JSON file.
   * Converts bigints to strings for serialization.
   * Should be called after any modification and during shutdown.
   */
  saveHoldings(): void {
    try {
      const holdingsToSave: HoldingsJson = {};
      for (const [tokenMint, holding] of this.holdings.entries()) {
        holdingsToSave[tokenMint] = {
          ...holding,
          amountLamports: holding.amountLamports.toString(), // Convert bigint to string
        };
      }

      const jsonString = JSON.stringify(holdingsToSave, null, 2); // Pretty print JSON

      // Write synchronously to ensure it completes during shutdown
      fs.writeFileSync(this.stateFilePath, jsonString, "utf-8");
      logInfo(
        `Successfully saved ${this.holdings.size} holdings to ${this.stateFilePath}`
      );
    } catch (error: any) {
      logError(`Error saving state file ${this.stateFilePath}:`, error.message);
    }
  }

  /**
   * Gets the current holding for a specific token mint.
   * @param tokenMint The mint address string.
   * @returns The BotHolding object or undefined if not held.
   */
  getHolding(tokenMint: string): BotHolding | undefined {
    return this.holdings.get(tokenMint);
  }

  /**
   * Adds or updates a holding for a token mint.
   * Aggregates amounts if the token is already held.
   * Saves the state after modification.
   * @param tokenMint The mint address string.
   * @param amountToAddLamports The amount of the token (in lamports) acquired in the latest buy.
   * @param buyTxSignature The signature of the bot's buy transaction.
   * @param monitoredWallet The address of the wallet that triggered the buy.
   */
  addOrUpdateHolding(
    tokenMint: string,
    amountToAddLamports: bigint,
    buyTxSignature: string,
    monitoredWallet: string // Pass base58 string
  ): void {
    const existingHolding = this.holdings.get(tokenMint);

    if (existingHolding) {
      // Aggregate amount
      existingHolding.amountLamports += amountToAddLamports;
      // Update to latest tx and wallet for simplicity:
      // TODO: Update the logic to handle this better
      existingHolding.buyTxSignature = buyTxSignature;
      existingHolding.monitoredWallet = monitoredWallet;
      logInfo(
        `Updated holding for ${tokenMint}. New amount: ${existingHolding.amountLamports}`
      );
    } else {
      // Add new holding
      this.holdings.set(tokenMint, {
        amountLamports: amountToAddLamports,
        buyTxSignature: buyTxSignature,
        monitoredWallet: monitoredWallet,
      });
      logInfo(
        `Added new holding for ${tokenMint}. Amount: ${amountToAddLamports}`
      );
    }

    // Save state after modification
    this.saveHoldings();
  }

  /**
   * Removes a holding for a specific token mint.
   * Saves the state after modification.
   * @param tokenMint The mint address string.
   */
  removeHolding(tokenMint: string): void {
    if (this.holdings.has(tokenMint)) {
      this.holdings.delete(tokenMint);
      logInfo(`Removed holding for ${tokenMint}.`);
      // Save state after modification
      this.saveHoldings();
    } else {
      logWarn(
        `Attempted to remove holding for ${tokenMint}, but it was not found.`
      );
    }
  }

  /**
   * Gets the entire holdings map (e.g., for debugging or display).
   * Returns a copy to prevent external modification.
   * @returns A new Map containing the current holdings.
   */
  getAllHoldings(): Map<string, BotHolding> {
    return new Map(this.holdings);
  }
}
