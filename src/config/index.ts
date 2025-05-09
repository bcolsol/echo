import dotenv from "dotenv";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Commitment,
} from "@solana/web3.js";
import bs58 from "bs58";
import { logCritical, logError, logInfo, logWarn } from "../utils/logging"; // Use new loggers

// Load environment variables from .env file
dotenv.config();

// --- Essential RPC & URLs ---
const rpcEndpointEnv = process.env.RPC_ENDPOINT;
const explorerUrlEnv = process.env.EXPLORER_URL ?? "https://solscan.io"; // Default if not set

// --- Bot Wallet Configuration ---
const botPrivateKeyString = process.env.BOT_PRIVATE_KEY;

// --- Trading Parameters ---
const copyTradeAmountSOLString = process.env.COPY_TRADE_AMOUNT_SOL;
const slippageBpsString = process.env.SLIPPAGE_BPS;
const executeTradesString =
  process.env.EXECUTE_TRADES?.toLowerCase() ?? "false";
const tradeAmountSolString = copyTradeAmountSOLString;

// --- Validation ---
const missingVars: string[] = [];
if (!rpcEndpointEnv) missingVars.push("RPC_ENDPOINT");
if (!botPrivateKeyString) missingVars.push("BOT_PRIVATE_KEY");
if (!copyTradeAmountSOLString) missingVars.push("COPY_TRADE_AMOUNT_SOL");
if (!slippageBpsString) missingVars.push("SLIPPAGE_BPS");
if (!tradeAmountSolString) missingVars.push("TRADE_AMOUNT_SOL");
if (missingVars.length > 0) {
  logCritical(
    `Error: Missing required environment variables: ${missingVars.join(", ")}`
  );
  process.exit(1);
}

// --- Processed Configuration ---

// Solana/Network Config
export const RPC_ENDPOINT = rpcEndpointEnv!; // Assert non-null due to check above
export const EXPLORER_URL = explorerUrlEnv;
export const COMMITMENT_LEVEL: {
  fetch: Commitment;
  subscription: Commitment;
  confirmation: Commitment;
} = {
  fetch: "confirmed", // For getParsedTransaction
  subscription: "confirmed", // For onLogs
  confirmation: "confirmed", // For confirmTransaction
};

// Bot Wallet
let botKeypairInstance: Keypair;
try {
  const privateKeyBytes = bs58.decode(botPrivateKeyString!); // Assert non-null
  botKeypairInstance = Keypair.fromSecretKey(privateKeyBytes);
  logInfo(
    `Bot wallet loaded successfully: ${botKeypairInstance.publicKey.toBase58()}`
  );
} catch (error) {
  logCritical(`Failed to load bot keypair from BOT_PRIVATE_KEY: ${error}`);
  process.exit(1);
}
export const BOT_KEYPAIR: Keypair = botKeypairInstance;

// Trading Parameters
export const COPY_TRADE_AMOUNT_SOL = parseFloat(copyTradeAmountSOLString!); // Assert non-null
export const SLIPPAGE_BPS = parseInt(slippageBpsString!, 10); // Assert non-null
export const EXECUTE_TRADES = executeTradesString === "true"; // Explicitly control real vs. simulated trades

if (isNaN(COPY_TRADE_AMOUNT_SOL) || COPY_TRADE_AMOUNT_SOL <= 0) {
  logCritical(
    "Invalid COPY_TRADE_AMOUNT_SOL in .env file. Must be a positive number."
  );
  process.exit(1);
}

if (isNaN(SLIPPAGE_BPS) || SLIPPAGE_BPS < 0) {
  logCritical(
    "Invalid SLIPPAGE_BPS in .env file. Must be a non-negative integer."
  );
  process.exit(1);
}

export const TRADE_AMOUNT_LAMPORTS = Math.floor(
  COPY_TRADE_AMOUNT_SOL * LAMPORTS_PER_SOL
);

logInfo(
  `Trading Mode: ${EXECUTE_TRADES ? "REAL EXECUTION" : "SIMULATION ONLY"}`
);
logInfo(
  `Copy Trade Amount: ${COPY_TRADE_AMOUNT_SOL} SOL (${TRADE_AMOUNT_LAMPORTS} Lamports)`
);
logInfo(`Slippage Tolerance: ${SLIPPAGE_BPS} BPS`);

// --- Monitored Wallets ---
const monitoredWalletsRaw: string[] = [
  // Add or remove wallets here
];

export const MONITORED_WALLETS: { address: string; pubkey: PublicKey }[] = [];
for (const addr of monitoredWalletsRaw) {
  try {
    MONITORED_WALLETS.push({ address: addr, pubkey: new PublicKey(addr) });
  } catch (e) {
    logWarn(`Invalid address found in monitored list: ${addr}. Skipping.`);
  }
}

if (MONITORED_WALLETS.length === 0) {
  logError(
    "Warning: MONITORED_WALLETS list is empty or contains only invalid addresses. The bot won't copy any trades."
  );
  // Decide if you want to exit(1) here or let it run without monitoring
  process.exit(1);
} else {
  logInfo(`Monitoring ${MONITORED_WALLETS.length} wallets.`);
}

// --- DEX & Token Constants ---
export const DEX_PROGRAM_IDS: Set<string> = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirpools
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY", // Phoenix Trade
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium AMM V4 (CPMM)
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM V4 (CLMM)
]);

export const WSOL_MINT = "So11111111111111111111111111111111111111112"; // Wrapped SOL mint address
export const WSOL_INFO = {
  // Pre-define WSOL info
  symbol: "SOL", // Use SOL symbol for consistency, even though it's WSOL mint
  name: "Wrapped SOL",
  decimals: 9,
  metadataFetched: true, // Mark as fetched since we know it
};

// --- Jupiter API ---
// Moved URL definitions here for central configuration
export const JUPITER_STRICT_TOKEN_LIST_URL = "https://token.jup.ag/strict";
export const JUPITER_QUOTE_API_URL = "https://quote-api.jup.ag/v6/quote";
export const JUPITER_SWAP_API_URL = "https://quote-api.jup.ag/v6/swap";

logInfo("Configuration loaded successfully.");

// Ensure WebSocket polyfill if needed (Keep the original check logic)
if (typeof window === "undefined") {
  try {
    const WebSocket = require("ws");
    // @ts-ignore
    global.WebSocket = WebSocket;
    logInfo("Applied WebSocket polyfill for Node.js environment.");
  } catch (err) {
    logWarn(
      "Could not load 'ws' module for WebSocket polyfill. Ensure it's installed if running in Node.js older versions or specific environments."
    );
  }
}
