// src/jupiter/api.test.ts

import { PublicKey } from "@solana/web3.js";
import { getJupiterQuote, getJupiterSwap } from "./api";
import { JupiterQuoteResponse, JupiterSwapResponse } from "../types";
import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

describe("Jupiter API Client", () => {
  const MOCK_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
  const MOCK_SWAP_URL = "https://quote-api.jup.ag/v6/swap";
  const inputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
  const outputMint = "So11111111111111111111111111111111111111112"; // SOL
  const amount = 1000000; // 1 USDC
  const slippageBps = 50; // 0.5%
  const walletPublicKey = new PublicKey(
    "5xBiwdgBKaE7r4HMZ42qssvZ8yP936vuLNDrkvBAaAkg"
  );

  // @ts-ignore
  let mockFetch: jest.SpyInstance;
  // @ts-ignore
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockFetch = jest.spyOn(globalThis, "fetch");
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {}); // Suppress logs
  });

  afterEach(() => {
    mockFetch.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe("getJupiterQuote", () => {
    it("should call the quote API with correct parameters and return quote data on success", async () => {
      const mockQuoteResponse: JupiterQuoteResponse = {
        inputMint,
        inAmount: amount.toString(),
        outputMint,
        outAmount: "50000000",
        routePlan: [
          { swapInfo: { label: "Mock Swap", ammKey: "..." }, percent: 100 },
        ],
      };
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockQuoteResponse), { status: 200 })
      );

      const result = await getJupiterQuote(
        MOCK_QUOTE_URL,
        inputMint,
        outputMint,
        amount,
        slippageBps
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const expectedUrl = `${MOCK_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
      expect(mockFetch).toHaveBeenCalledWith(expectedUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      expect(result).toEqual(mockQuoteResponse);
    });

    it("should return null and log error if quote API returns non-200 status", async () => {
      const errorBody = JSON.stringify({ error: "Invalid mint account" });
      mockFetch.mockResolvedValueOnce(new Response(errorBody, { status: 400 }));

      const result = await getJupiterQuote(
        MOCK_QUOTE_URL,
        inputMint,
        outputMint,
        amount,
        slippageBps
      );

      expect(result).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[ERROR]",
        `[Jupiter] Quote API Error 400: ${errorBody}`
      );
    });

    it("should return null and log error if fetch throws an exception", async () => {
      const fetchError = new Error("Network failed");
      mockFetch.mockRejectedValueOnce(fetchError);

      const result = await getJupiterQuote(
        MOCK_QUOTE_URL,
        inputMint,
        outputMint,
        amount,
        slippageBps
      );

      expect(result).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[ERROR]",
        "[Jupiter] CRITICAL: Exception during Jupiter Quote API call: Network failed"
      );
    });
  });

  describe("getJupiterSwap", () => {
    const userPublicKey = walletPublicKey;
    const mockQuoteResponse: JupiterQuoteResponse = {
      inputMint,
      inAmount: amount.toString(),
      outputMint,
      outAmount: "50000000",
      routePlan: [
        { swapInfo: { label: "Mock Swap", ammKey: "..." }, percent: 100 },
      ],
    };
    const mockSwapResponse: JupiterSwapResponse = {
      swapTransaction: Buffer.from("mockSerializedTx").toString("base64"),
      lastValidBlockHeight: 123456789,
    };

    it("should call the swap API with correct payload and return swap data on success", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockSwapResponse), { status: 200 })
      );

      const result = await getJupiterSwap(
        MOCK_SWAP_URL,
        userPublicKey,
        mockQuoteResponse
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const expectedPayload = {
        quoteResponse: mockQuoteResponse,
        userPublicKey: userPublicKey.toBase58(),
        wrapAndUnwrapSol: true,
      };
      expect(mockFetch).toHaveBeenCalledWith(MOCK_SWAP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(expectedPayload),
      });
      expect(result).toEqual(mockSwapResponse);
    });

    it("should allow overriding wrapAndUnwrapSol", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockSwapResponse), { status: 200 })
      );

      await getJupiterSwap(
        MOCK_SWAP_URL,
        userPublicKey,
        mockQuoteResponse,
        false // Override wrap/unwrap
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const expectedPayload = {
        quoteResponse: mockQuoteResponse,
        userPublicKey: userPublicKey.toBase58(),
        wrapAndUnwrapSol: false,
      };
      expect(mockFetch).toHaveBeenCalledWith(
        MOCK_SWAP_URL,
        expect.objectContaining({
          body: JSON.stringify(expectedPayload),
        })
      );
    });

    it("should return null and log error if swap API returns non-200 status", async () => {
      const errorBody = JSON.stringify({ error: "Quote expired" });
      mockFetch.mockResolvedValueOnce(new Response(errorBody, { status: 400 }));

      const result = await getJupiterSwap(
        MOCK_SWAP_URL,
        userPublicKey,
        mockQuoteResponse
      );

      expect(result).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[ERROR]",
        `[Jupiter] Swap API Error 400: ${errorBody}`
      );
    });

    it("should return null and log error if fetch throws an exception", async () => {
      const fetchError = new Error("API unavailable");
      mockFetch.mockRejectedValueOnce(fetchError);

      const result = await getJupiterSwap(
        MOCK_SWAP_URL,
        userPublicKey,
        mockQuoteResponse
      );

      expect(result).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[ERROR]",
        "[Jupiter] CRITICAL: Exception during Jupiter Swap API call: API unavailable"
      );
    });
  });
});
