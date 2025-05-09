import {
  ParsedTransactionWithMeta,
  PublicKey,
  TokenBalance,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { DEX_PROGRAM_IDS, WSOL_MINT } from "../config";
import { TokenInfo, DetectedTrade } from "../types";
import { TokenMetadataService } from "./tokenMetadata"; // Import the service class
import { logDebug } from "../utils/logging";

/**
 * Checks if a transaction involves interaction with known DEX program IDs.
 * Looks at both top-level and inner instructions.
 *
 * @param transaction The parsed transaction with metadata.
 * @returns True if a DEX interaction is found, false otherwise.
 */
export function isDexInteraction(
  transaction: ParsedTransactionWithMeta | null
): boolean {
  if (
    !transaction ||
    !transaction.meta ||
    !transaction.transaction.message.instructions
  ) {
    return false;
  }

  // Check top-level instructions
  for (const instruction of transaction.transaction.message.instructions) {
    if (
      "programId" in instruction && // Check if it's a ParsedInstruction
      DEX_PROGRAM_IDS.has(instruction.programId.toBase58())
    ) {
      logDebug(
        `DEX interaction found in top-level instructions: ${instruction.programId.toBase58()}`
      );
      return true;
    }
  }

  // Check inner instructions (important for aggregators like Jupiter)
  if (transaction.meta.innerInstructions) {
    for (const innerInstructionSet of transaction.meta.innerInstructions) {
      for (const instruction of innerInstructionSet.instructions) {
        // Inner instructions might be CompiledInstruction, check for programIdIndex first
        if (
          "programId" in instruction &&
          DEX_PROGRAM_IDS.has(instruction.programId.toBase58())
        ) {
          logDebug(
            `DEX interaction found in inner instructions: ${instruction.programId.toBase58()}`
          );
          return true;
        }
        // Add handling for CompiledInstruction if necessary, though ParsedTransaction usually provides ParsedInstruction
        // else if ("programIdIndex" in instruction) { ... lookup programId from accountKeys ... }
      }
    }
  }

  logDebug("No DEX interaction detected in transaction.");
  return false;
}

/**
 * Analyzes a transaction's token balance changes to detect a potential buy or sell
 * involving SOL/WSOL for a specific monitored wallet.
 *
 * @param transaction The parsed transaction with metadata.
 * @param monitoredWalletPubKey The public key of the wallet being monitored.
 * @param tokenMetadataService An instance of TokenMetadataService to fetch token info.
 * @returns A Promise resolving to a DetectedTrade object if a trade is found, otherwise null.
 */
export async function analyzeTrade(
  transaction: ParsedTransactionWithMeta | null,
  monitoredWalletPubKey: PublicKey,
  tokenMetadataService: TokenMetadataService // Inject dependency
): Promise<DetectedTrade | null> {
  const monitoredWalletAddress = monitoredWalletPubKey.toBase58();
  const txSignature = transaction?.transaction.signatures[0];

  // --- Basic Validation ---
  if (
    !transaction?.meta?.preTokenBalances ||
    !transaction.meta.postTokenBalances ||
    !transaction.meta.preBalances ||
    !transaction.meta.postBalances ||
    !transaction.transaction?.message?.accountKeys ||
    !txSignature
  ) {
    logDebug(
      `[${monitoredWalletAddress}] Skipping analysis for tx ${txSignature}: Incomplete metadata.`
    );
    return null; // Incomplete data, cannot process
  }

  const { preTokenBalances, postTokenBalances, preBalances, postBalances } =
    transaction.meta;
  const accountKeys = transaction.transaction.message.accountKeys;

  // --- Calculate SOL Change ---
  let nativeSolChange = 0;
  const walletAccountIndex = accountKeys.findIndex((key) =>
    key.pubkey.equals(monitoredWalletPubKey)
  );
  if (walletAccountIndex !== -1) {
    nativeSolChange =
      (postBalances[walletAccountIndex] - preBalances[walletAccountIndex]) /
      LAMPORTS_PER_SOL;
  } else {
    logDebug(
      `[${monitoredWalletAddress}] Monitored wallet not found directly in accountKeys for tx ${txSignature}. SOL change might be inaccurate if via ATA only.`
    );
    // Consider if this case needs different handling - maybe skip?
  }

  // --- Calculate Token Changes ---
  // Helper to create a map of mint -> balance for the monitored owner
  const createBalanceMap = (
    balances: TokenBalance[]
  ): Map<string, TokenBalance> => {
    const map = new Map<string, TokenBalance>();
    for (const b of balances) {
      // Ensure the owner matches and uiAmount is valid before adding
      if (
        b.owner === monitoredWalletAddress &&
        b.uiTokenAmount?.uiAmount !== null &&
        b.uiTokenAmount?.uiAmount !== undefined
      ) {
        map.set(b.mint, b);
      }
    }
    return map;
  };

  const preTokenBalanceMap = createBalanceMap(preTokenBalances);
  const postTokenBalanceMap = createBalanceMap(postTokenBalances);

  // --- Calculate WSOL Change ---
  const preWsol = preTokenBalanceMap.get(WSOL_MINT);
  const postWsol = postTokenBalanceMap.get(WSOL_MINT);
  const wsolTokenChange =
    (postWsol?.uiTokenAmount.uiAmount ?? 0) -
    (preWsol?.uiTokenAmount.uiAmount ?? 0);

  // --- Determine Primary SOL/WSOL Change ---
  // Use native SOL change if significant, otherwise fallback to WSOL change.
  // This handles cases where SOL is wrapped/unwrapped within the transaction.
  const solThreshold = 0.00001; // Small threshold to ignore dust amounts
  const solChangeToUse =
    Math.abs(nativeSolChange) > solThreshold
      ? nativeSolChange
      : wsolTokenChange;
  const solSymbolToUse =
    Math.abs(nativeSolChange) > solThreshold ? "SOL" : "WSOL"; // Label based on which change we used
  const solMintToUse = WSOL_MINT; // Always use WSOL mint for Jupiter quotes, even if native SOL changed

  // If neither SOL nor WSOL changed significantly, it's unlikely a SOL-based trade
  if (Math.abs(solChangeToUse) < solThreshold) {
    logDebug(
      `[${monitoredWalletAddress}] No significant SOL/WSOL change detected for tx ${txSignature}.`
    );
    return null;
  }

  // --- Iterate Through Other Token Changes ---
  const allMints = new Set([
    ...preTokenBalanceMap.keys(),
    ...postTokenBalanceMap.keys(),
  ]);

  for (const mint of allMints) {
    // Skip WSOL itself
    if (mint === WSOL_MINT) continue;

    const preBalance = preTokenBalanceMap.get(mint);
    const postBalance = postTokenBalanceMap.get(mint);

    // Calculate the change in the token's balance
    const tokenChange =
      (postBalance?.uiTokenAmount.uiAmount ?? 0) -
      (preBalance?.uiTokenAmount.uiAmount ?? 0);

    // Only proceed if there's a non-negligible change in this token
    if (Math.abs(tokenChange) > 0.000001) {
      const tokenInfo = await tokenMetadataService.getTokenInfo(mint); // Fetch metadata

      // Define buy/sell conditions based on SOL/WSOL and token changes
      // Buy: Token balance increased, SOL/WSOL balance decreased
      const isBuy = tokenChange > 0 && solChangeToUse < -solThreshold;
      // Sell: Token balance decreased, SOL/WSOL balance increased
      const isSell = tokenChange < 0 && solChangeToUse > solThreshold;

      if (isBuy || isSell) {
        const tradeType = isBuy ? "buy" : "sell";
        logDebug(
          `[${monitoredWalletAddress}] ${tradeType.toUpperCase()} detected for ${
            tokenInfo.symbol
          } (${mint}) in tx ${txSignature}`
        );

        // Return the structured trade information
        return {
          type: tradeType,
          tokenInfo: tokenInfo,
          tokenMint: mint,
          currencyMint: solMintToUse, // Use WSOL_MINT
          currencySymbol: solSymbolToUse, // SOL or WSOL label
          tokenAmount: Math.abs(tokenChange), // Absolute value
          currencyAmount: Math.abs(solChangeToUse), // Absolute value
          originalTxSignature: txSignature,
          monitoredWallet: monitoredWalletPubKey,
        };
      }
    }
  }

  // If loop completes without finding a matching buy/sell pattern
  logDebug(
    `[${monitoredWalletAddress}] Tx ${txSignature} analyzed, but no matching SOL/Token trade pattern found.`
  );
  return null;
}
