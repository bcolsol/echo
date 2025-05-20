import * as fs from "fs";
import * as path from "path";
import { logInfo, logWarn, logError } from "../utils/logging";
import { LAMPORTS_PER_SOL } from "@solana/web3.js"; // For price calculation

// Define the structure of a holding in memory
export interface BotHolding {
  amountLamports: bigint; // Total amount of this token held (in smallest units)
  buyTxSignature: string; // Signature of the *latest* buy TX contributing to this holding
  monitoredWallet: string; // Wallet that triggered the *latest* buy

  // Fields for SL/TP Management
  // Sum of SOL spent for all lots of this token (in lamports)
  totalSolInvestedLamports?: bigint;
  // Average purchase price: (totalSolInvestedLamports / LAMPORTS_PER_SOL) / (amountLamports / 10^tokenDecimals)
  // This represents the average price in SOL per 1 full unit of the token.
  avgPurchasePriceInSol?: number;
  tokenDecimals?: number; // Decimals of the token, essential for price calculation
}

// Define the structure for JSON serialization
interface BotHoldingJson {
  amountLamports: string; // Store as string in JSON
  buyTxSignature: string;
  monitoredWallet: string;
  totalSolInvestedLamports?: string; // Store as string
  avgPurchasePriceInSol?: number; // Store as number
  tokenDecimals?: number; // Store as number
}

type HoldingsJson = Record<string, BotHoldingJson>; // Map serialized as an object

export class StateManager {
  private holdings = new Map<string, BotHolding>();
  private readonly stateFilePath: string;

