# Echo - Solana copy trading bot

## [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🚨 IMPORTANT DISCLAIMERS 🚨

- **⚠️ Ongoing Development:** This project is currently under **heavy development**. Expect bugs, breaking changes, and incomplete features. **DO NOT use with significant funds.**
- **⚠️ Financial Risk:** This bot executes trades automatically based on its configuration and the actions of wallets it monitors. You are solely responsible for any financial losses incurred. **Use at your own risk.**
- **⚠️ Security Risk:** You need to provide your bot wallet's private key in the `.env` file. Handle this file with extreme care. Anyone gaining access to it can control your bot's funds. It is strongly recommended to use a **dedicated bot wallet** funded only with the amount you are willing to risk.
- **⚠️ Scam Warning:** The crypto space is full of scams.
  - **Only use code from the official `main` branch** of this repository. Be extremely cautious of code from other branches or forks unless you have verified it yourself.
  - **Verify the code:** Since this is open source, take the time to understand what the code does before running it.
  - **Beware of impersonators:** Be wary of anyone contacting you claiming to be a developer or offering paid support, especially if they ask for funds or private keys. Official communication channel is on [discord](https://discord.gg/AHdWVrKB)

---

## Introduction

As a trader, I got tired of bot fees eating into my profits. So I built my own copy trading bot, simple, free, and fully under my control.

Now I am open-sourcing it, not just to build trust, but to invite collaboration. If you are a trader, builder, or just curious, jump in. Let's improve it together and build tools that actually work for us.

## Use cases

Echo is designed to be relatively fast, typically taking 1-2 seconds from detecting a trade by a monitored wallet to its own trade being confirmed. Having said this, it's important to understand its intended use:

- **Best For:** Copy trading on more established or moderately volatile tokens where a 1-2 second reaction time is acceptable. It's also well-suited for managing positions with Stop-Loss/Take-Profit on these types of coins.
- **Not Ideal For:** Trying to snipe brand new, highly volatile memecoin launches where every millisecond is critical to get in at the absolute earliest possible moment. For such cases, specialized sniping bots with different architectures are required.

Echo prioritizes reliable trade replication using Jupiter API

## How Echo Works: From Detection to Trade

When Echo is set up to monitor a wallet, here's the general process it follows to copy a trade or manage a position:

### Operating Modes

Echo has two main modes, set by the `MANAGE_WITH_SLTP` variable in your `.env` configuration file:

1.  **Full Copy Mode (`MANAGE_WITH_SLTP=false`):**
    - The bot copies both buys and sells from the monitored wallet. If the target buys, Echo buys. If the target sells a token Echo holds (from a previous copy), Echo sells its entire position of that token.
2.  **Buy & Manage Mode (`MANAGE_WITH_SLTP=true`):**
    - Echo copies buys from the monitored wallet and records the purchase price of the acquired tokens.
    - It then ignores sell signals from the monitored wallet for these holdings. Instead, it uses its own Stop-Loss (SL) and Take-Profit (TP) logic. If the price of a held token reaches the pre-defined SL or TP percentage levels, Echo will sell the entire position.

### The Trade Execution Pipeline

Here's a breakdown of the steps involved when Echo decides to make a trade:

1.  **Trade Detection (via `WalletMonitor`):**

    - **Log Monitoring:** Echo listens for new transaction logs from the wallets you're monitoring. This relies on your Solana RPC node to deliver these logs once transactions reach a `confirmed` state.
    - **Transaction Retrieval:** Once a relevant log signature is found, the bot fetches the complete transaction data using `getParsedTransaction`.

2.  **Trade Analysis (via `analyzeTrade`):**

    - **DEX Check:** It confirms the transaction involves a known DEX (Decentralized Exchange).
    - **Details Extraction:** It analyzes the transaction to see what token was traded, the amounts, and the direction (buy/sell). Token metadata (like symbol and decimals) is also retrieved, using a cache first, then on-chain Metaplex data if needed.

3.  **Quoting & Swap Preparation (via `TradeExecutor` with Jupiter API):**

    - **Get Quote (`getJupiterQuote`):** Echo requests a swap quote from Jupiter's V6 API.
      - For buys: Quoting SOL/WSOL to the target token, using the bot's configured `COPY_TRADE_AMOUNT_SOL`.
      - For sells (either copy-sells or SL/TP-triggered sells): Quoting the entire held amount of the target token to SOL/WSOL.
    - **Get Swap Transaction (`getJupiterSwap`):** If the quote is acceptable, Echo gets the serialized transaction data from Jupiter needed to execute that swap.
    - _Note: These are network calls to Jupiter's API, so their speed depends on API responsiveness and your internet connection._

4.  **Local Transaction Processing:**

    - **Signing:** The transaction data from Jupiter is deserialized, and the bot signs it with its own wallet's private key. This is a fast, local operation.

5.  **Execution & Confirmation (via `SolanaClient`):**
    - **Broadcasting (`sendRawTransaction`):** The signed transaction is sent to your Solana RPC node, which then tries to get it to the current Solana network leader. The `skipPreflight: true` option is used to submit it without an initial client-side simulation, potentially saving a little time.
    - **Waiting for Confirmation (`confirmTransaction`):** The bot waits for the transaction to be confirmed on the Solana network to the specified commitment level. The time this takes is influenced by network congestion and the use (or absence) of priority fees.

### Stop-Loss/Take-Profit Monitoring (If `MANAGE_WITH_SLTP=true`)

- A separate process runs at an interval defined by `PRICE_CHECK_INTERVAL_MS` in your configuration.
- This loop iterates through all tokens the bot currently holds for which a purchase price has been recorded.
- For each of these tokens, it fetches the current market price by requesting a quote from Jupiter (Token -> WSOL for the entire held amount).
- If the current price meets the configured Stop-Loss or Take-Profit percentage relative to its recorded average purchase price, the bot will trigger a sell of the entire position for that token via the `TradeExecutor`.

## ✨ Current Features (MVP)

- **Wallet Monitoring:** Listens to transactions involving specified Solana wallets.
- **DEX Interaction Filter:** Identifies transactions involving swaps on major Solana DEXs.
- **Copy Buy Logic:** Detects SOL/WSOL -> Token swaps by monitored wallets and executes a corresponding buy trade using the bot's wallet.
  - Uses a **fixed SOL amount** (configurable in `.env`) for buys.
  - Uses the **Jupiter API (v6)** for trade quoting and execution.
- **Copy Sell Logic:** Detects Token -> SOL/WSOL swaps by monitored wallets.
  - If the bot holds that specific token (because it previously copied a buy triggered by the _same_ wallet), it sells the **entire** bot's position for that token.
  - Also uses the **Jupiter API (v6)** for sell quotes and execution.
- **SL/TP Management:** Manages stop-loss and take-profit levels for copied buys.
- **Basic State Persistence:** Remembers which tokens the bot bought (and the trigger wallet) using a local `bot_holdings.json` file, allowing sell logic to function across restarts.
- **Simulation Mode:** Run the bot without executing real trades (`EXECUTE_TRADES=false` in `.env`). Right now this is best used for development only, but in the future this can be potentialy extended to simulate trades and see profit/loss without trading
- **Basic Logging:** Outputs information about detected trades, API calls, and execution/simulation results to the console.

## 🚀 Upcoming Features (Roadmap)

This project is actively evolving. Here are some of the features planned for the near future (priorities may shift based on community feedback):

1.  **Dynamic Buy Amount:** Option to configure the bot to copy a percentage of the monitored wallet's trade size (with a configurable cap) instead of always using a fixed SOL amount.
2.  **Basic Token Vetting:** Before copying a buy, perform checks (e.g., query Jupiter for basic liquidity/existence) to avoid trading highly illiquid or potentially scam tokens.
3.  **Enhanced Error Handling & Retries:** Make the bot more resilient to temporary RPC or Jupiter API errors.
4.  **Structured Logging:** Implement a proper logging library (like Pino or Winston) for leveled, structured logging (JSON).
5.  **Docker Support:** Implement docker support for easier install/usage

## ⚙️ Setup & Configuration

### Not a developer? Join our [discord](https://discord.gg/AHdWVrKB) to get help with setting up the bot.

Follow these steps to set up and run the bot:

**1. Prerequisites:**

- **Node.js:** Version 18.x or higher recommended (check with `node -v`).
- **npm** or **yarn:** Package manager for Node.js.

**2. Installation:**

- Clone the repository:
  ```bash
  git clone [https://github.com/bcolsol/echo.git](https://github.com/bcolsol/echo.git)
  cd echo
  ```
- Install dependencies:
  ```bash
  npm install
  ```

**3. Configuration (`.env` file):**

- Create a `.env` file in the root directory of the project. You can copy the example:
  ```bash
  cp .env.example .env
  ```
- **Edit the `.env` file** and provide the following values:

  ```dotenv
  # Required Environment Variables

  # Your Solana RPC Endpoint (e.g., from QuickNode, Helius, Triton, Shyft, Ankr, or public)
  # example: RPC_ENDPOINT="https://mainnet.helius-rpc.com/?api-key=fjfkkf424hk
  RPC_ENDPOINT=YOUR_SOLANA_RPC_ENDPOINT

  # PRIVATE KEY of the wallet the BOT will use for trading.
  # IMPORTANT: Use a dedicated burner wallet with limited funds!
  BOT_PRIVATE_KEY=YOUR_BOT_WALLET_PRIVATE_KEY_BASE58

  # Amount of SOL the bot will use for EACH copy buy trade.
  COPY_TRADE_AMOUNT_SOL=0.1

  # Slippage tolerance in basis points (BPS). 100 BPS = 1%. (e.g., 10000 = 10%)
  SLIPPAGE_BPS=1000

  # Set to "true" to execute REAL trades, "false" to only SIMULATE.
  # Simulate is mostly used for development
  EXECUTE_TRADES=true

  # Set to "true" to enable SL/TP management for copied buys, "false" for full # copy mode.
  MANAGE_WITH_SLTP=false
  # Percentage gain for take-profit (e.g., 20 for 20%). Required if MANAGE_WITH_SLTP=true.
  TAKE_PROFIT_PERCENTAGE=20
  # Percentage loss for stop-loss (e.g., 10 for 10%). Required if MANAGE_WITH_SLTP=true.
  STOP_LOSS_PERCENTAGE=10
  # Interval in milliseconds to check prices for SL/TP (e.g., 60000 for 1  minute). Required if MANAGE_WITH_SLTP=true.
  PRICE_CHECK_INTERVAL_MS=60000
  ```

**4. Setting up wallets to track**

Add public keys of wallets you want to monitor in `monitoredWalletsRaw` array in `src/config/index.ts`
example:

```
const monitoredWalletsRaw: string[] = [
  "7xBiwdgBKaE7r4HMZ42qssvZ8yP936vuLNDrkvBAaBkV",
  // Add or remove wallets here
];
```

The bot will start, load any existing holdings from `bot_holdings.json`, initialize subscriptions for the wallets defined in `src/config/index.ts` (you can modify the `MONITORED_WALLETS` array there), and begin monitoring/trading based on your `EXECUTE_TRADES` setting.

**5. Running the Bot:**

- **Run**
  ```bash
  npm start
  ```

The bot will start, load any existing holdings from `bot_holdings.json`, initialize subscriptions for the wallets defined in `src/config/index.ts`, and begin monitoring/trading based on your `EXECUTE_TRADES` setting.

- Press `CTRL+C` to stop the bot gracefully (it will attempt to save state before exiting).

## 🤝 Contributing

Contributions are welcome! Whether it's reporting a bug, suggesting a feature, improving documentation, or submitting code changes, your help is appreciated.

- **Bug Reports & Feature Requests:** Please use the GitHub Issues tab. Provide as much detail as possible.
- **Code Contributions:**
  Still coming up with a proper plan for code contributions.

## 📄 License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.

## 💬 Community & Support

Join our community to discuss the bot, ask questions, share trading strategies, or get support:

- **[Discord](https://discord.gg/AHdWVrKB)**
