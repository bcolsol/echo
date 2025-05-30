# Echo - Solana copy trading bot

## [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🚨 IMPORTANT DISCLAIMERS 🚨

**⚠️ Ongoing Development:** This project is currently under **heavy development**. Expect bugs, breaking changes, and incomplete features. **DO NOT use with significant funds.**

**⚠️ Financial Risk:** This bot executes trades automatically based on its configuration and the actions of wallets it monitors. You are solely responsible for any financial losses incurred. **Use at your own risk.**

**⚠️ Security Risk:** You need to provide your bot wallet's private key during the setup process, it will be saved in config.json. Handle this file with extreme care. Anyone gaining access to it can control your bot's funds. It is strongly recommended to use a **dedicated bot wallet** funded only with the amount you are willing to risk.

**⚠️ Scam Warning:** The crypto space is full of scams.

**Only use code from the official `main` branch** of this repository. Be extremely cautious of code from other branches or forks unless you have verified it yourself.

- **Verify the code:** Since this is open source, take the time to understand what the code does before running it.

- **Beware of impersonators:** Be wary of anyone contacting you claiming to be a developer or offering paid support, especially if they ask for funds or private keys. Official communication channel is on [discord](https://discord.gg/AHdWVrKB)

---

## Introduction

As a trader, I got tired of bot fees eating into my profits. So I built my own copy trading bot, simple, free, and fully under my control.

Now I am open-sourcing it, not just to build trust, but to invite collaboration. If you are a trader, builder, or just curious, jump in. Let's improve it together and build tools that actually work for us.

## Showcase of bot in action

Here's a glimpse of Echo monitoring wallets and executing trades:

<img src="https://s14.gifyu.com/images/bsZF1.gif" alt="Echo Solana Copy Trading Bot in Action" width="600" />

## Use cases

Echo is designed to be relatively fast, typically taking 1-2 seconds from detecting a trade by a monitored wallet to its own trade being confirmed. Having said this, it's important to understand its intended use:

- **Best For:** Copy trading on more established or moderately volatile tokens where a 1-2 second reaction time is acceptable. It's also well-suited for managing positions with Stop-Loss/Take-Profit on these types of coins.

- **Not Ideal For:** Trying to snipe brand new, highly volatile memecoin launches where every millisecond is critical to get in at the absolute earliest possible moment. For such cases, specialized sniping bots with different architectures are required.

Echo prioritizes reliable trade replication using Jupiter API

## How Echo Works (technical explanation)

When Echo is set up to monitor a wallet, here's the general process it follows to copy a trade or manage a position:

### Operating Modes

Echo has two main modes, set by the `MANAGE_WITH_SLTP` option during setup and saved in config.json file.

1. **Full Copy Mode (`MANAGE_WITH_SLTP=false`):**

- The bot copies both buys and sells from the monitored wallet. If the target buys, Echo buys. If the target sells a token Echo holds (from a previous copy), Echo sells its entire position of that token.

2. **Buy & Manage Mode (`MANAGE_WITH_SLTP=true`):**

- Echo copies buys from the monitored wallet and records the purchase price of the acquired tokens.

- It then ignores sell signals from the monitored wallet for these holdings. Instead, it uses its own Stop-Loss (SL) and Take-Profit (TP) logic. If the price of a held token reaches the pre-defined SL or TP percentage levels, Echo will sell the entire position.

### The Trade Execution Pipeline

Here's a breakdown of the steps involved when Echo decides to make a trade:

1. **Trade Detection (via `WalletMonitor`):**

- **Log Monitoring:** Echo listens for new transaction logs from the wallets you're monitoring. This relies on your Solana RPC node to deliver these logs once transactions reach a `confirmed` state.

- **Transaction Retrieval:** Once a relevant log signature is found, the bot fetches the complete transaction data using `getParsedTransaction`.

2. **Trade Analysis (via `analyzeTrade`):**

- **DEX Check:** It confirms the transaction involves a known DEX (Decentralized Exchange).

- **Details Extraction:** It analyzes the transaction to see what token was traded, the amounts, and the direction (buy/sell). Token metadata (like symbol and decimals) is also retrieved, using a cache first, then on-chain Metaplex data if needed.

3. **Quoting & Swap Preparation (via `TradeExecutor` with Jupiter API):**

- **Get Quote (`getJupiterQuote`):** Echo requests a swap quote from Jupiter's V6 API.

- For buys: Quoting SOL/WSOL to the target token, using the bot's configured `COPY_TRADE_AMOUNT_SOL`.

- For sells (either copy-sells or SL/TP-triggered sells): Quoting the entire held amount of the target token to SOL/WSOL.

- **Get Swap Transaction (`getJupiterSwap`):** If the quote is acceptable, Echo gets the serialized transaction data from Jupiter needed to execute that swap.

- _Note: These are network calls to Jupiter's API, so their speed depends on API responsiveness and your internet connection._

4. **Local Transaction Processing:**

- **Signing:** The transaction data from Jupiter is deserialized, and the bot signs it with its own wallet's private key. This is a fast, local operation.

5. **Execution & Confirmation (via `SolanaClient`):**

- **Broadcasting (`sendRawTransaction`):** The signed transaction is sent to your Solana RPC node, which then tries to get it to the current Solana network leader. The `skipPreflight: true` option is used to submit it without an initial client-side simulation, potentially saving a little time.

- **Waiting for Confirmation (`confirmTransaction`):** The bot waits for the transaction to be confirmed on the Solana network to the specified commitment level. The time this takes is influenced by network congestion and the use (or absence) of priority fees.

### Stop-Loss/Take-Profit Monitoring (If `MANAGE_WITH_SLTP=true`)

- A separate process runs at an interval defined by `PRICE_CHECK_INTERVAL_MS` in your configuration.

- This loop iterates through all tokens the bot currently holds for which a purchase price has been recorded.

- For each of these tokens, it fetches the current market price by requesting a quote from Jupiter (Token -> WSOL for the entire held amount).

- If the current price meets the configured Stop-Loss or Take-Profit percentage relative to its recorded average purchase price, the bot will trigger a sell of the entire position for that token via the `TradeExecutor`.

## ✨ Current Features (MVP)

- **Interactive Setup:** Easily setup the bot by answering config questions in terminal

- **Wallet Monitoring:** Listens to transactions involving specified Solana wallets.

- **Copy Buy Logic:** Detects SOL/WSOL -> Token swaps by monitored wallets and executes a corresponding buy trade using the bot's wallet.

- Uses a **fixed SOL amount** (configurable during setup) for buys.

- Uses the **Jupiter API (v6)** for trade quoting and execution.

- **Copy Sell Logic:** Detects Token -> SOL/WSOL swaps by monitored wallets.

- If the bot holds that specific token (because it previously copied a buy triggered by the _same_ wallet), it sells the **entire** bot's position for that token.

- **SL/TP Management:** Manages stop-loss and take-profit levels for copied buys.

- **State Persistence:** Remembers which tokens the bot bought (and the trigger wallet) using a local `bot_holdings.json` file, allowing sell logic to function across restarts.

## 🚀 Upcoming Features (Roadmap)

This project is actively evolving. Here are some of the features planned for the near future (priorities may shift based on community feedback):

1. **Dynamic Buy/Sell Amount:** Option to configure the bot to copy a percentage of the monitored wallet's trade size (with a configurable cap) instead of always using a fixed SOL amount.

2. **Enhanced Error Handling & Retries:** Make the bot more resilient to temporary RPC or Jupiter API errors.

3. **Docker Support:** Implement docker support for easier install/usage

## ⚙️ Setup & Configuration

This guide will walk you through getting Echo set up on your computer. If you're not a developer, don't worry! We'll go step-by-step.

### Not a developer? Join our [discord](https://discord.gg/AHdWVrKB) to get help with setting up the bot.

**1. Prerequisites:**

- **Node.js and npm:** These are essential tools for running Echo. Node.js is a JavaScript runtime (like an engine for the bot's code), and npm (Node Package Manager) helps install other tools Echo needs.
  - **How to install Node.js and npm (for non-technical users):**
    - **What are these?** Think of Node.js as the engine for the bot, and npm as a helper that gets other parts the engine needs. They usually come together.
    - **Opening the Terminal (Command Prompt):**
      - **Windows:** Press the `Windows Key` (it looks like a little window), type `cmd` or `Command Prompt`, and press `Enter`.
      - **macOS:** Press `Command (⌘) + Spacebar` to open Spotlight Search, type `Terminal`, and press `Enter`.
      - **Linux (Ubuntu/Debian):** Press `Ctrl + Alt + T`. For other versions, search for "Terminal" in your applications menu.
    - **Step 1: Check if you already have Node.js:**
      - In your terminal, type `node -v` and press `Enter`.
      - Then, type `npm -v` and press `Enter`.
      - If you see version numbers (e.g., `v18.x.x` for node and `9.x.x` for npm), you likely have them installed. Make sure the Node.js version is 18.x or higher. If it is, you can skip to step 3.
    - **Step 2: Install Node.js and npm if you don't have them (or need to update):**
      - Go to the official Node.js website: [https://nodejs.org/](https://nodejs.org/)
      - You'll usually see two download options: **LTS** (Long Term Support) and **Current**. For most users, **LTS is recommended** as it's more stable. Click on the LTS version to download it.
      - Once downloaded, open the installer file (it might be a `.msi` on Windows or a `.pkg` on macOS).
      - Follow the on-screen instructions. The default settings are usually fine. Make sure the option to install npm is also selected (it usually is by default).
      - After installation, **close your current terminal window and open a new one.** This is important for the system to recognize the new installation.
      - In the new terminal window, type `node -v` and `npm -v` again to confirm they are installed and see the version numbers.
- **Git (Optional, but Recommended for Updates):** Git is a version control system. While not strictly necessary to download the initial files, it's highly recommended if you want to easily update the bot later.
  - **How to install Git:**
    - Go to [https://git-scm.com/downloads](https://git-scm.com/downloads).
    - Download the installer for your operating system (Windows, macOS, or Linux).
    - Run the installer and follow the on-screen instructions. Default settings are usually fine.
    - To check if Git is installed, open a new terminal and type `git --version`. If you see a version number, it's installed.

**2. Downloading Echo:**

- **Method 1: Using Git (Recommended for updates)**

  - Open your terminal (see "Opening the Terminal" above if you're unsure).
  - Navigate to where you want to save the bot. For example, to save it in a folder called "Projects" in your user directory:
    - On Windows: `cd %USERPROFILE%\Projects` (If "Projects" doesn't exist, you can create it first or choose another location like `cd %USERPROFILE%\Desktop`).
    - On macOS/Linux: `cd ~/Projects` (If "Projects" doesn't exist, type `mkdir ~/Projects` first, then `cd ~/Projects`, or choose another location like `cd ~/Desktop`).
  - Once you're in the desired directory in your terminal, copy and paste the following command and press `Enter`:
    ```bash
    git clone [https://github.com/bcolsol/echo.git](https://github.com/bcolsol/echo.git)
    ```
  - This will create a new folder named `echo` containing all the bot's files.
  - Now, navigate into the bot's folder by typing:
    ```bash
    cd echo
    ```

- **Method 2: Downloading as a ZIP (If you don't want to use Git)**
  - Go to the Echo GitHub page: [https://github.com/bcolsol/echo](https://github.com/bcolsol/echo)
  - Click the green "<> Code" button.
  - In the dropdown menu, click "Download ZIP".
  - Save the ZIP file to your computer (e.g., your Downloads folder).
  - Find the downloaded ZIP file and extract it. (On Windows, right-click and "Extract All...". On macOS, double-click it). This will create a folder, likely named `echo-main`. You can rename it to just `echo` if you like.
  - **Open your terminal** (see "Opening the Terminal" above).
  - **Navigate into the extracted folder.** For example, if you extracted it to your Downloads folder and it's named `echo`:
    - Windows: `cd %USERPROFILE%\Downloads\echo`
    - macOS/Linux: `cd ~/Downloads/echo`
    - _Adjust the path if you saved or extracted it elsewhere._

**3. Install Dependencies:**

- Once you are inside the `echo` directory in your terminal (from the last step of either download method), type the following command and press `Enter`:
  ```bash
  npm install
  ```
- This command reads a file called `package.json` and automatically downloads and installs all the additional code libraries that Echo needs to function. You'll see a lot of text scrolling in the terminal – this is normal. Wait for it to finish. You might see some "WARN" messages, which are usually okay. Look for any "ERR!" messages, which might indicate a problem.

**4. Setup Configuration:**

- Still in the `echo` directory in your terminal, run the interactive setup by typing:
  ```bash
  npm run setup
  ```
- This will ask you a series of questions to configure the bot (like your RPC endpoint, bot wallet private key, trade amounts, etc.). Answer each question carefully.

    <img src="https://s14.gifyu.com/images/bsZFo.gif" alt="Echo Solana Copy Trading Bot setup" width="600" />

**5. Running the Bot:**

- Once the setup is complete and your `config.json` file is created, you can start the bot. In the same `echo` directory in your terminal, type:
  ```bash
  npm start
  ```
- The bot will start, load any existing holdings from `bot_holdings.json` (if it exists from previous runs), initialize subscriptions for the wallets you defined, and begin monitoring/trading.
- Press `CTRL+C` in the terminal to stop the bot gracefully (it will attempt to save its current state before exiting).

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
