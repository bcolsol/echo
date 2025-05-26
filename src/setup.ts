import inquirer, { Answers } from "inquirer";
import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { logCritical, logInfo } from "./utils/logging";

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

const defaultSetupValues = {
  RPC_ENDPOINT: "https://api.mainnet-beta.solana.com",
  EXPLORER_URL: "https://solscan.io",
  COPY_TRADE_AMOUNT_SOL: "0.05", // Keep as string for input type
  SLIPPAGE_BPS: 2000,
  EXECUTE_TRADES: true,
  MANAGE_WITH_SLTP: true,
  TAKE_PROFIT_PERCENTAGE: 20,
  STOP_LOSS_PERCENTAGE: 10,
  PRICE_CHECK_INTERVAL_MS: 20000,
  MONITORED_WALLETS_RAW_STRING: "",
};

// --- Validation Functions ---
const validateUrl = (input: string): boolean | string =>
  input.startsWith("http://") || input.startsWith("https://")
    ? true
    : "Please enter a valid URL.";

const validatePrivateKey = (input: string): boolean | string => {
  try {
    if (input.length > 60 && input.length < 100) {
      return true;
    }
    return "Please enter a valid base58 private key (check length).";
  } catch (e) {
    return "Invalid private key format.";
  }
};

// Updated to handle string input for SOL amount and convert to number
const validateSolAmountString = (input: string): boolean | string => {
  const num = parseFloat(input);
  if (isNaN(num)) {
    return "Please enter a valid number.";
  }
  if (num <= 0) {
    return "Amount must be greater than 0.";
  }
  return true;
};

const validatePositiveNumber = (input: number): boolean | string =>
  input > 0 ? true : "Amount must be greater than 0.";

const validateNonNegativeNumber = (input: number): boolean | string =>
  input >= 0 ? true : "Value must be non-negative.";
const validateWalletAddressesString = (
  inputString: string
): boolean | string => {
  if (!inputString.trim()) {
    // Handle empty or whitespace-only input if not caught by default presence check
    return "Please enter at least one wallet address.";
  }
  const addresses = inputString
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s);
  if (addresses.length === 0 && inputString.trim().length > 0) {
    // Handles cases like "," or ", , ,"
    return "No valid wallet addresses found after parsing. Please check formatting.";
  }
  if (addresses.length === 0) {
    // Redundant if first check passes, but good for clarity
    return "Please enter at least one wallet address.";
  }
  for (const addr of addresses) {
    try {
      new PublicKey(addr);
    } catch (e) {
      return `Invalid Solana address: ${addr}. Please check the format and ensure addresses are comma-separated.`;
    }
  }
  return true;
};

const validateConditionalPositiveNumber = (
  input: number,
  answers: Answers,
  fieldName: string
): boolean | string => {
  if (!answers.MANAGE_WITH_SLTP) return true;
  return input > 0
    ? true
    : `${fieldName} must be greater than 0 when SL/TP is enabled.`;
};

