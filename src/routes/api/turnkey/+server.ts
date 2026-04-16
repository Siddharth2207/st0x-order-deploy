/**
 * Server-side Turnkey endpoint — credentials never reach the browser.
 *
 * GET  /api/turnkey           → { address: string }
 * POST /api/turnkey           → { txHash: string }
 *   Body: { transactions: Array<{ to: string; data: string }>, chainId: number }
 *         Signs and broadcasts each transaction sequentially, returns last tx hash.
 */

import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  TURNKEY_ORG_ID,
  TURNKEY_API_PUBLIC_KEY,
  TURNKEY_API_PRIVATE_KEY,
  TURNKEY_SIGN_WITH,
} from "$env/static/private";
import { TurnkeyClient } from "@turnkey/http";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { createAccount } from "@turnkey/viem";
import {
  createWalletClient,
  createPublicClient,
  http,
  type Hex,
  type Address,
} from "viem";
import { base, polygon, arbitrum } from "viem/chains";
import type { Chain } from "viem";

const CHAINS: Record<number, Chain> = {
  8453: base,
  137: polygon,
  42161: arbitrum,
};

async function makeTurnkeyAccount() {
  if (
    !TURNKEY_ORG_ID ||
    !TURNKEY_API_PUBLIC_KEY ||
    !TURNKEY_API_PRIVATE_KEY ||
    !TURNKEY_SIGN_WITH
  ) {
    throw error(
      503,
      "Turnkey credentials not configured — set TURNKEY_* vars in .env",
    );
  }

  const stamper = new ApiKeyStamper({
    apiPublicKey: TURNKEY_API_PUBLIC_KEY,
    apiPrivateKey: TURNKEY_API_PRIVATE_KEY,
  });

  const client = new TurnkeyClient(
    { baseUrl: "https://api.turnkey.com" },
    stamper,
  );

  return createAccount({
    client,
    organizationId: TURNKEY_ORG_ID,
    signWith: TURNKEY_SIGN_WITH,
  });
}

/** Return the wallet address configured in .env */
export const GET: RequestHandler = async () => {
  try {
    const account = await makeTurnkeyAccount();
    return json({ address: account.address });
  } catch (e) {
    if (typeof e === "object" && e !== null && "status" in e) throw e; // re-throw SvelteKit errors
    throw error(500, e instanceof Error ? e.message : "Turnkey error");
  }
};

/** Sign and broadcast a batch of transactions sequentially, return the last tx hash */
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json()) as {
    transactions: Array<{ to: string; data: string; gas?: number }>;
    chainId: number;
  };

  const chain = CHAINS[body.chainId];
  if (!chain) throw error(400, `Unsupported chainId: ${body.chainId}`);

  try {
    const account = await makeTurnkeyAccount();
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(),
    });
    const publicClient = createPublicClient({ chain, transport: http() });

    let lastHash = "";
    let nonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });

    for (const tx of body.transactions) {
      // If the caller provides an explicit gas limit, skip estimateGas entirely.
      // This is required for deposit4 which follows an approve in the same flow:
      // estimateGas would simulate against a node that may not have propagated
      // the approval state yet, causing a spurious "exceeds allowance" revert.
      const gas = tx.gas
        ? BigInt(tx.gas)
        : await publicClient.estimateGas({
            to: tx.to as Address,
            data: tx.data as Hex,
            account: account.address,
          });

      const fees = await publicClient.estimateFeesPerGas();

      const request = await publicClient.prepareTransactionRequest({
        to: tx.to as Address,
        data: tx.data as Hex,
        chain,
        account,
        nonce,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });

      const signed = await walletClient.signTransaction({
        ...request,
        chain,
        account,
      });

      const hash = await publicClient.sendRawTransaction({
        serializedTransaction: signed,
      });

      await publicClient.waitForTransactionReceipt({ hash });
      lastHash = hash;
      nonce += 1;
    }

    return json({ txHash: lastHash });
  } catch (e) {
    if (typeof e === "object" && e !== null && "status" in e) throw e;
    throw error(500, e instanceof Error ? e.message : "Turnkey error");
  }
};
