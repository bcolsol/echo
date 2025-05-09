# Echo - Solana copy trading bot

## [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🚨 IMPORTANT DISCLAIMERS 🚨

- **⚠️ Heavy Development:** This project is currently a Minimum Viable Product (MVP) and is under **heavy development**. Expect bugs, breaking changes, and incomplete features. **DO NOT use with significant funds.**
- **⚠️ Financial Risk:** This bot executes trades automatically based on its configuration and the actions of wallets it monitors. You are solely responsible for any financial losses incurred. **Use at your own risk.**
- **⚠️ Security Risk:** You need to provide your bot wallet's private key in the `.env` file. Handle this file with extreme care. Anyone gaining access to it can control your bot's funds. It is strongly recommended to use a **dedicated bot wallet** funded only with the amount you are willing to risk.
- **⚠️ Scam Warning:** The crypto space is full of scams.
  - **Only use code from the official `main` branch** of this repository. Be extremely cautious of code from other branches or forks unless you have verified it yourself.
  - **Verify the code:** Since this is open source, take the time to understand what the code does before running it.
  - **Beware of impersonators:** Be wary of anyone contacting you claiming to be a developer or offering paid support, especially if they ask for funds or private keys. Official communication channels will be listed below.

---

## Introduction

As a trader myself, I got sick of using trade and copy trade bots where fees eat up any profit I made. That’s how this project was born.

**Why Open Source?**

In this space, trust is everything.

**Transparency**: The code is fully public. You can see exactly how it works, no surprises, no shady stuff.

**No Fees**: Since the bot runs locally, you dont pay any fees like you would with most closed bots.

## ✨ Current Features (MVP)

- **Wallet Monitoring:** Listens to transactions involving specified Solana wallets.
- **DEX Interaction Filter:** Identifies transactions involving swaps on major Solana DEXs.
- **Copy Buy Logic:** Detects SOL/WSOL -> Token swaps by monitored wallets and executes a corresponding buy trade using the bot's wallet.
  - Uses a **fixed SOL amount** (configurable in `.env`) for buys.
  - Leverages the **Jupiter API (v6)** for trade quoting and execution.
- **Copy Sell Logic:** Detects Token -> SOL/WSOL swaps by monitored wallets.
  - If the bot holds that specific token (because it previously copied a buy triggered by the _same_ wallet), it sells the **entire** bot's position for that token.
  - Also uses the **Jupiter API (v6)** for sell quotes and execution.
- **Basic State Persistence:** Remembers which tokens the bot bought (and the trigger wallet) using a local `bot_holdings.json` file, allowing sell logic to function across restarts.
- **Simulation Mode:** Run the bot without executing real trades (`EXECUTE_TRADES=false` in `.env`). Right now this is best used for development only, but in the future this can be potentialy extended to simulate trades and see profit/loss without trading
- **Basic Logging:** Outputs information about detected trades, API calls, and execution/simulation results to the console.

## 🚀 Upcoming Features (Roadmap)

This project is actively evolving. Here are some of the features planned for the near future (priorities may shift based on feedback):

1.  **Dynamic Buy Amount:** Option to configure the bot to copy a percentage of the monitored wallet's trade size (with a configurable cap) instead of always using a fixed SOL amount.
2.  **Take Profit / Stop Loss Options:** Introduce an alternative sell mechanism where the bot monitors the price of its holdings and sells based on configurable percentage gains (TP) or losses (SL), requiring price feed integration (likely via Jupiter initially).
3.  **Basic Token Vetting:** Before copying a buy, perform checks (e.g., query Jupiter for basic liquidity/existence) to avoid trading highly illiquid or potentially scam tokens.
4.  **Enhanced Error Handling & Retries:** Make the bot more resilient to temporary RPC or Jupiter API errors.
5.  **Structured Logging:** Implement a proper logging library (like Pino or Winston) for leveled, structured logging (JSON).
6.  **Docker Support:** Implement docker support for easier install/usage

## ⚙️ Setup & Configuration

Follow these steps to set up and run the bot:

**1. Prerequisites:**

- **Node.js:** Version 18.x or higher recommended (check with `node -v`).
- **npm** or **yarn:** Package manager for Node.js.

**2. Installation:**

- Clone the repository:
  ```bash
  git clone [https://github.com/bcolsol/echo.git](https://github.com/bcolsol/echo.git) # Replace with your repo URL
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

Join our community to discuss the bot, ask questions, share strategies, and get support:

- **Discord:** coming soon
- **Telegram:** coming soon
