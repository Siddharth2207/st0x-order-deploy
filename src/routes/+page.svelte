<script lang="ts">
	import { connect, disconnect } from '@wagmi/core';
	import { injected } from '@wagmi/connectors';
	import { wagmiConfig, signerAddress, connected } from 'svelte-wagmi';
	import { get } from 'svelte/store';
	import { STRATEGIES, type StrategyConfig } from '$lib/config/strategies';
	import {
		buildOrderDeployment,
		type DeploymentResult,
		type OrderSide
	} from '$lib/services/orderDeployment';
	import { sendOrderTransaction } from '$lib/stores/wallet';
	import { proposeApprovalsToSafe, proposeToSafe } from '$lib/services/safeDeployment';

	// ---------------------------------------------------------------------------
	// Wallet
	// ---------------------------------------------------------------------------

	async function handleConnect() {
		const config = get(wagmiConfig);
		if (!config) return;
		await connect(config, { connector: injected() });
	}

	async function handleDisconnect() {
		const config = get(wagmiConfig);
		if (!config) return;
		await disconnect(config);
	}

	// ---------------------------------------------------------------------------
	// Strategy selection
	// ---------------------------------------------------------------------------

	let selectedStrategy: StrategyConfig = STRATEGIES[0];
	let deploymentMode: 'eoa' | 'safe' = 'eoa';
	let safeAddress = '';

	function selectStrategy(s: StrategyConfig) {
		selectedStrategy = s;
		buyState = emptyState();
		sellState = emptyState();
	}

	// ---------------------------------------------------------------------------
	// Per-order state
	// ---------------------------------------------------------------------------

	type OrderState = {
		status: 'idle' | 'loading' | 'ready' | 'deploying' | 'success' | 'error';
		result: DeploymentResult | null;
		txHash: string | null;
		safeTxHash: string | null;
		safeAppUrl: string | null;
		error: string | null;
	};

	function emptyState(): OrderState {
		return {
			status: 'idle',
			result: null,
			txHash: null,
			safeTxHash: null,
			safeAppUrl: null,
			error: null
		};
	}

	let buyState: OrderState = emptyState();
	let sellState: OrderState = emptyState();

	function getState(side: OrderSide): OrderState {
		return side === 'buy' ? buyState : sellState;
	}

	function setState(side: OrderSide, patch: Partial<OrderState>) {
		const next = { ...getState(side), ...patch };
		if (side === 'buy') buyState = next;
		else sellState = next;
	}

	// ---------------------------------------------------------------------------
	// Build order (preview)
	// ---------------------------------------------------------------------------

	async function buildOrder(side: OrderSide) {
		const addr = get(signerAddress);
		if (!addr) return;

		setState(side, { status: 'loading', error: null });
		try {
			const result = await buildOrderDeployment(selectedStrategy, side, addr);
			setState(side, { status: 'ready', result });
		} catch (e) {
			setState(side, { status: 'error', error: e instanceof Error ? e.message : String(e) });
		}
	}

	// ---------------------------------------------------------------------------
	// Deploy order
	// ---------------------------------------------------------------------------

	async function deployOrder(side: OrderSide) {
		const s = getState(side);
		if (!s.result) return;

		setState(side, { status: 'deploying' });

		try {
			if (deploymentMode === 'eoa') {
				const txHash = await sendOrderTransaction(s.result.args);
				setState(side, { status: 'success', txHash });
			} else {
				if (!safeAddress.trim()) throw new Error('SAFE address required');

				const addr = get(signerAddress);
				if (!addr) throw new Error('Wallet not connected');

				// Use window.ethereum as the provider for Safe SDK
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const provider = (window as any).ethereum;
				if (!provider) throw new Error('No injected wallet found');

				await proposeApprovalsToSafe(safeAddress, addr, provider, s.result.args);
				const { safeTxHash, safeAppUrl } = await proposeToSafe(
					safeAddress,
					addr,
					provider,
					s.result.args
				);

				setState(side, { status: 'success', safeTxHash, safeAppUrl });
			}
		} catch (e) {
			setState(side, { status: 'error', error: e instanceof Error ? e.message : String(e) });
		}
	}
</script>

<!-- =========================================================================
     Layout
     ========================================================================= -->