  constructor(filename: string = "bot_holdings.json", dataDir: string = ".") {
    if (dataDir !== "." && !fs.existsSync(dataDir)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        logInfo(`[StateManager] Created data directory: ${dataDir}`);
      } catch (err) {
        logError(
          `[StateManager] Failed to create data directory ${dataDir}, using current directory:`,
          err
        );
        dataDir = "."; // Fallback to current directory
      }
    }
    this.stateFilePath = path.join(dataDir, filename);
  }

  loadHoldings(): void {
    if (!fs.existsSync(this.stateFilePath)) {
      logInfo(
        `[StateManager] State file not found at ${this.stateFilePath}. Starting with empty holdings.`
      );
      this.holdings = new Map<string, BotHolding>();
      return;
    }

    try {
      const fileContent = fs.readFileSync(this.stateFilePath, "utf-8");
      if (!fileContent.trim()) {
        // Check if file is empty or only whitespace
        logWarn(
          `[StateManager] State file ${this.stateFilePath} is empty. Starting with empty holdings.`
        );
        this.holdings = new Map<string, BotHolding>();
        return;
      }

      const parsedData: HoldingsJson = JSON.parse(fileContent);
      const loadedHoldings = new Map<string, BotHolding>();
      let invalidCount = 0;

      for (const tokenMint in parsedData) {
        if (Object.prototype.hasOwnProperty.call(parsedData, tokenMint)) {
          const holdingJson = parsedData[tokenMint];
          try {
            // Basic validation for essential fields
            if (
              !holdingJson.amountLamports ||
              !holdingJson.buyTxSignature ||
              !holdingJson.monitoredWallet
            ) {
              logWarn(
                `[StateManager] Skipping holding for mint ${tokenMint} due to missing essential fields.`
              );
              invalidCount++;
              continue;
            }
            loadedHoldings.set(tokenMint, {
              amountLamports: BigInt(holdingJson.amountLamports),
              buyTxSignature: holdingJson.buyTxSignature,
              monitoredWallet: holdingJson.monitoredWallet,
              totalSolInvestedLamports: holdingJson.totalSolInvestedLamports
                ? BigInt(holdingJson.totalSolInvestedLamports)
                : undefined,
              avgPurchasePriceInSol: holdingJson.avgPurchasePriceInSol,
              tokenDecimals: holdingJson.tokenDecimals,
            });
          } catch (convertErr) {
            logWarn(
              `[StateManager] Skipping invalid holding data for mint ${tokenMint} during load: ${
                convertErr instanceof Error ? convertErr.message : convertErr
              }`
            );
            invalidCount++;
          }
        }
      }
      this.holdings = loadedHoldings;
      if (invalidCount > 0) {
        logWarn(
          `[StateManager] Skipped ${invalidCount} invalid holding entries during load.`
        );
      }
    } catch (error: any) {
      logError(
        `[StateManager] Error loading or parsing state file ${this.stateFilePath}: ${error.message}`
      );
      logWarn("[StateManager] Starting with empty holdings due to load error.");
      this.holdings = new Map<string, BotHolding>();
    }
  }

  saveHoldings(): void {
    try {
      const holdingsToSave: HoldingsJson = {};
      for (const [tokenMint, holding] of this.holdings.entries()) {
        holdingsToSave[tokenMint] = {
          ...holding,
          amountLamports: holding.amountLamports.toString(),
          totalSolInvestedLamports:
            holding.totalSolInvestedLamports?.toString(),
        };
      }

      const jsonString = JSON.stringify(holdingsToSave, null, 2);
      fs.writeFileSync(this.stateFilePath, jsonString, "utf-8");
      logInfo(
        `[StateManager] Successfully saved ${this.holdings.size} holdings to ${this.stateFilePath}`
      );
    } catch (error: any) {
      logError(
        `[StateManager] Error saving state file ${this.stateFilePath}: ${error.message}`
      );
    }
  }

  getHolding(tokenMint: string): BotHolding | undefined {
    return this.holdings.get(tokenMint);
  }

  /**
   * Adds or updates a holding. If MANAGE_WITH_SLTP is enabled, it calculates
   * and updates the average purchase price.
   * @param tokenMint The mint address.
   * @param amountBoughtLamports Amount of token bought (smallest units).
   * @param solSpentLamports Amount of SOL spent for this buy (lamports).
   * @param buyTxSignature Signature of the bot's buy transaction.
   * @param monitoredWallet Address of the wallet that triggered the buy.
   * @param tokenDecimals Decimals of the token being bought.
   * @param manageWithSLTP Global config flag if SL/TP is active.
   */
  addOrUpdateHolding(
    tokenMint: string,
    amountBoughtLamports: bigint,
    solSpentLamports: bigint,
    buyTxSignature: string,
    monitoredWallet: string,
    tokenDecimals: number,
    manageWithSLTP: boolean // Pass the global config flag
  ): void {
    const existingHolding = this.holdings.get(tokenMint);
    let actionMessage = "";

    if (existingHolding) {
      existingHolding.amountLamports += amountBoughtLamports;
      existingHolding.buyTxSignature = buyTxSignature; // Update to latest tx
      existingHolding.monitoredWallet = monitoredWallet; // Update to latest trigger wallet

      if (manageWithSLTP) {
        existingHolding.totalSolInvestedLamports =
          (existingHolding.totalSolInvestedLamports || 0n) + solSpentLamports;
        existingHolding.tokenDecimals = tokenDecimals; // Should be the same, but update if necessary

        if (
          existingHolding.amountLamports > 0n &&
          existingHolding.tokenDecimals !== undefined
        ) {
          const totalSol =
            Number(existingHolding.totalSolInvestedLamports) / LAMPORTS_PER_SOL;
          const totalTokens =
            Number(existingHolding.amountLamports) /
            10 ** existingHolding.tokenDecimals;
          existingHolding.avgPurchasePriceInSol =
            totalTokens > 0 ? totalSol / totalTokens : 0;
        } else {
          existingHolding.avgPurchasePriceInSol = 0;
        }
        actionMessage = `Updated holding for ${tokenMint}. New amount: ${
          existingHolding.amountLamports
        }, Avg Price: ${
          existingHolding.avgPurchasePriceInSol?.toFixed(6) || "N/A"
        } SOL`;
      } else {
        // If not managing with SLTP, clear SLTP specific fields or don't calculate them
        existingHolding.totalSolInvestedLamports = undefined;
        existingHolding.avgPurchasePriceInSol = undefined;
        existingHolding.tokenDecimals = undefined; // Or keep if useful for other purposes
        actionMessage = `Updated holding for ${tokenMint} (SL/TP disabled). New amount: ${existingHolding.amountLamports}`;
      }
    } else {
      // Add new holding
      const newHolding: BotHolding = {
        amountLamports: amountBoughtLamports,
        buyTxSignature: buyTxSignature,
        monitoredWallet: monitoredWallet,
      };
      if (manageWithSLTP) {
        newHolding.totalSolInvestedLamports = solSpentLamports;
        newHolding.tokenDecimals = tokenDecimals;
        if (amountBoughtLamports > 0n && tokenDecimals !== undefined) {
          const totalSol = Number(solSpentLamports) / LAMPORTS_PER_SOL;
          const totalTokens =
            Number(amountBoughtLamports) / 10 ** tokenDecimals;
          newHolding.avgPurchasePriceInSol =
            totalTokens > 0 ? totalSol / totalTokens : 0;
        } else {
          newHolding.avgPurchasePriceInSol = 0;
        }
        actionMessage = `Added new SL/TP-managed holding for ${tokenMint}. Amount: ${amountBoughtLamports}, Avg Price: ${
          newHolding.avgPurchasePriceInSol?.toFixed(6) || "N/A"
        } SOL`;
      } else {
        actionMessage = `Added new holding for ${tokenMint} (SL/TP disabled). Amount: ${amountBoughtLamports}`;
      }
      this.holdings.set(tokenMint, newHolding);
    }
    this.saveHoldings();
  }

  removeHolding(tokenMint: string): void {
    if (this.holdings.has(tokenMint)) {
      this.holdings.delete(tokenMint);
      this.saveHoldings();
    } else {
      logWarn(
        `[StateManager] Attempted to remove holding for ${tokenMint}, but it was not found.`
      );
    }
  }

  getAllHoldings(): Map<string, BotHolding> {
    return new Map(this.holdings);
  }
}
