// src/config/index.ts
import fs from "fs";
import path from "path";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Commitment,
} from "@solana/web3.js";
import bs58 from "bs58";
import { logCritical, logError, logInfo, logWarn } from "../utils/logging";

const CONFIG_FILE_PATH = path.join(process.cwd(), "config.json");

interface ConfigData {
  RPC_ENDPOINT: string;
  EXPLORER_URL?: string;
  BOT_PRIVATE_KEY: string;
  COPY_TRADE_AMOUNT_SOL: number;
  SLIPPAGE_BPS: number;
  EXECUTE_TRADES: boolean;
  MANAGE_WITH_SLTP: boolean;
  TAKE_PROFIT_PERCENTAGE?: number;
  STOP_LOSS_PERCENTAGE?: number;
  PRICE_CHECK_INTERVAL_MS?: number;
  MONITORED_WALLETS_RAW: string[];
}

let configData: ConfigData;

if (!fs.existsSync(CONFIG_FILE_PATH)) {
  logCritical(`Configuration file not found at ${CONFIG_FILE_PATH}.`);
  logCritical(`Please run 'npm run setup' to generate the configuration file.`);
  process.exit(1);
}

try {
  const fileContent = fs.readFileSync(CONFIG_FILE_PATH, "utf-8");
  configData = JSON.parse(fileContent) as ConfigData;
} catch (error: any) {
  logCritical(
    `Failed to parse configuration from ${CONFIG_FILE_PATH}: ${error.message}`
  );
  logCritical(
    "Please ensure config.json is valid or run 'npm run setup' again."
  );
  process.exit(1);
}

// --- Essential RPC & URLs ---
const rpcEndpointEnv = configData.RPC_ENDPOINT;
const explorerUrlEnv = configData.EXPLORER_URL ?? "https://solscan.io";

// --- Bot Wallet Configuration ---
const botPrivateKeyString = configData.BOT_PRIVATE_KEY;

// --- Trading Parameters ---
const copyTradeAmountSOLString = configData.COPY_TRADE_AMOUNT_SOL?.toString();
const slippageBpsString = configData.SLIPPAGE_BPS?.toString();
const executeTradesString = configData.EXECUTE_TRADES?.toString() ?? "false";

// --- SL/TP Configuration ---
const manageWithSLTPString = configData.MANAGE_WITH_SLTP?.toString() ?? "false";
const takeProfitPercentageString =
  configData.TAKE_PROFIT_PERCENTAGE?.toString();
const stopLossPercentageString = configData.STOP_LOSS_PERCENTAGE?.toString();
const priceCheckIntervalMsString =
  configData.PRICE_CHECK_INTERVAL_MS?.toString();

// --- Monitored Wallets from config.json ---
const monitoredWalletsRaw: string[] = configData.MONITORED_WALLETS_RAW || [];

// --- Validation ---
const missingVars: string[] = [];
if (!rpcEndpointEnv) missingVars.push("RPC_ENDPOINT");
if (!botPrivateKeyString) missingVars.push("BOT_PRIVATE_KEY");
if (copyTradeAmountSOLString === undefined)
  missingVars.push("COPY_TRADE_AMOUNT_SOL");
if (slippageBpsString === undefined) missingVars.push("SLIPPAGE_BPS");

if (manageWithSLTPString === "true") {
  if (takeProfitPercentageString === undefined)
    missingVars.push("TAKE_PROFIT_PERCENTAGE");
  if (stopLossPercentageString === undefined)
    missingVars.push("STOP_LOSS_PERCENTAGE");
  if (priceCheckIntervalMsString === undefined)
    missingVars.push("PRICE_CHECK_INTERVAL_MS");
}

if (monitoredWalletsRaw.length === 0) {
  missingVars.push("MONITORED_WALLETS_RAW (must not be empty in config.json)");
}

