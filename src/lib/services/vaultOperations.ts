/**
 * Vault operations — deposit and withdraw tokens to/from Rain orderbook vaults.
 *
 * Supports three wallet modes:
 *   eoa     — connected injected wallet via wagmi
 *   safe    — propose to Safe multisig queue
 *   turnkey — sign directly with a Turnkey-backed viem WalletClient
 *
 * WASM note: Float from @rainlanguage/raindex requires the WASM module to be
 * initialised (this happens automatically on first use of RaindexOrderBuilder).
 * If you use vault operations without first building an order, call any
 * RaindexOrderBuilder async method once to initialise WASM.
 */

import { get } from "svelte/store";
import { wagmiConfig } from "svelte-wagmi";
import { sendTransaction, waitForTransactionReceipt } from "@wagmi/core";
import {
  createPublicClient,
  http,
  encodeFunctionData,
  parseUnits,
  type Hex,
  type Address,
} from "viem";
import { sendViaTurnkey } from "./turnkeyService";
import { base, polygon, arbitrum } from "viem/chains";
import type { Chain } from "viem";
import { Float } from "@rainlanguage/raindex";
import {
  proposeSingleTx,
  getNextNonce,
  SAFE_TX_SERVICE_URLS,
  type SafeProposalResult,
} from "./safeDeployment";

// ── Chain map ──────────────────────────────────────────────────────────────────

const CHAINS: Record<number, Chain> = {
  8453: base,
  137: polygon,
  42161: arbitrum,
};

function getChain(chainId: number): Chain {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unsupported chainId: ${chainId}`);
  return chain;
}

// ── ABIs ───────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "decimals",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
] as const;

const TASK_V2_COMPONENTS = [
  {
    name: "evaluable",
    type: "tuple",
    components: [
      { name: "interpreter", type: "address" },
      { name: "store", type: "address" },
      { name: "bytecode", type: "bytes" },
    ],
  },
  {
    name: "signedContext",
    type: "tuple[]",
    components: [
      { name: "signer", type: "address" },
      { name: "context", type: "bytes32[]" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

const DEPOSIT4_ABI = [
  {
    name: "deposit4",
    type: "function",
    inputs: [
      { name: "token", type: "address" },
      { name: "vaultId", type: "bytes32" },
      { name: "depositAmount", type: "bytes32" },
      { name: "post", type: "tuple[]", components: TASK_V2_COMPONENTS },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const WITHDRAW4_ABI = [
  {
    name: "withdraw4",
    type: "function",
    inputs: [
      { name: "token", type: "address" },
      { name: "vaultId", type: "bytes32" },
      { name: "targetAmount", type: "bytes32" },
      { name: "post", type: "tuple[]", components: TASK_V2_COMPONENTS },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const VAULT_BALANCE2_ABI = [
  {
    name: "vaultBalance2",
    type: "function",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "vaultId", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
] as const;

// ── Public client helper ───────────────────────────────────────────────────────

function makePublicClient(chainId: number) {
  return createPublicClient({ chain: getChain(chainId), transport: http() });
}

// ── Calldata builders ─────────────────────────────────────────────────────────

async function buildDepositCalldata(
  tokenAddress: string,
  vaultId: string,
  amount: string,
  orderbookAddress: string,
  chainId: number,
): Promise<{ approveData: Hex; depositData: Hex }> {
  const pc = makePublicClient(chainId);
  const decimals = await pc.readContract({
    address: tokenAddress as Address,
    abi: ERC20_ABI,
    functionName: "decimals",
  });

  const amountBigint = parseUnits(amount, Number(decimals));
  const { float } = Float.fromFixedDecimalLossy(amountBigint, Number(decimals));
  const floatHex = float.asHex() as Hex;

  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [orderbookAddress as Address, amountBigint],
  });

  const depositData = encodeFunctionData({
    abi: DEPOSIT4_ABI,
    functionName: "deposit4",
    args: [tokenAddress as Address, vaultId as Hex, floatHex, []],
  });

  return { approveData, depositData };
}

async function buildWithdrawCalldata(
  tokenAddress: string,
  vaultId: string,
  amount: string,
  orderbookAddress: string,
  ownerAddress: string,
  chainId: number,
): Promise<Hex> {
  let targetHex: Hex;

  if (amount === "all") {
    const pc = makePublicClient(chainId);
    const balanceHex = await pc.readContract({
      address: orderbookAddress as Address,
      abi: VAULT_BALANCE2_ABI,
      functionName: "vaultBalance2",
      args: [ownerAddress as Address, tokenAddress as Address, vaultId as Hex],
    });
    targetHex = balanceHex as Hex;
  } else {
    const pc = makePublicClient(chainId);
    const decimals = await pc.readContract({
      address: tokenAddress as Address,
      abi: ERC20_ABI,
      functionName: "decimals",
    });
    const amountBigint = parseUnits(amount, Number(decimals));
    const { float } = Float.fromFixedDecimalLossy(
      amountBigint,
      Number(decimals),
    );
    targetHex = float.asHex() as Hex;
  }

  return encodeFunctionData({
    abi: WITHDRAW4_ABI,
    functionName: "withdraw4",
    args: [tokenAddress as Address, vaultId as Hex, targetHex, []],
  });
}

// ── Public input type ──────────────────────────────────────────────────────────

export interface VaultOpInput {
  tokenAddress: string;
  vaultId: string;
  /** Human-readable amount (e.g. "100.5") or "all" (withdraw only). */
  amount: string;
  orderbookAddress: string;
  chainId: number;
}

// ── EOA operations ────────────────────────────────────────────────────────────

export async function depositEoa(input: VaultOpInput): Promise<Hex> {
  const config = get(wagmiConfig);
  if (!config) throw new Error("Wagmi not initialised");

  const { approveData, depositData } = await buildDepositCalldata(
    input.tokenAddress,
    input.vaultId,
    input.amount,
    input.orderbookAddress,
    input.chainId,
  );

  const approveHash = await sendTransaction(config, {
    to: input.tokenAddress as Hex,
    data: approveData,
    chainId: input.chainId,
  });
  await waitForTransactionReceipt(config, { hash: approveHash });

  const txHash = await sendTransaction(config, {
    to: input.orderbookAddress as Hex,
    data: depositData,
    chainId: input.chainId,
  });
  await waitForTransactionReceipt(config, { hash: txHash });
  return txHash;
}

export async function withdrawEoa(
  input: VaultOpInput,
  signerAddress: string,
): Promise<Hex> {
  const config = get(wagmiConfig);
  if (!config) throw new Error("Wagmi not initialised");

  const withdrawData = await buildWithdrawCalldata(
    input.tokenAddress,
    input.vaultId,
    input.amount,
    input.orderbookAddress,
    signerAddress,
    input.chainId,
  );

  const txHash = await sendTransaction(config, {
    to: input.orderbookAddress as Hex,
    data: withdrawData,
    chainId: input.chainId,
  });
  await waitForTransactionReceipt(config, { hash: txHash });
  return txHash;
}

// ── Safe operations ───────────────────────────────────────────────────────────

export async function depositSafe(
  input: VaultOpInput,
  safeAddress: string,
  signerAddr: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any,
): Promise<SafeProposalResult> {
  const txServiceUrl = SAFE_TX_SERVICE_URLS[input.chainId];
  if (!txServiceUrl)
    throw new Error(`No Safe TX service for chainId ${input.chainId}`);

  const { approveData, depositData } = await buildDepositCalldata(
    input.tokenAddress,
    input.vaultId,
    input.amount,
    input.orderbookAddress,
    input.chainId,
  );

  const baseNonce = await getNextNonce(txServiceUrl, safeAddress);

  await proposeSingleTx(
    txServiceUrl,
    input.chainId,
    safeAddress,
    signerAddr,
    provider,
    input.tokenAddress,
    approveData,
    baseNonce,
  );
  const safeTxHash = await proposeSingleTx(
    txServiceUrl,
    input.chainId,
    safeAddress,
    signerAddr,
    provider,
    input.orderbookAddress,
    depositData,
    baseNonce + 1,
  );

  return {
    safeTxHash,
    safeAddress,
    safeAppUrl: `https://app.safe.global/transactions/queue?safe=${safeAddress}`,
  };
}

