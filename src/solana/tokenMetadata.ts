import { Connection, PublicKey } from "@solana/web3.js";
import { Metaplex } from "@metaplex-foundation/js";
import { TokenInfo } from "../types";
import { JUPITER_STRICT_TOKEN_LIST_URL, WSOL_INFO, WSOL_MINT } from "../config";
import { logError, logInfo, logWarn } from "../utils/logging";

/**
 * Service responsible for fetching and caching SPL token metadata.
 * Uses a combination of Jupiter's strict list and Metaplex on-chain data.
 */
export class TokenMetadataService {
  private readonly connection: Connection;
  private readonly metaplex: Metaplex;
  private readonly tokenInfoCache = new Map<string, TokenInfo | null>(); // Cache includes null for known fetch failures
  private readonly jupiterTokenListUrl: string;

  /**
   * Creates an instance of TokenMetadataService.
   * @param connection The Solana Connection object.
   * @param metaplex The Metaplex instance.
   * @param jupiterTokenListUrl The URL for Jupiter's strict token list.
   */
  constructor(
    connection: Connection,
    metaplex: Metaplex,
    jupiterTokenListUrl: string = JUPITER_STRICT_TOKEN_LIST_URL
  ) {
    this.connection = connection;
    this.metaplex = metaplex;
    this.jupiterTokenListUrl = jupiterTokenListUrl;

    // Pre-populate cache with WSOL info
    this.tokenInfoCache.set(WSOL_MINT, WSOL_INFO);
  }

  /**
   * Initializes the token cache by fetching data from the Jupiter token list.
   */
  async initializeTokenMap(): Promise<void> {
    try {
      const response = await fetch(this.jupiterTokenListUrl);

      if (!response.ok) {
        logWarn(
          `Failed to fetch token list from Jupiter: ${response.statusText} (${response.status}). Cache will rely on on-chain data.`
        );
        return;
      }

      // Explicitly type the expected structure
      const data: {
        address: string;
        symbol: string;
        name: string;
        decimals: number;
        logoURI?: string;
      }[] = (await response.json()) as any;

      let count = 0;
      data.forEach((token) => {
        if (
          token.address &&
          token.symbol &&
          token.name &&
          token.decimals !== undefined &&
          !this.tokenInfoCache.has(token.address) // Avoid overwriting WSOL or already cached items
        ) {
          this.tokenInfoCache.set(token.address, {
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            metadataFetched: true, // Mark as fetched from list
            logo: token.logoURI,
          });
          count++;
        }
      });
    } catch (error) {
      logError("Error initializing token map from Jupiter:", error);
    }
  }

  /**
   * Creates a default placeholder TokenInfo object for a mint.
   * @param mintAddress The mint address string.
   * @returns A default TokenInfo object.
   */
  private createDefaultTokenInfo(mintAddress: string): TokenInfo {
    return {
      symbol: `UNKNOWN (${mintAddress.substring(0, 4)}...)`,
      name: "Unknown Token",
      decimals: 6, // Default assumption, might be inaccurate
      metadataFetched: false, // Indicates this is a default fallback
    };
  }

  /**
   * Retrieves token information for a given mint address.
   * Prioritizes cache, then falls back to fetching from Metaplex/RPC.
   * Caches results, including failures (as null) to prevent repeated failed fetches.
   * @param mintAddress The mint address string.
   * @returns A Promise resolving to the TokenInfo.
   */
  async getTokenInfo(mintAddress: string): Promise<TokenInfo> {
    // 1. Check cache
    if (this.tokenInfoCache.has(mintAddress)) {
      const cached = this.tokenInfoCache.get(mintAddress);
      // Return cached info if found, or default if fetch previously failed (null)
      return cached ? cached : this.createDefaultTokenInfo(mintAddress);
    }

    // 2. Fetch from Metaplex & RPC if not in cache
    try {
      const mintPublicKey = new PublicKey(mintAddress);

      // Fetch Metaplex data (name, symbol, image)
      const token = await this.metaplex
        .nfts()
        .findByMint({ mintAddress: mintPublicKey });

      // Fetch decimals separately (more reliable source often)
      let decimals = 6; // Default before fetching
      try {
        const mintInfo = await this.connection.getParsedAccountInfo(
          mintPublicKey
        );
        if (
          mintInfo.value?.data &&
          typeof mintInfo.value.data === "object" && // Check if it's ParsedAccountData
          "parsed" in mintInfo.value.data &&
          typeof mintInfo.value.data.parsed === "object" &&
          mintInfo.value.data.parsed?.info &&
          typeof mintInfo.value.data.parsed.info === "object" &&
          "decimals" in mintInfo.value.data.parsed.info &&
          typeof mintInfo.value.data.parsed.info.decimals === "number"
        ) {
          decimals = mintInfo.value.data.parsed.info.decimals;
        } else {
          logWarn(
            `[Metadata] Could not parse decimals for ${mintAddress} from getParsedAccountInfo response.`
          );
        }
      } catch (decimErr) {
        logWarn(
          `[Metadata] WARN: Failed to fetch decimals via getParsedAccountInfo for ${
            token?.symbol ?? mintAddress
          }:`,
          decimErr
        );
      }

      const fetchedInfo: TokenInfo = {
        symbol: token.symbol ?? `UNNAMED (${mintAddress.substring(0, 4)}...)`,
        name: token.name ?? "Unnamed Token",
        decimals: decimals,
        // Safely access potential logo/image URIs
        logo: (token.json?.image || token.json?.logoURI) as string,
        metadataFetched: true, // Mark as successfully fetched
      };

      this.tokenInfoCache.set(mintAddress, fetchedInfo); // Cache success
      return fetchedInfo;
    } catch (error: any) {
      logWarn(
        `[Metadata] WARN: Could not fetch full metadata for ${mintAddress}: ${error.message}`
      );
      // Cache failure as null to prevent repeated attempts for this session
      this.tokenInfoCache.set(mintAddress, null);
      return this.createDefaultTokenInfo(mintAddress); // Return default on error
    }
  }
}
