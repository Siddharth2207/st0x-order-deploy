/**
 * Wallet store — wraps svelte-wagmi account state and provides convenience
 * helpers for sending order transactions via EOA (wagmi) or Turnkey (server API).
 */

import { get } from "svelte/store";
import { signerAddress, connected, wagmiConfig } from "svelte-wagmi";
import { sendTransaction, waitForTransactionReceipt } from "@wagmi/core";
import { type Hex } from "viem";
import type { DeploymentTransactionArgs } from "@rainlanguage/raindex";
import { sendViaTurnkey } from "$lib/services/turnkeyService";

// Re-export svelte-wagmi stores under cleaner names
export { connected as isConnected, signerAddress as walletAddress };

/**
 * Send an addOrder transaction directly from the connected EOA.
 * Handles any required token approvals first, then the addOrder call.
 */
export async function sendOrderTransaction(
  deploymentArgs: DeploymentTransactionArgs,
): Promise<Hex> {
  const config = get(wagmiConfig);
  if (!config) throw new Error("Wagmi not initialised");

  for (const approval of deploymentArgs.approvals ?? []) {
    const approvalHash = await sendTransaction(config, {
      to: approval.token as Hex,
      data: approval.calldata as Hex,
      chainId: deploymentArgs.chainId,
    });
    await waitForTransactionReceipt(config, { hash: approvalHash });
  }

  const txHash = await sendTransaction(config, {
    to: deploymentArgs.raindexAddress as Hex,
    data: deploymentArgs.deploymentCalldata as Hex,
    chainId: deploymentArgs.chainId,
  });
  await waitForTransactionReceipt(config, { hash: txHash });
  return txHash;
}

/**
 * Send an addOrder transaction via the Turnkey server route.
 * Approvals and the addOrder call are signed server-side; credentials never
 * leave the server.
 */
export async function sendOrderTransactionViaTurnkey(
  deploymentArgs: DeploymentTransactionArgs,
): Promise<Hex> {
  const transactions: Array<{ to: string; data: string }> = [];

  for (const approval of deploymentArgs.approvals ?? []) {
    transactions.push({ to: approval.token, data: approval.calldata });
  }
  transactions.push({
    to: deploymentArgs.raindexAddress,
    data: deploymentArgs.deploymentCalldata,
  });

  const txHash = await sendViaTurnkey(
    transactions,
    deploymentArgs.chainId ?? 8453,
  );
  return txHash as Hex;
}
