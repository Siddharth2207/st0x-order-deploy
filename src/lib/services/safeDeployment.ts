/**
 * SAFE deployment service — browser-native implementation.
 *
 * Uses viem's hashTypedData to compute the Safe EIP-712 tx hash, signs via
 * eth_signTypedData_v4 on the injected EIP-1193 provider, and submits directly
 * to the Safe Transaction Service REST API with fetch().
 *
 * No @safe-global/protocol-kit in the browser — that package pulls in
 * readable-stream / util / hash-base which don't work reliably as browser
 * polyfills.
 */

import type { DeploymentTransactionArgs } from "@rainlanguage/orderbook";
import { hashTypedData } from "viem";
import type { Hex } from "viem";

export const SAFE_TX_SERVICE_URLS: Record<number, string> = {
  8453: "https://safe-transaction-base.safe.global", // Base
  137: "https://safe-transaction-polygon.safe.global", // Polygon
  42161: "https://safe-transaction-arbitrum.safe.global", // Arbitrum
};

export interface SafeProposalResult {
  safeTxHash: string;
  safeAddress: string;
  safeAppUrl: string;
}

// Safe EIP-712 struct definition (canonical, never changes)
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * Returns the next available nonce for a Safe — max of the on-chain nonce and
 * the highest pending-queue nonce + 1, so new proposals never collide with
 * already-queued transactions.
 */
export async function getNextNonce(
  txServiceUrl: string,
  safeAddress: string,
): Promise<number> {
  const [safeRes, pendingRes] = await Promise.all([
    fetch(`${txServiceUrl}/api/v1/safes/${safeAddress}/`),
    fetch(
      `${txServiceUrl}/api/v1/safes/${safeAddress}/multisig-transactions/?ordering=-nonce&limit=1&executed=false`,
    ),
  ]);

  if (!safeRes.ok)
    throw new Error(`Safe API error fetching Safe info: ${safeRes.statusText}`);
  const safeData = await safeRes.json();
  let next: number = safeData.nonce;

  if (pendingRes.ok) {
    const pendingData = await pendingRes.json();
    if (pendingData.results?.length > 0) {
      next = Math.max(next, (pendingData.results[0].nonce as number) + 1);
    }
  }

  return next;
}

/**
 * Compute the Safe EIP-712 hash, sign it, and POST to the Safe Transaction
 * Service. Returns the safe tx hash.
 */
export async function proposeSingleTx(
  txServiceUrl: string,
  chainId: number,
  safeAddress: string,
  signerAddress: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any,
  to: string,
  data: string,
  nonce: number,
): Promise<string> {
  // ── 1. Compute the EIP-712 hash with viem (handles BigInt correctly) ───
  const safeTxHash = hashTypedData({
    domain: { chainId, verifyingContract: safeAddress as Hex },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx",
    message: {
      to: to as Hex,
      value: BigInt(0),
      data: data as Hex,
      operation: 0,
      safeTxGas: BigInt(0),
      baseGas: BigInt(0),
      gasPrice: BigInt(0),
      gasToken: ZERO_ADDR as Hex,
      refundReceiver: ZERO_ADDR as Hex,
      nonce: BigInt(nonce),
    },
  });

  // ── 2. Sign via eth_signTypedData_v4 (JSON-serialisable, no BigInts) ──
  const typedDataPayload = {
    types: {
      EIP712Domain: [
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      SafeTx: SAFE_TX_TYPES.SafeTx,
    },
    domain: { chainId, verifyingContract: safeAddress },
    primaryType: "SafeTx",
    message: {
      to,
      value: "0",
      data,
      operation: 0,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: ZERO_ADDR,
      refundReceiver: ZERO_ADDR,
      nonce,
    },
  };

  const signature: string = await provider.request({
    method: "eth_signTypedData_v4",
    params: [signerAddress, JSON.stringify(typedDataPayload)],
  });

  // ── 3. Submit to Safe Transaction Service ──────────────────────────────
  const res = await fetch(
    `${txServiceUrl}/api/v1/safes/${safeAddress}/multisig-transactions/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to,
        value: "0",
        data,
        operation: 0,
        safeTxGas: "0",
        baseGas: "0",
        gasPrice: "0",
        gasToken: ZERO_ADDR,
        refundReceiver: ZERO_ADDR,
        nonce,
        contractTransactionHash: safeTxHash,
        sender: signerAddress,
        signature,
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Safe API error (${res.status}): ${body}`);
  }

  return safeTxHash;
}

/**
 * Propose any required ERC-20 token approvals to the SAFE queue.
 * Each approval gets a sequentially increasing nonce so they execute in order.
 */
export async function proposeApprovalsToSafe(
  safeAddress: string,
  signerAddress: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signerProvider: any,
  deploymentArgs: DeploymentTransactionArgs,
): Promise<string[]> {
  if (!deploymentArgs.approvals?.length) return [];

  const chainId = deploymentArgs.chainId;
  const txServiceUrl = SAFE_TX_SERVICE_URLS[chainId];
  if (!txServiceUrl)
    throw new Error(`No Safe TX service URL for chainId ${chainId}`);

  const baseNonce = await getNextNonce(txServiceUrl, safeAddress);
  const hashes: string[] = [];

  for (let i = 0; i < deploymentArgs.approvals.length; i++) {
    const approval = deploymentArgs.approvals[i];
    const hash = await proposeSingleTx(
      txServiceUrl,
      chainId,
      safeAddress,
      signerAddress,
      signerProvider,
      approval.token,
      approval.calldata as string,
      baseNonce + i,
    );
    hashes.push(hash);
  }

  return hashes;
}

/**
 * Propose the addOrder transaction to the SAFE queue.
 * Must be called after proposeApprovalsToSafe so the nonce is calculated
 * correctly (getNextNonce sees the approval txs already queued).
 */
export async function proposeToSafe(
  safeAddress: string,
  signerAddress: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signerProvider: any,
  deploymentArgs: DeploymentTransactionArgs,
): Promise<SafeProposalResult> {
  const chainId = deploymentArgs.chainId;
  const txServiceUrl = SAFE_TX_SERVICE_URLS[chainId];
  if (!txServiceUrl)
    throw new Error(`No Safe TX service URL for chainId ${chainId}`);

  // After approvals are queued, getNextNonce returns the slot right after them
  const nonce = await getNextNonce(txServiceUrl, safeAddress);

  const safeTxHash = await proposeSingleTx(
    txServiceUrl,
    chainId,
    safeAddress,
    signerAddress,
    signerProvider,
    deploymentArgs.orderbookAddress,
    deploymentArgs.deploymentCalldata as string,
    nonce,
  );

  return {
    safeTxHash,
    safeAddress,
    safeAppUrl: `https://app.safe.global/transactions/queue?safe=${safeAddress}`,
  };
}
