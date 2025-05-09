// src/solana/analyzer.test.ts

import {
  PublicKey,
  ParsedTransactionWithMeta,
  ParsedInstruction,
  ParsedInnerInstruction,
} from "@solana/web3.js";
import { analyzeTrade, isDexInteraction } from "./analyzer";
import { TokenMetadataService } from "./tokenMetadata"; // We need to mock this
import { DEX_PROGRAM_IDS, WSOL_MINT } from "../config"; // Import DEX IDs and WSOL
import { DetectedTrade, TokenInfo } from "../types"; // Import types
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// --- Mocks ---

// Mock the TokenMetadataService
// We tell Jest that TokenMetadataService is a class we want to mock
jest.mock("./tokenMetadata");

// Create a mock instance of the service before each test
let mockTokenMetadataService: jest.Mocked<TokenMetadataService>;
const wallet1 = new PublicKey("5xBiwdgBKaE7r4HMZ42qssvZ8yP936vuLNDrkvBAaAkq");
const wallet2 = new PublicKey("5xBiwdgBKaE7r4HMZ42qssvZ8yP936vuLNDrkvBAaAko");

beforeEach(() => {
  // Reset mocks before each test to ensure isolation
  jest.clearAllMocks();

  // Create a fresh mock instance for each test
  // We cast the result of the mock constructor to the mocked type
  mockTokenMetadataService = new TokenMetadataService(
    {} as any, // Mock connection (not used directly in mocked methods)
    {} as any // Mock metaplex (not used directly in mocked methods)
  ) as jest.Mocked<TokenMetadataService>;

  // Setup default mock implementation for getTokenInfo
  // It needs to return a Promise resolving to TokenInfo
  mockTokenMetadataService.getTokenInfo.mockImplementation(
    async (mint: string): Promise<TokenInfo> => {
      // Default mock implementation - return basic info based on mint
      if (mint === "TEST_TOKEN_MINT_ABC") {
        return {
          symbol: "TSTA",
          name: "Test Token A",
          decimals: 6,
          metadataFetched: true,
        };
      }
      if (mint === "TEST_TOKEN_MINT_XYZ") {
        return {
          symbol: "TSTX",
          name: "Test Token X",
          decimals: 9,
          metadataFetched: true,
        };
      }
      // Fallback for unknown mints in tests
      return {
        symbol: `UNKN (${mint.substring(0, 4)})`,
        name: "Unknown Test Token",
        decimals: 6,
        metadataFetched: false,
      };
    }
  );
});

// --- Test Data Helper ---

// Helper to create a basic mock ParsedTransactionWithMeta structure
const createMockTx = (
  accountKeys: PublicKey[],
  instructions: Partial<ParsedInstruction>[] = [],
  innerInstructions: ParsedInnerInstruction[] = [],
  preBalances: number[] = [],
  postBalances: number[] = [],
  preTokenBalances: any[] = [], // Use 'any' for simplicity in mock data
  postTokenBalances: any[] = [] // Use 'any' for simplicity in mock data
): ParsedTransactionWithMeta => {
  return {
    slot: 1,
    blockTime: Date.now() / 1000,
    meta: {
      err: null,
      fee: 5000,
      preBalances: preBalances,
      postBalances: postBalances,
      preTokenBalances: preTokenBalances,
      postTokenBalances: postTokenBalances,
      innerInstructions: innerInstructions,
      logMessages: [],
      loadedAddresses: { writable: [], readonly: [] },
      computeUnitsConsumed: 10000,
    },
    transaction: {
      signatures: ["mockSignature" + Math.random()],
      message: {
        accountKeys: accountKeys.map((pubkey) => ({
          pubkey,
          signer: false,
          writable: false,
          source: "transaction",
        })), // Basic mapping
        instructions: instructions as ParsedInstruction[], // Cast needed parts
        recentBlockhash: "mockBlockhash",
        addressTableLookups: null, // Add if testing ALTs
        // Other message fields can be added if needed
      },
    },
    version: 0, // Assuming version 0 for simplicity
  } as ParsedTransactionWithMeta; // Cast necessary because we omit some fields
};

// --- Test Suites ---

describe("isDexInteraction", () => {
  const knownDexId = [...DEX_PROGRAM_IDS][0]; // Get a known DEX ID
  const nonDexId = "11111111111111111111111111111111"; // System program

  it("should return true if a top-level instruction uses a known DEX program ID", () => {
    const tx = createMockTx(
      [],
      [{ programId: new PublicKey(knownDexId), program: "", parsed: {} }]
    );
    expect(isDexInteraction(tx)).toBe(true);
  });

  it("should return true if an inner instruction uses a known DEX program ID", () => {
    const tx = createMockTx(
      [],
      [], // No top-level DEX instruction
      [
        {
          index: 0,
          instructions: [
            {
              programId: new PublicKey(knownDexId),
              program: "",
              parsed: {},
            } as ParsedInstruction,
          ],
        },
      ]
    );
    expect(isDexInteraction(tx)).toBe(true);
  });

  it("should return false if no instructions use a known DEX program ID", () => {
    const tx = createMockTx(
      [],
      [{ programId: new PublicKey(nonDexId), program: "", parsed: {} }],
      [
        {
          index: 0,
          instructions: [
            {
              programId: new PublicKey(nonDexId),
              program: "",
              parsed: {},
            } as ParsedInstruction,
          ],
        },
      ]
    );
    expect(isDexInteraction(tx)).toBe(false);
  });

  it("should return false if transaction is null", () => {
    expect(isDexInteraction(null)).toBe(false);
  });

  it("should return false if transaction meta is missing", () => {
    const tx = createMockTx([], [], [], [], [], [], []);
    // @ts-ignore - Intentionally setting meta to null for test
    tx.meta = null;
    expect(isDexInteraction(tx)).toBe(false);
  });
});

