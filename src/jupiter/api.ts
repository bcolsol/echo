import { PublicKey } from "@solana/web3.js";
import { JupiterQuoteResponse, JupiterSwapResponse } from "../types";
import { logError } from "../utils/logging";

/**
 * Fetches a trade quote from the Jupiter API V6.
 * @param quoteApiUrl The Jupiter V6 Quote API endpoint URL.
 * @param inputMint Mint address of the input token.
 * @param outputMint Mint address of the output token.
 * @param amount Amount of input token in smallest units (lamports).
 * @param slippageBps Slippage tolerance in basis points (e.g., 50 for 0.5%).
 * @param onlyDirectRoutes Optional: Whether to only consider direct routes.
 * @returns A Promise resolving to the JupiterQuoteResponse or null if an error occurs.
 */
export async function getJupiterQuote(
  quoteApiUrl: string,
  inputMint: string,
  outputMint: string,
  amount: number | string, // Can be number or string
  slippageBps: number,
  onlyDirectRoutes: boolean = false
): Promise<JupiterQuoteResponse | null> {
  const urlParams = new URLSearchParams({
    inputMint: inputMint,
    outputMint: outputMint,
    amount: amount.toString(),
    slippageBps: slippageBps.toString(),
    onlyDirectRoutes: onlyDirectRoutes.toString(),
  });

  const quoteUrl = `${quoteApiUrl}?${urlParams.toString()}`;

  try {
    const response = await fetch(quoteUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      // Logged by TradeExecutor if it's critical for a trade action
      logError(
        `[JupiterAPI] Quote API Error ${response.status} for ${inputMint}->${outputMint}: ${errorBody}`
      );
      return null;
    }

    const quoteData: JupiterQuoteResponse = (await response.json()) as any;
    return quoteData;
  } catch (error: any) {
    logError(
      // This is a critical exception and should be logged
      `[JupiterAPI] CRITICAL: Exception during Jupiter Quote API call for ${inputMint}->${outputMint}: ${error.message}`
    );
    return null;
  }
}

/**
 * Fetches swap instructions from the Jupiter API V6 based on a quote.
 * @param swapApiUrl The Jupiter V6 Swap API endpoint URL.
 * @param userPublicKey The public key of the user's wallet executing the swap.
 * @param quoteResponse The quote response object obtained from getJupiterQuote.
 * @param wrapAndUnwrapSol Optional: Whether Jupiter should handle SOL wrapping/unwrapping. Default true.
 * @returns A Promise resolving to the JupiterSwapResponse containing the base64 transaction or null if an error occurs.
 */
export async function getJupiterSwap(
  swapApiUrl: string,
  userPublicKey: PublicKey,
  quoteResponse: JupiterQuoteResponse,
  wrapAndUnwrapSol: boolean = true
): Promise<JupiterSwapResponse | null> {
  const swapPayload = {
    quoteResponse: quoteResponse,
    userPublicKey: userPublicKey.toBase58(),
    wrapAndUnwrapSol: wrapAndUnwrapSol,
  };

  try {
    const response = await fetch(swapApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(swapPayload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      // Logged by TradeExecutor if it's critical for a trade action
      logError(
        `[JupiterAPI] Swap API Error ${
          response.status
        } for user ${userPublicKey.toBase58()}: ${errorBody}`
      );
      return null;
    }

    const swapData: JupiterSwapResponse = (await response.json()) as any;
    return swapData;
  } catch (error: any) {
    logError(
      // This is a critical exception and should be logged
      `[JupiterAPI] CRITICAL: Exception during Jupiter Swap API call for user ${userPublicKey.toBase58()}: ${
        error.message
      }`
    );
    return null;
  }
}
