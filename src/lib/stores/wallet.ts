/**
 * Wallet store — wraps svelte-wagmi account state and provides a
 * convenience helper for sending a raw transaction.
 */

import { get } from 'svelte/store';
import { signerAddress, connected, wagmiConfig } from 'svelte-wagmi';
import { sendTransaction, waitForTransactionReceipt } from '@wagmi/core';
import type { Hex } from 'viem';
import type { DeploymentTransactionArgs } from '@rainlanguage/orderbook';

// Re-export svelte-wagmi stores under cleaner names
export { connected as isConnected, signerAddress as walletAddress };

/**
 * Send an addOrder transaction directly from the connected EOA.
 * Handles any required token approvals first, then the addOrder call.
 *
 * Returns the final transaction hash.
 */
export async function sendOrderTransaction(deploymentArgs: DeploymentTransactionArgs): Promise<Hex> {
	const config = get(wagmiConfig);
	if (!config) throw new Error('Wagmi not initialised');

	// Send approval transactions if needed
	for (const approval of deploymentArgs.approvals ?? []) {
		const approvalHash = await sendTransaction(config, {
			to: approval.token as Hex,
			data: approval.calldata as Hex,
			chainId: deploymentArgs.chainId
		});
		await waitForTransactionReceipt(config, { hash: approvalHash });
	}

	// Send the addOrder transaction
	const txHash = await sendTransaction(config, {
		to: deploymentArgs.orderbookAddress as Hex,
		data: deploymentArgs.deploymentCalldata as Hex,
		chainId: deploymentArgs.chainId
	});

	await waitForTransactionReceipt(config, { hash: txHash });
	return txHash;
}