export async function runSetup(): Promise<void> {
  const questions: any = [
    {
      type: "input",
      name: "RPC_ENDPOINT",
      message: "Enter your Solana RPC Endpoint URL:",
      default: defaultSetupValues.RPC_ENDPOINT,
      validate: validateUrl,
    },
    {
      type: "input",
      name: "BOT_PRIVATE_KEY",
      message: "Enter your Bot Wallet Private Key:",
      validate: validatePrivateKey,
    },
    {
      type: "input", // Changed from 'number' to 'input'
      name: "COPY_TRADE_AMOUNT_SOL",
      message:
        "Enter the amount of SOL the bot will use for EACH copy buy trade (e.g., 0.05):",
      default: defaultSetupValues.COPY_TRADE_AMOUNT_SOL.toString(), // Ensure default is a string
      validate: validateSolAmountString,
      filter: (input: string) => {
        // Convert valid string to number after validation
        const num = parseFloat(input);
        return isNaN(num) ? input : num; // Return original string if not a number, otherwise the number
      },
    },
    {
      type: "number",
      name: "SLIPPAGE_BPS",
      message:
        "Enter slippage tolerance in basis points (BPS). 100 BPS = 1% (e.g., 1000 for 10%):",
      default: defaultSetupValues.SLIPPAGE_BPS,
      validate: validateNonNegativeNumber,
    },
    {
      type: "input",
      name: "MONITORED_WALLETS_RAW_STRING",
      message: "Enter Solana wallet addresses to monitor (comma-separated):",
      default: defaultSetupValues.MONITORED_WALLETS_RAW_STRING,
      validate: validateWalletAddressesString, // Use the new validator that expects a string
      filter: (input: string) =>
        input
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s), // Filter runs after successful validation
    },
    {
      type: "confirm",
      name: "MANAGE_WITH_SLTP",
      message:
        "Enable Stop-Loss/Take-Profit (SL/TP) management for copied buys? (false for full copy mode):",
      default: defaultSetupValues.MANAGE_WITH_SLTP,
    },
    {
      type: "number",
      name: "TAKE_PROFIT_PERCENTAGE",
      message: "Enter percentage gain for take-profit (e.g., 20 for 20%):",
      default: defaultSetupValues.TAKE_PROFIT_PERCENTAGE,
      when: (answers: Answers) => answers.MANAGE_WITH_SLTP,
      validate: (input: number, answers?: Answers) =>
        validateConditionalPositiveNumber(
          input,
          answers || {},
          "Take-profit percentage"
        ),
    },
    {
      type: "number",
      name: "STOP_LOSS_PERCENTAGE",
      message: "Enter percentage loss for stop-loss (e.g., 10 for 10%):",
      default: defaultSetupValues.STOP_LOSS_PERCENTAGE,
      when: (answers: Answers) => answers.MANAGE_WITH_SLTP,
      validate: (input: number, answers?: Answers) =>
        validateConditionalPositiveNumber(
          input,
          answers || {},
          "Stop-loss percentage"
        ),
    },
    {
      type: "number",
      name: "PRICE_CHECK_INTERVAL_MS",
      message:
        "Enter interval in milliseconds to check prices for SL/TP (e.g., 60000 for 1 minute):",
      default: defaultSetupValues.PRICE_CHECK_INTERVAL_MS,
      when: (answers: Answers) => answers.MANAGE_WITH_SLTP,
      validate: (input: number, answers?: Answers) =>
        validateConditionalPositiveNumber(
          input,
          answers || {},
          "Price check interval"
        ),
    },
  ];

  const answers = await inquirer.prompt(questions);

  // Ensure COPY_TRADE_AMOUNT_SOL is a number before saving
  const copyTradeAmountSolNum = parseFloat(answers.COPY_TRADE_AMOUNT_SOL);
  if (isNaN(copyTradeAmountSolNum) || copyTradeAmountSolNum <= 0) {
    logCritical(
      "Invalid COPY_TRADE_AMOUNT_SOL provided. Setup cannot continue."
    );
    process.exit(1);
  }

  const configData: ConfigData = {
    RPC_ENDPOINT: answers.RPC_ENDPOINT,
    EXPLORER_URL: defaultSetupValues.EXPLORER_URL,
    BOT_PRIVATE_KEY: answers.BOT_PRIVATE_KEY,
    COPY_TRADE_AMOUNT_SOL: copyTradeAmountSolNum, // Use the parsed number
    SLIPPAGE_BPS: answers.SLIPPAGE_BPS,
    EXECUTE_TRADES: defaultSetupValues.EXECUTE_TRADES,
    MANAGE_WITH_SLTP: answers.MANAGE_WITH_SLTP,
    MONITORED_WALLETS_RAW: answers.MONITORED_WALLETS_RAW_STRING,
  };

  if (answers.MANAGE_WITH_SLTP) {
    configData.TAKE_PROFIT_PERCENTAGE = answers.TAKE_PROFIT_PERCENTAGE;
    configData.STOP_LOSS_PERCENTAGE = answers.STOP_LOSS_PERCENTAGE;
    configData.PRICE_CHECK_INTERVAL_MS = answers.PRICE_CHECK_INTERVAL_MS;
  } else {
    delete configData.TAKE_PROFIT_PERCENTAGE;
    delete configData.STOP_LOSS_PERCENTAGE;
    delete configData.PRICE_CHECK_INTERVAL_MS;
  }

  try {
    fs.writeFileSync(
      CONFIG_FILE_PATH,
      JSON.stringify(configData, null, 2),
      "utf-8"
    );
    logInfo(`Configuration saved to ${CONFIG_FILE_PATH}`);
    logInfo("Setup complete. You can now run 'npm start' to start the bot.");
  } catch (error) {
    logCritical(`Error saving configuration file:`, error);
    process.exit(1);
  }
}

if (require.main === module) {
  runSetup().catch((error) => {
    logCritical("Setup process failed:", error);
    process.exit(1);
  });
}
