import { Connection } from "@solana/web3.js";
import { RPC_ENDPOINT, COMMITMENT_LEVEL } from "../config";
import { logInfo } from "../utils/logging";

/**
 * The primary Solana Connection object used throughout the application.
 */
export const connection = new Connection(RPC_ENDPOINT, {
  commitment: COMMITMENT_LEVEL.fetch, // Default commitment for reads
  // Disable transaction confirmation checks here if you handle retries/timeouts manually elsewhere
  // disableRetryOnRateLimit: true,
});