describe("analyzeTrade", () => {
  const LAMPORTS_PER_SOL = 1_000_000_000;
  const monitoredWallet = wallet1;
  const otherWallet = wallet2;
  const tokenMintA = "TEST_TOKEN_MINT_ABC";
  const tokenMintX = "TEST_TOKEN_MINT_XYZ";

  it("should detect a BUY trade using native SOL", async () => {
    const tx = createMockTx(
      [monitoredWallet, otherWallet], // accountKeys
      [], // instructions
      [], // innerInstructions
      [10 * LAMPORTS_PER_SOL, 5 * LAMPORTS_PER_SOL], // preBalances (monitored, other)
      [9 * LAMPORTS_PER_SOL, 6 * LAMPORTS_PER_SOL], // postBalances (monitored decreased)
      // preTokenBalances (monitored owns 0 TSTA initially)
      [
        {
          mint: tokenMintA,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "0",
            decimals: 6,
            uiAmount: 0,
            uiAmountString: "0",
          },
        },
      ],
      // postTokenBalances (monitored owns 100 TSTA after)
      [
        {
          mint: tokenMintA,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "100000000",
            decimals: 6,
            uiAmount: 100,
            uiAmountString: "100",
          },
        },
      ]
    );

    const result = await analyzeTrade(
      tx,
      monitoredWallet,
      mockTokenMetadataService
    );

    expect(result).not.toBeNull();
    expect(result?.type).toBe("buy");
    expect(result?.tokenMint).toBe(tokenMintA);
    expect(result?.currencyMint).toBe(WSOL_MINT); // Should default to WSOL for Jupiter
    expect(result?.currencySymbol).toBe("SOL"); // Label should be SOL
    expect(result?.tokenAmount).toBeCloseTo(100);
    expect(result?.currencyAmount).toBeCloseTo(1); // 1 SOL change
    expect(result?.tokenInfo.symbol).toBe("TSTA");
    expect(mockTokenMetadataService.getTokenInfo).toHaveBeenCalledWith(
      tokenMintA
    );
  });

  it("should detect a BUY trade using WSOL", async () => {
    const tx = createMockTx(
      [monitoredWallet, otherWallet], // accountKeys
      [], // instructions
      [], // innerInstructions
      [10 * LAMPORTS_PER_SOL, 5 * LAMPORTS_PER_SOL], // preBalances (SOL unchanged)
      [10 * LAMPORTS_PER_SOL, 5 * LAMPORTS_PER_SOL], // postBalances
      // preTokenBalances (monitored owns 2 WSOL and 0 TSTX)
      [
        {
          mint: WSOL_MINT,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "2000000000",
            decimals: 9,
            uiAmount: 2,
            uiAmountString: "2",
          },
        },
        {
          mint: tokenMintX,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "0",
            decimals: 9,
            uiAmount: 0,
            uiAmountString: "0",
          },
        },
      ],
      // postTokenBalances (monitored owns 1 WSOL and 50 TSTX)
      [
        {
          mint: WSOL_MINT,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "1000000000",
            decimals: 9,
            uiAmount: 1,
            uiAmountString: "1",
          },
        },
        {
          mint: tokenMintX,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "50000000000",
            decimals: 9,
            uiAmount: 50,
            uiAmountString: "50",
          },
        },
      ]
    );

    const result = await analyzeTrade(
      tx,
      monitoredWallet,
      mockTokenMetadataService
    );

    expect(result).not.toBeNull();
    expect(result?.type).toBe("buy");
    expect(result?.tokenMint).toBe(tokenMintX);
    expect(result?.currencyMint).toBe(WSOL_MINT);
    expect(result?.currencySymbol).toBe("WSOL"); // Label WSOL
    expect(result?.tokenAmount).toBeCloseTo(50);
    expect(result?.currencyAmount).toBeCloseTo(1); // 1 WSOL change
    expect(result?.tokenInfo.symbol).toBe("TSTX");
    expect(mockTokenMetadataService.getTokenInfo).toHaveBeenCalledWith(
      tokenMintX
    );
  });

  it("should detect a SELL trade using native SOL", async () => {
    const tx = createMockTx(
      [monitoredWallet, otherWallet], // accountKeys
      [], // instructions
      [], // innerInstructions
      [9 * LAMPORTS_PER_SOL, 6 * LAMPORTS_PER_SOL], // preBalances (monitored starts lower)
      [10 * LAMPORTS_PER_SOL, 5 * LAMPORTS_PER_SOL], // postBalances (monitored increased)
      // preTokenBalances (monitored owns 100 TSTA initially)
      [
        {
          mint: tokenMintA,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "100000000",
            decimals: 6,
            uiAmount: 100,
            uiAmountString: "100",
          },
        },
      ],
      // postTokenBalances (monitored owns 0 TSTA after)
      [
        {
          mint: tokenMintA,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "0",
            decimals: 6,
            uiAmount: 0,
            uiAmountString: "0",
          },
        },
      ]
    );

    const result = await analyzeTrade(
      tx,
      monitoredWallet,
      mockTokenMetadataService
    );

    expect(result).not.toBeNull();
    expect(result?.type).toBe("sell");
    expect(result?.tokenMint).toBe(tokenMintA);
    expect(result?.currencyMint).toBe(WSOL_MINT);
    expect(result?.currencySymbol).toBe("SOL"); // Label should be SOL
    expect(result?.tokenAmount).toBeCloseTo(100);
    expect(result?.currencyAmount).toBeCloseTo(1); // 1 SOL change
    expect(result?.tokenInfo.symbol).toBe("TSTA");
    expect(mockTokenMetadataService.getTokenInfo).toHaveBeenCalledWith(
      tokenMintA
    );
  });

  it("should return null if no significant SOL/WSOL change occurs", async () => {
    const tx = createMockTx(
      [monitoredWallet],
      [],
      [],
      [10 * LAMPORTS_PER_SOL],
      [10 * LAMPORTS_PER_SOL], // No SOL change
      // No WSOL change
      [
        {
          mint: WSOL_MINT,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "1000000000",
            decimals: 9,
            uiAmount: 1,
            uiAmountString: "1",
          },
        },
      ],
      [
        {
          mint: WSOL_MINT,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "1000000000",
            decimals: 9,
            uiAmount: 1,
            uiAmountString: "1",
          },
        },
      ]
    );
    const result = await analyzeTrade(
      tx,
      monitoredWallet,
      mockTokenMetadataService
    );
    expect(result).toBeNull();
  });

  it("should return null if token change does not correspond to SOL/WSOL change direction (e.g., both increase)", async () => {
    const tx = createMockTx(
      [monitoredWallet],
      [],
      [],
      [10 * LAMPORTS_PER_SOL],
      [11 * LAMPORTS_PER_SOL], // SOL Increased (like sell)
      // Token also increased (like buy) - mismatch
      [
        {
          mint: tokenMintA,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "0",
            decimals: 6,
            uiAmount: 0,
            uiAmountString: "0",
          },
        },
      ],
      [
        {
          mint: tokenMintA,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "100000000",
            decimals: 6,
            uiAmount: 100,
            uiAmountString: "100",
          },
        },
      ]
    );
    const result = await analyzeTrade(
      tx,
      monitoredWallet,
      mockTokenMetadataService
    );
    expect(result).toBeNull();
  });

  it("should return null if transaction is null or metadata is incomplete", async () => {
    expect(
      await analyzeTrade(null, monitoredWallet, mockTokenMetadataService)
    ).toBeNull();

    const tx = createMockTx([monitoredWallet]);
    // @ts-ignore - Intentionally incomplete meta
    tx.meta = { preBalances: [], postBalances: [] };
    expect(
      await analyzeTrade(tx, monitoredWallet, mockTokenMetadataService)
    ).toBeNull();
  });

  it("should handle cases where monitored wallet is not in accountKeys (SOL change = 0)", async () => {
    const tx = createMockTx(
      [otherWallet], // monitoredWallet not in keys
      [],
      [],
      [5 * LAMPORTS_PER_SOL],
      [5 * LAMPORTS_PER_SOL], // Balances for otherWallet
      // preTokenBalances (monitored owns 2 WSOL and 0 TSTX)
      [
        {
          mint: WSOL_MINT,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "2000000000",
            decimals: 9,
            uiAmount: 2,
            uiAmountString: "2",
          },
        },
        {
          mint: tokenMintX,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "0",
            decimals: 9,
            uiAmount: 0,
            uiAmountString: "0",
          },
        },
      ],
      // postTokenBalances (monitored owns 1 WSOL and 50 TSTX)
      [
        {
          mint: WSOL_MINT,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "1000000000",
            decimals: 9,
            uiAmount: 1,
            uiAmountString: "1",
          },
        },
        {
          mint: tokenMintX,
          owner: monitoredWallet.toBase58(),
          uiTokenAmount: {
            amount: "50000000000",
            decimals: 9,
            uiAmount: 50,
            uiAmountString: "50",
          },
        },
      ]
    );

    // Should still detect based on WSOL change
    const result = await analyzeTrade(
      tx,
      monitoredWallet,
      mockTokenMetadataService
    );
    expect(result).not.toBeNull();
    expect(result?.type).toBe("buy");
    expect(result?.currencySymbol).toBe("WSOL"); // Should rely on WSOL
    expect(result?.currencyAmount).toBeCloseTo(1);
  });
});