<div class="min-h-screen bg-gray-950 text-gray-100 p-6 font-mono">
	<!-- Header -->
	<header class="flex items-center justify-between mb-8">
		<h1 class="text-xl font-bold tracking-tight">st0x · order deploy</h1>
		<div>
			{#if $connected && $signerAddress}
				<div class="flex items-center gap-3">
					<span class="text-xs text-gray-400"
						>{$signerAddress.slice(0, 6)}…{$signerAddress.slice(-4)}</span
					>
					<button
						on:click={handleDisconnect}
						class="text-xs px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
						>disconnect</button
					>
				</div>
			{:else}
				<button
					on:click={handleConnect}
					class="text-sm px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 font-semibold"
					>connect wallet</button
				>
			{/if}
		</div>
	</header>

	{#if !$connected}
		<div class="text-center text-gray-500 mt-20">Connect your wallet to deploy orders.</div>
	{:else}
		<!-- Strategy selector -->
		<section class="mb-6">
			<label class="block text-xs text-gray-400 mb-2 uppercase tracking-wider">Strategy</label>
			<div class="flex flex-wrap gap-2">
				{#each STRATEGIES as s (s.name)}
					<button
						on:click={() => selectStrategy(s)}
						class="text-sm px-4 py-2 rounded border transition-colors {selectedStrategy.name ===
						s.name
							? 'bg-blue-700 border-blue-500 text-white'
							: 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500'}">{s.name}</button
					>
				{/each}
			</div>
		</section>

		<!-- Strategy details -->
		<section class="mb-6 text-xs text-gray-400 grid grid-cols-2 md:grid-cols-4 gap-3">
			<div class="bg-gray-900 rounded p-3">
				<div class="text-gray-500 mb-1">network</div>
				<div class="text-gray-200">{selectedStrategy.network} ({selectedStrategy.chainId})</div>
			</div>
			<div class="bg-gray-900 rounded p-3">
				<div class="text-gray-500 mb-1">input token</div>
				<div class="text-gray-200">{selectedStrategy.inputToken.symbol}</div>
				<div class="text-gray-600 truncate">{selectedStrategy.inputToken.address}</div>
			</div>
			<div class="bg-gray-900 rounded p-3">
				<div class="text-gray-500 mb-1">output token</div>
				<div class="text-gray-200">{selectedStrategy.outputToken.symbol}</div>
				<div class="text-gray-600 truncate">{selectedStrategy.outputToken.address}</div>
			</div>
			<div class="bg-gray-900 rounded p-3">
				<div class="text-gray-500 mb-1">spread / timeout</div>
				<div class="text-gray-200">
					{selectedStrategy.baselineMultiplier}x / {selectedStrategy.oraclePriceTimeout}s
				</div>
			</div>
		</section>

		<!-- Deployment mode -->
		<section class="mb-6">
			<label class="block text-xs text-gray-400 mb-2 uppercase tracking-wider">Send via</label>
			<div class="flex gap-3 items-center flex-wrap">
				<button
					on:click={() => (deploymentMode = 'eoa')}
					class="text-sm px-4 py-2 rounded border transition-colors {deploymentMode === 'eoa'
						? 'bg-green-800 border-green-600 text-white'
						: 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500'}"
					>EOA wallet</button
				>
				<button
					on:click={() => (deploymentMode = 'safe')}
					class="text-sm px-4 py-2 rounded border transition-colors {deploymentMode === 'safe'
						? 'bg-green-800 border-green-600 text-white'
						: 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500'}"
					>SAFE multisig</button
				>

				{#if deploymentMode === 'safe'}
					<input
						bind:value={safeAddress}
						placeholder="0x… SAFE address"
						class="ml-2 text-sm px-3 py-2 rounded bg-gray-800 border border-gray-600 text-gray-100 w-80 focus:outline-none focus:border-blue-500"
					/>
				{/if}
			</div>
			{#if deploymentMode === 'safe'}
				<p class="mt-2 text-xs text-gray-500">
					The addOrder tx will be proposed to the SAFE queue. Your connected wallet signs the
					proposal; other owners confirm in the Safe app.
				</p>
			{/if}
		</section>

		<!-- Order cards -->
		<div class="grid md:grid-cols-2 gap-6">
			<!-- BUY card -->
			<div class="bg-gray-900 rounded-xl border border-gray-800 p-5 flex flex-col gap-4">
				<div>
					<h2 class="text-base font-semibold">
						BUY {selectedStrategy.outputToken.symbol}
					</h2>
					<p class="text-xs text-gray-500 mt-1">
						spend {selectedStrategy.depositInputAmount}
						{selectedStrategy.inputToken.symbol} → receive {selectedStrategy.outputToken.symbol}
					</p>
				</div>

				{#if buyState.result?.composedRainlang}
					<details class="text-xs">
						<summary class="cursor-pointer text-gray-400 hover:text-gray-200"
							>view composed rainlang</summary
						>
						<pre
							class="mt-2 bg-gray-950 rounded p-3 overflow-auto text-gray-400 max-h-48 text-xs leading-relaxed">{buyState.result.composedRainlang}</pre>
					</details>
				{/if}

				{#if buyState.error}
					<div class="text-xs text-red-400 bg-red-900/20 rounded p-3 break-words">
						{buyState.error}
					</div>
				{/if}

				{#if buyState.status === 'success'}
					<div class="text-xs text-green-400 bg-green-900/20 rounded p-3">
						{#if buyState.txHash}
							<div>tx confirmed</div>
							<div class="mt-1 text-gray-500 break-all">{buyState.txHash}</div>
						{:else if buyState.safeTxHash}
							<div>proposed to SAFE queue</div>
							<div class="mt-1 text-gray-500 break-all">{buyState.safeTxHash}</div>
							{#if buyState.safeAppUrl}
								<a
									href={buyState.safeAppUrl}
									target="_blank"
									rel="noreferrer"
									class="mt-2 inline-block text-blue-400 underline">view in safe app →</a
								>
							{/if}
						{/if}
					</div>
				{/if}

				<div class="flex gap-3 mt-auto">
					{#if buyState.status === 'idle' || buyState.status === 'error'}
						<button
							on:click={() => buildOrder('buy')}
							class="flex-1 text-sm py-2 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
							>preview</button
						>
					{:else if buyState.status === 'loading'}
						<div class="flex-1 text-sm py-2 text-center text-gray-500">building…</div>
					{:else if buyState.status === 'ready'}
						<button
							on:click={() => buildOrder('buy')}
							class="text-sm py-2 px-3 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
							>rebuild</button
						>
						<button
							on:click={() => deployOrder('buy')}
							class="flex-1 text-sm py-2 rounded bg-blue-700 hover:bg-blue-600 font-semibold"
							>deploy</button
						>
					{:else if buyState.status === 'deploying'}
						<div class="flex-1 text-sm py-2 text-center text-gray-500">deploying…</div>
					{:else if buyState.status === 'success'}
						<button
							on:click={() => buildOrder('buy')}
							class="flex-1 text-sm py-2 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
							>deploy another</button
						>
					{/if}
				</div>
			</div>

			<!-- SELL card -->
			<div class="bg-gray-900 rounded-xl border border-gray-800 p-5 flex flex-col gap-4">
				<div>
					<h2 class="text-base font-semibold">
						SELL {selectedStrategy.outputToken.symbol}
					</h2>
					<p class="text-xs text-gray-500 mt-1">
						sell {selectedStrategy.depositOutputAmount}
						{selectedStrategy.outputToken.symbol} → receive {selectedStrategy.inputToken.symbol}
					</p>
				</div>

				{#if sellState.result?.composedRainlang}
					<details class="text-xs">
						<summary class="cursor-pointer text-gray-400 hover:text-gray-200"
							>view composed rainlang</summary
						>
						<pre
							class="mt-2 bg-gray-950 rounded p-3 overflow-auto text-gray-400 max-h-48 text-xs leading-relaxed">{sellState.result.composedRainlang}</pre>
					</details>
				{/if}

				{#if sellState.error}
					<div class="text-xs text-red-400 bg-red-900/20 rounded p-3 break-words">
						{sellState.error}
					</div>
				{/if}

				{#if sellState.status === 'success'}
					<div class="text-xs text-green-400 bg-green-900/20 rounded p-3">
						{#if sellState.txHash}
							<div>tx confirmed</div>
							<div class="mt-1 text-gray-500 break-all">{sellState.txHash}</div>
						{:else if sellState.safeTxHash}
							<div>proposed to SAFE queue</div>
							<div class="mt-1 text-gray-500 break-all">{sellState.safeTxHash}</div>
							{#if sellState.safeAppUrl}
								<a
									href={sellState.safeAppUrl}
									target="_blank"
									rel="noreferrer"
									class="mt-2 inline-block text-blue-400 underline">view in safe app →</a
								>
							{/if}
						{/if}
					</div>
				{/if}

				<div class="flex gap-3 mt-auto">
					{#if sellState.status === 'idle' || sellState.status === 'error'}
						<button
							on:click={() => buildOrder('sell')}
							class="flex-1 text-sm py-2 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
							>preview</button
						>
					{:else if sellState.status === 'loading'}
						<div class="flex-1 text-sm py-2 text-center text-gray-500">building…</div>
					{:else if sellState.status === 'ready'}
						<button
							on:click={() => buildOrder('sell')}
							class="text-sm py-2 px-3 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
							>rebuild</button
						>
						<button
							on:click={() => deployOrder('sell')}
							class="flex-1 text-sm py-2 rounded bg-blue-700 hover:bg-blue-600 font-semibold"
							>deploy</button
						>
					{:else if sellState.status === 'deploying'}
						<div class="flex-1 text-sm py-2 text-center text-gray-500">deploying…</div>
					{:else if sellState.status === 'success'}
						<button
							on:click={() => buildOrder('sell')}
							class="flex-1 text-sm py-2 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
							>deploy another</button
						>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>
