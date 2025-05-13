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
// const tradeAmountSolString = copyTradeAmountSOLString; // Already have copyTradeAmountSOLString

// --- SL/TP Configuration ---
const manageWithSLTPString =
  process.env.MANAGE_WITH_SLTP?.toLowerCase() ?? "false";
const takeProfitPercentageString = process.env.TAKE_PROFIT_PERCENTAGE;
const stopLossPercentageString = process.env.STOP_LOSS_PERCENTAGE;
const priceCheckIntervalMsString = process.env.PRICE_CHECK_INTERVAL_MS;

// --- Validation ---
const missingVars: string[] = [];
if (!rpcEndpointEnv) missingVars.push("RPC_ENDPOINT");
if (!botPrivateKeyString) missingVars.push("BOT_PRIVATE_KEY");
if (!copyTradeAmountSOLString) missingVars.push("COPY_TRADE_AMOUNT_SOL");
if (!slippageBpsString) missingVars.push("SLIPPAGE_BPS");
// if (!tradeAmountSolString) missingVars.push("TRADE_AMOUNT_SOL"); // Covered by copyTradeAmountSOLString

// Validate SL/TP vars only if MANAGE_WITH_SLTP is true
if (manageWithSLTPString === "true") {
  if (!takeProfitPercentageString) missingVars.push("TAKE_PROFIT_PERCENTAGE");
  if (!stopLossPercentageString) missingVars.push("STOP_LOSS_PERCENTAGE");
  if (!priceCheckIntervalMsString) missingVars.push("PRICE_CHECK_INTERVAL_MS");
}

if (missingVars.length > 0) {
  logCritical(
    `Error: Missing required environment variables: ${missingVars.join(", ")}`
  );
  process.exit(1);
}

// --- Processed Configuration ---

// Solana/Network Config
export const RPC_ENDPOINT = rpcEndpointEnv!;
export const EXPLORER_URL = explorerUrlEnv;
export const COMMITMENT_LEVEL: {
  fetch: Commitment;
  subscription: Commitment;
  confirmation: Commitment;
} = {
  fetch: "confirmed",
  subscription: "confirmed",
  confirmation: "confirmed",
};

// Bot Wallet
let botKeypairInstance: Keypair;
try {
  const privateKeyBytes = bs58.decode(botPrivateKeyString!);
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
export const COPY_TRADE_AMOUNT_SOL = parseFloat(copyTradeAmountSOLString!);
export const SLIPPAGE_BPS = parseInt(slippageBpsString!, 10);
export const EXECUTE_TRADES = executeTradesString === "true";

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
  // This remains the default for copy buys
  COPY_TRADE_AMOUNT_SOL * LAMPORTS_PER_SOL
);

logInfo(
  `Trading Mode: ${EXECUTE_TRADES ? "REAL EXECUTION" : "SIMULATION ONLY"}`
);
logInfo(
  `Copy Trade Amount: ${COPY_TRADE_AMOUNT_SOL} SOL (${TRADE_AMOUNT_LAMPORTS} Lamports)`
);
logInfo(`Slippage Tolerance: ${SLIPPAGE_BPS} BPS`);

// SL/TP Parameters
export const MANAGE_WITH_SLTP = manageWithSLTPString === "true";
export let TAKE_PROFIT_PERCENTAGE = 0;
export let STOP_LOSS_PERCENTAGE = 0;
export let PRICE_CHECK_INTERVAL_MS = 60000; // Default to 1 minute

if (MANAGE_WITH_SLTP) {
  TAKE_PROFIT_PERCENTAGE = parseFloat(takeProfitPercentageString!);
  STOP_LOSS_PERCENTAGE = parseFloat(stopLossPercentageString!);
  PRICE_CHECK_INTERVAL_MS = parseInt(priceCheckIntervalMsString!, 10);

  if (isNaN(TAKE_PROFIT_PERCENTAGE) || TAKE_PROFIT_PERCENTAGE <= 0) {
    logCritical("Invalid TAKE_PROFIT_PERCENTAGE. Must be a positive number.");
    process.exit(1);
  }
  if (isNaN(STOP_LOSS_PERCENTAGE) || STOP_LOSS_PERCENTAGE <= 0) {
    logCritical("Invalid STOP_LOSS_PERCENTAGE. Must be a positive number.");
    process.exit(1);
  }
  if (isNaN(PRICE_CHECK_INTERVAL_MS) || PRICE_CHECK_INTERVAL_MS <= 0) {
    logCritical("Invalid PRICE_CHECK_INTERVAL_MS. Must be a positive integer.");
    process.exit(1);
  }
  logInfo(`Stop-Loss/Take-Profit Management: ENABLED`);
  logInfo(`  Take Profit At: +${TAKE_PROFIT_PERCENTAGE}%`);
  logInfo(`  Stop Loss At: -${STOP_LOSS_PERCENTAGE}%`);
  logInfo(`  Price Check Interval: ${PRICE_CHECK_INTERVAL_MS}ms`);
} else {
  logInfo(`Stop-Loss/Take-Profit Management: DISABLED (Full Copy Mode)`);
}

// --- Monitored Wallets ---
const monitoredWalletsRaw: string[] = [
  "7xBiwdgBKaE7r4HMZ42qssvZ8yP936vuLNDrkvBAaAkV",
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

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const WSOL_INFO = {
  symbol: "SOL",
  name: "Wrapped SOL",
  decimals: 9,
  metadataFetched: true,
};

// --- Jupiter API ---
export const JUPITER_STRICT_TOKEN_LIST_URL = "https://token.jup.ag/strict";
export const JUPITER_QUOTE_API_URL = "https://quote-api.jup.ag/v6/quote";
export const JUPITER_SWAP_API_URL = "https://quote-api.jup.ag/v6/swap";

logInfo("Configuration loaded successfully.");

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
