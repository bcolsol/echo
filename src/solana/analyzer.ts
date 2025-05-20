// File: src/solana/analyzer.ts
import {
  ParsedTransactionWithMeta,
  PublicKey,
  TokenBalance,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { DEX_PROGRAM_IDS, WSOL_MINT, EXPLORER_URL } from "../config";
import { TokenInfo, DetectedTrade } from "../types";
import { TokenMetadataService } from "./tokenMetadata";
import { logInfo, logWarn } from "../utils/logging";
import { shortenAddress } from "../utils/helpers";

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

  for (const instruction of transaction.transaction.message.instructions) {
    if (
      "programId" in instruction &&
      DEX_PROGRAM_IDS.has(instruction.programId.toBase58())
    ) {
      return true;
    }
  }

  if (transaction.meta.innerInstructions) {
    for (const innerInstructionSet of transaction.meta.innerInstructions) {
      for (const instruction of innerInstructionSet.instructions) {
        if (
          "programId" in instruction &&
          DEX_PROGRAM_IDS.has(instruction.programId.toBase58())
        ) {
          return true;
        }
      }
    }
  }

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
  tokenMetadataService: TokenMetadataService
): Promise<DetectedTrade | null> {
  const monitoredWalletAddress = monitoredWalletPubKey.toBase58();
  const txSignature = transaction?.transaction.signatures[0];
  const shortMonitoredWallet = shortenAddress(monitoredWalletAddress);

  if (
    !transaction?.meta?.preTokenBalances ||
    !transaction.meta.postTokenBalances ||
    !transaction.meta.preBalances ||
    !transaction.meta.postBalances ||
    !transaction.transaction?.message?.accountKeys ||
    !txSignature
  ) {
    return null;
  }

  const { preTokenBalances, postTokenBalances, preBalances, postBalances } =
    transaction.meta;
  const accountKeys = transaction.transaction.message.accountKeys;

  let nativeSolChange = 0;
  const walletAccountIndex = accountKeys.findIndex((key) =>
    key.pubkey.equals(monitoredWalletPubKey)
  );
  if (walletAccountIndex !== -1) {
    nativeSolChange =
      (postBalances[walletAccountIndex] - preBalances[walletAccountIndex]) /
      LAMPORTS_PER_SOL;
  }

  const createBalanceMap = (
    balances: TokenBalance[]
  ): Map<string, TokenBalance> => {
    const map = new Map<string, TokenBalance>();
    for (const b of balances) {
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

  const preWsol = preTokenBalanceMap.get(WSOL_MINT);
  const postWsol = postTokenBalanceMap.get(WSOL_MINT);
  const wsolTokenChange =
    (postWsol?.uiTokenAmount.uiAmount ?? 0) -
    (preWsol?.uiTokenAmount.uiAmount ?? 0);

  const solThreshold = 0.00001;
  const solChangeToUse =
    Math.abs(nativeSolChange) > solThreshold
      ? nativeSolChange
      : wsolTokenChange;
  const solSymbolToUse =
    Math.abs(nativeSolChange) > solThreshold ? "SOL" : "WSOL";
  const solMintToUse = WSOL_MINT;

  if (Math.abs(solChangeToUse) < solThreshold) {
    return null;
  }

  const allMints = new Set([
    ...preTokenBalanceMap.keys(),
    ...postTokenBalanceMap.keys(),
  ]);

  for (const mint of allMints) {
    if (mint === WSOL_MINT) continue;

    const preBalance = preTokenBalanceMap.get(mint);
    const postBalance = postTokenBalanceMap.get(mint);

    const tokenChange =
      (postBalance?.uiTokenAmount.uiAmount ?? 0) -
      (preBalance?.uiTokenAmount.uiAmount ?? 0);

    if (Math.abs(tokenChange) > 0.000001) {
      const tokenInfo = await tokenMetadataService.getTokenInfo(mint);

      const isBuy = tokenChange > 0 && solChangeToUse < -solThreshold;
      const isSell = tokenChange < 0 && solChangeToUse > solThreshold;

      if (isBuy || isSell) {
        const tradeType = isBuy ? "buy" : "sell";

        return {
          type: tradeType,
          tokenInfo: tokenInfo,
          tokenMint: mint,
          currencyMint: solMintToUse,
          currencySymbol: solSymbolToUse,
          tokenAmount: Math.abs(tokenChange),
          currencyAmount: Math.abs(solChangeToUse),
          originalTxSignature: txSignature,
          monitoredWallet: monitoredWalletPubKey,
        };
      }
    }
  }

  return null;
}
