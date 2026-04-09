/**
 * SAFE deployment service.
 *
 * Proposes an addOrder transaction to a SAFE's transaction queue via the
 * Safe Transaction Service API. The connected signer (owner) signs the
 * proposal. Other owners can then confirm and execute through the Safe app.
 *
 * Supports Base mainnet. Extend SAFE_TX_SERVICE_URLS for other chains.
 */

import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import type { DeploymentTransactionArgs } from '@rainlanguage/orderbook';
import type { Hex } from 'viem';

/** Safe Transaction Service URLs keyed by chainId */
const SAFE_TX_SERVICE_URLS: Record<number, string> = {
	8453: 'https://safe-transaction-base.safe.global', // Base
	137: 'https://safe-transaction-polygon.safe.global', // Polygon
	42161: 'https://safe-transaction-arbitrum.safe.global' // Arbitrum
};

export interface SafeProposalResult {
	safeTxHash: string;
	safeAddress: string;
	/** URL to view/confirm the transaction in the Safe web app */
	safeAppUrl: string;
}

/**
 * Propose a single addOrder transaction to a SAFE's queue.
 *
 * @param safeAddress - The SAFE multisig address
 * @param signerAddress - The connected EOA owner address (used as proposer)
 * @param signerProvider - An ethers-compatible provider/signer (from wagmi)
 * @param deploymentArgs - Args returned by buildOrderDeployment
 */
export async function proposeToSafe(
	safeAddress: string,
	signerAddress: string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	signerProvider: any,
	deploymentArgs: DeploymentTransactionArgs
): Promise<SafeProposalResult> {
	const chainId = deploymentArgs.chainId;
	const txServiceUrl = SAFE_TX_SERVICE_URLS[chainId];
	if (!txServiceUrl) {
		throw new Error(`No Safe Transaction Service URL configured for chainId ${chainId}`);
	}

	// Initialise Safe Protocol Kit with the connected signer
	const safeSdk = await Safe.init({
		provider: signerProvider,
		signer: signerAddress,
		safeAddress
	});

	// Build the Safe transaction wrapping the addOrder calldata
	const safeTransactionData = {
		to: deploymentArgs.orderbookAddress,
		data: deploymentArgs.deploymentCalldata as Hex,
		value: '0'
	};

	const safeTransaction = await safeSdk.createTransaction({
		transactions: [safeTransactionData]
	});

	// Sign the transaction hash with the proposing owner
	const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);
	const senderSignature = await safeSdk.signHash(safeTxHash);

	// Propose via the Safe API
	const apiKit = new SafeApiKit({ chainId: BigInt(chainId), txServiceUrl });

	await apiKit.proposeTransaction({
		safeAddress,
		safeTransactionData: safeTransaction.data,
		safeTxHash,
		senderAddress: signerAddress,
		senderSignature: senderSignature.data
	});

	const safeAppUrl = `https://app.safe.global/transactions/queue?safe=${safeAddress}`;

	return { safeTxHash, safeAddress, safeAppUrl };
}

/**
 * Also propose any required ERC-20 token approvals before the addOrder tx.
 * Returns an array of Safe tx hashes (one per approval).
 */
export async function proposeApprovalsToSafe(
	safeAddress: string,
	signerAddress: string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	signerProvider: any,
	deploymentArgs: DeploymentTransactionArgs
): Promise<string[]> {
	if (!deploymentArgs.approvals?.length) return [];

	const chainId = deploymentArgs.chainId;
	const txServiceUrl = SAFE_TX_SERVICE_URLS[chainId];
	if (!txServiceUrl) {
		throw new Error(`No Safe Transaction Service URL configured for chainId ${chainId}`);
	}

	const safeSdk = await Safe.init({
		provider: signerProvider,
		signer: signerAddress,
		safeAddress
	});

	const apiKit = new SafeApiKit({ chainId: BigInt(chainId), txServiceUrl });
	const hashes: string[] = [];

	for (const approval of deploymentArgs.approvals) {
		const safeTransaction = await safeSdk.createTransaction({
			transactions: [{ to: approval.token, data: approval.calldata as Hex, value: '0' }]
		});

		const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);
		const senderSignature = await safeSdk.signHash(safeTxHash);

		await apiKit.proposeTransaction({
			safeAddress,
			safeTransactionData: safeTransaction.data,
			safeTxHash,
			senderAddress: signerAddress,
			senderSignature: senderSignature.data
		});

		hashes.push(safeTxHash);
	}

	return hashes;
}
