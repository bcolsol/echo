import { PublicKey } from "@solana/web3.js";

/**
 * Represents the information fetched or known about a specific token mint.
 */
export interface TokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  logo?: string;
  metadataFetched: boolean; // Indicates if metadata was attempted/fetched vs. default
}

/**
 * Represents the result of analyzing a transaction for a potential trade.
 * Null if no relevant trade (buy/sell matching criteria) is detected.
 */
export type DetectedTrade = {
  type: "buy" | "sell";
  tokenInfo: TokenInfo;
  /** The mint address of the token being bought or sold */
  tokenMint: string;
  /** The mint address of the token used for payment/received (usually SOL/WSOL) */
  currencyMint: string;
  /** Symbol of the currency (e.g., "SOL", "WSOL") */
  currencySymbol: string;
  /** Amount of the token bought/sold (absolute value) */
  tokenAmount: number;
  /** Amount of the currency spent/received (absolute value) */
  currencyAmount: number;
  /** Signature of the original transaction where the trade was detected */
  originalTxSignature: string;
  /** Public key of the wallet being monitored where the trade occurred */
  monitoredWallet: PublicKey;
} | null;

/**
 * Structure for Jupiter Quote API Response (add more fields as needed)
 */
export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  // otherFees?: ...; // Add other relevant fields if you use them
  routePlan: any[]; // Keeping it simple for now
  // ... other fields used by /swap
}

/**
 * Structure for Jupiter Swap API Response
 */
export interface JupiterSwapResponse {
  swapTransaction: string; // base64 encoded transaction
  lastValidBlockHeight: number;
  // ... other fields
}

// Add any other shared types here