export async function withdrawSafe(
  input: VaultOpInput,
  safeAddress: string,
  signerAddr: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any,
): Promise<SafeProposalResult> {
  const txServiceUrl = SAFE_TX_SERVICE_URLS[input.chainId];
  if (!txServiceUrl)
    throw new Error(`No Safe TX service for chainId ${input.chainId}`);

  // For "withdraw all", the vault owner is the Safe address itself
  const withdrawData = await buildWithdrawCalldata(
    input.tokenAddress,
    input.vaultId,
    input.amount,
    input.orderbookAddress,
    safeAddress,
    input.chainId,
  );

  const nonce = await getNextNonce(txServiceUrl, safeAddress);
  const safeTxHash = await proposeSingleTx(
    txServiceUrl,
    input.chainId,
    safeAddress,
    signerAddr,
    provider,
    input.orderbookAddress,
    withdrawData,
    nonce,
  );

  return {
    safeTxHash,
    safeAddress,
    safeAppUrl: `https://app.safe.global/transactions/queue?safe=${safeAddress}`,
  };
}

// ── Turnkey operations ────────────────────────────────────────────────────────

export async function depositTurnkey(
  input: VaultOpInput,
  onStep?: (step: "approving") => void,
): Promise<Hex> {
  const { approveData, depositData } = await buildDepositCalldata(
    input.tokenAddress,
    input.vaultId,
    input.amount,
    input.orderbookAddress,
    input.chainId,
  );

  // Send approve + deposit4 as a single batch so the server manages the nonce
  // in-memory. Two separate sendViaTurnkey calls each re-fetch getTransactionCount
  // and the RPC node may still return the pre-approve nonce for the second call,
  // causing "nonce too low". Within a batch the server increments nonce manually
  // after each confirmed receipt.
  //
  // deposit4 gets an explicit gas limit so the server skips estimateGas
  // simulation — the simulation would hit the RPC before the approve allowance
  // has propagated and revert with "exceeds allowance".
  onStep?.("approving");
  return sendViaTurnkey(
    [
      { to: input.tokenAddress, data: approveData },
      { to: input.orderbookAddress, data: depositData, gas: 500_000 },
    ],
    input.chainId,
  ) as Promise<Hex>;
}

export async function withdrawTurnkey(
  input: VaultOpInput,
  walletAddress: string,
): Promise<Hex> {
  const withdrawData = await buildWithdrawCalldata(
    input.tokenAddress,
    input.vaultId,
    input.amount,
    input.orderbookAddress,
    walletAddress,
    input.chainId,
  );
  return sendViaTurnkey(
    [{ to: input.orderbookAddress, data: withdrawData }],
    input.chainId,
  ) as Promise<Hex>;
}
