# st0x-order-deploy

A SvelteKit app for deploying and managing
[Rain Orderbook](https://github.com/rainlanguage/rain.orderbook) orders on Base,
Polygon, and Arbitrum. Supports three wallet modes — injected EOA, Safe
multisig, and Turnkey server-side signer — and includes a live dashboard for
monitoring orders and managing vault balances.

## Features

- **Order deployment** — configure and deploy Rain Orderbook strategies from a
  YAML-defined registry
- **Three wallet modes**
  - **EOA** — injected browser wallet (MetaMask, Rabby, etc.) via wagmi
  - **Safe** — proposes transactions to a Safe multisig queue (native EIP-712
    signing, no SDK)
  - **Turnkey** — server-side signing using Turnkey credentials from `.env`;
    never exposes keys to the browser
- **Dashboard** — live order browser with instant filtering by token, owner, and
  active state; expandable vault cards with deposit/withdraw per-vault
- **Vault operations** — deposit and withdraw ERC-20 tokens to/from Rain vaults
  directly from the dashboard

## Stack

| Layer     | Library                                     |
| --------- | ------------------------------------------- |
| Framework | SvelteKit 2 + Svelte 4                      |
| Wallet    | svelte-wagmi + @wagmi/core                  |
| On-chain  | viem 2                                      |
| Orderbook | @rainlanguage/orderbook                     |
| Safe      | @safe-global/api-kit (Safe TX service REST) |
| Turnkey   | @turnkey/http + @turnkey/viem               |
| Styling   | Tailwind CSS 3                              |

## Getting started

### 1. Install dependencies

```sh
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in the values you need:

```sh
cp .env.example .env
```

```env
# Required for Turnkey wallet mode
TURNKEY_ORG_ID=
TURNKEY_API_PUBLIC_KEY=
TURNKEY_API_PRIVATE_KEY=
TURNKEY_SIGN_WITH=          # wallet address or private key ID to sign with

# Optional — enables WalletConnect in EOA mode
VITE_PUBLIC_WALLETCONNECT_ID=
```

Turnkey credentials are server-only (`$env/static/private`) and never reach the
browser.

### 3. Develop

```sh
npm run dev
```

### 4. Build

```sh
npm run build
npm run preview   # preview the production build locally
```

## Configuration

Orders and strategies are declared in `src/lib/config/tokens.yaml`. The file is
loaded at build time and controls:

- **`registryCommit`** — the `rain.strategies` git commit to resolve `.rain`
  strategy files from
- **`strategies`** — named groups of orders, each specifying:
  - `strategyType` / `deploymentKey` — which strategy file and deployment to use
  - `selectTokens` — token addresses to bind to GUI token slots
  - `fieldValues` — Rain binding values (spread, price feeds, etc.)
  - `deposits` — initial vault deposit amounts
  - `vaultIds` — optional shared vault IDs so buy/sell pairs use the same vault

To add a new strategy, add an entry under `strategies` in `tokens.yaml` and bump
`registryCommit` if needed.

## Project structure

```
src/
  lib/
    config/
      strategies.ts       # TypeScript types + loader for tokens.yaml
      tokens.yaml         # All strategy and token config
    services/
      orderDeployment.ts  # Builds Rain order calldata via DotrainOrderGui
      safeDeployment.ts   # Safe EIP-712 proposal (browser-native, no SDK)
      turnkeyService.ts   # Client fetch wrapper → /api/turnkey
      vaultOperations.ts  # deposit/withdraw for EOA, Safe, and Turnkey
    stores/
      wallet.ts           # Wagmi send helpers (EOA + Turnkey)
  routes/
    +page.svelte          # Order deploy UI
    dashboard/
      +page.svelte        # Live order dashboard + vault management
    api/
      turnkey/
        +server.ts        # Server route — signs and broadcasts via Turnkey
```

## Wallet modes

### EOA

Connect any injected wallet. Transactions are sent directly from the browser via
wagmi `sendTransaction`.

### Safe

Enter a Safe address. The app proposes transactions to the Safe Transaction
Service (Base, Polygon, Arbitrum supported). Open the Safe app to confirm and
execute.

### Turnkey

Click **Connect Turnkey** — the app calls `GET /api/turnkey` to verify
credentials and return the wallet address. All signing happens server-side; the
browser only sends calldata. Set the four `TURNKEY_*` environment variables in
`.env`.

**Deposit flow (Turnkey):** approve and deposit are sent as a single batched
request so the server manages the nonce in-memory. The deposit call bypasses
`estimateGas` simulation (explicit `gas: 500_000`) to avoid a race where the RPC
node hasn't propagated the new allowance before simulation runs.

## Dashboard

Navigate to `/dashboard`. Orders are fetched from the Rain Orderbook subgraph
and can be filtered by:

- **Owner** — auto-filled from the connected wallet; edit freely
- **Token** — filter by input or output token name
- **Active** — toggle to show only live (non-removed) orders

Each order expands to show input and output vault cards. From there you can
deposit or withdraw tokens directly using whichever wallet mode is active.

## Type checking

```sh
npm run check
```