if (missingVars.length > 0) {
  logCritical(
    `Error: Missing or invalid required fields in config.json: ${missingVars.join(
      ", "
    )}.`
  );
  logCritical("Please run 'npm run setup' or fix config.json.");
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

let botKeypairInstance: Keypair;
try {
  const privateKeyBytes = bs58.decode(botPrivateKeyString!);
  botKeypairInstance = Keypair.fromSecretKey(privateKeyBytes);
  logInfo(
    `Bot wallet loaded successfully: ${botKeypairInstance.publicKey.toBase58()}`
  );
} catch (error) {
  logCritical(
    `Failed to load bot keypair from BOT_PRIVATE_KEY in config.json: ${error}`
  );
  process.exit(1);
}
export const BOT_KEYPAIR: Keypair = botKeypairInstance;

// Trading Parameters
export const COPY_TRADE_AMOUNT_SOL = parseFloat(copyTradeAmountSOLString!);
export const SLIPPAGE_BPS = parseInt(slippageBpsString!, 10);
export const EXECUTE_TRADES = executeTradesString === "true";

if (isNaN(COPY_TRADE_AMOUNT_SOL) || COPY_TRADE_AMOUNT_SOL <= 0) {
  logCritical(
    "Invalid COPY_TRADE_AMOUNT_SOL in config.json. Must be a positive number."
  );
  process.exit(1);
}

if (isNaN(SLIPPAGE_BPS) || SLIPPAGE_BPS < 0) {
  logCritical(
    "Invalid SLIPPAGE_BPS in config.json. Must be a non-negative integer."
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

// SL/TP Parameters
export const MANAGE_WITH_SLTP = manageWithSLTPString === "true";
export let TAKE_PROFIT_PERCENTAGE = 0;
export let STOP_LOSS_PERCENTAGE = 0;
export let PRICE_CHECK_INTERVAL_MS = 60000;

if (MANAGE_WITH_SLTP) {
  TAKE_PROFIT_PERCENTAGE = parseFloat(takeProfitPercentageString!);
  STOP_LOSS_PERCENTAGE = parseFloat(stopLossPercentageString!);
  PRICE_CHECK_INTERVAL_MS = parseInt(priceCheckIntervalMsString!, 10);

  if (isNaN(TAKE_PROFIT_PERCENTAGE) || TAKE_PROFIT_PERCENTAGE <= 0) {
    logCritical(
      "Invalid TAKE_PROFIT_PERCENTAGE in config.json. Must be a positive number."
    );
    process.exit(1);
  }
  if (isNaN(STOP_LOSS_PERCENTAGE) || STOP_LOSS_PERCENTAGE <= 0) {
    logCritical(
      "Invalid STOP_LOSS_PERCENTAGE in config.json. Must be a positive number."
    );
    process.exit(1);
  }
  if (isNaN(PRICE_CHECK_INTERVAL_MS) || PRICE_CHECK_INTERVAL_MS <= 0) {
    logCritical(
      "Invalid PRICE_CHECK_INTERVAL_MS in config.json. Must be a positive integer."
    );
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
export const MONITORED_WALLETS: { address: string; pubkey: PublicKey }[] = [];
for (const addr of monitoredWalletsRaw) {
  try {
    MONITORED_WALLETS.push({ address: addr, pubkey: new PublicKey(addr) });
  } catch (e) {
    logWarn(
      `Invalid address found in monitored list in config.json: ${addr}. Skipping.`
    );
  }
}

if (MONITORED_WALLETS.length === 0 && monitoredWalletsRaw.length > 0) {
  // Check if some were provided but all were invalid
  logError(
    "MONITORED_WALLETS_RAW in config.json contains only invalid addresses. The bot won't copy any trades."
  );
  process.exit(1);
} else if (monitoredWalletsRaw.length === 0) {
  // This should have been caught by missingVars earlier
  logError(
    "MONITORED_WALLETS_RAW is empty in config.json. Please add wallets to monitor via 'npm run setup'."
  );
  process.exit(1);
} else {
  logInfo(`Monitoring ${MONITORED_WALLETS.length} wallets from config.json.`);
}

// --- DEX & Token Constants ---
export const DEX_PROGRAM_IDS: Set<string> = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirpools
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY", // Phoenix Trade
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium AMM V4 (CPMM)
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM V4 (CLMM)
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // RAydium concetrated liquiduty
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", //Meteora
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", //Meteora pools program
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

logInfo("Configuration loaded successfully from config.json.");

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
