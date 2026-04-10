<script lang="ts">
	import { connect, disconnect } from '@wagmi/core';
	import { injected } from '@wagmi/connectors';
	import { wagmiConfig, signerAddress, connected } from 'svelte-wagmi';
	import { get } from 'svelte/store';
	import { STRATEGIES, type StrategyConfig, type OrderConfig } from '$lib/config/strategies';
	import { buildOrderDeployment, type DeploymentResult } from '$lib/services/orderDeployment';
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
		orderStates = s.orders.map((o) => emptyState(o));
		showCustomize = s.orders.map(() => false);
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
		// Editable copies of the YAML defaults — these are what actually get deployed
		customFieldValues: Record<string, string>;
		customDeposits: Record<string, string>;
	};

	function emptyState(order: OrderConfig): OrderState {
		return {
			status: 'idle',
			result: null,
			txHash: null,
			safeTxHash: null,
			safeAppUrl: null,
			error: null,
			customFieldValues: { ...order.fieldValues },
			customDeposits: { ...order.deposits }
		};
	}

	let orderStates: OrderState[] = selectedStrategy.orders.map((o) => emptyState(o));
	let showCustomize: boolean[] = selectedStrategy.orders.map(() => false);

	function setOrderState(i: number, patch: Partial<OrderState>) {
		const next = [...orderStates];
		next[i] = { ...next[i], ...patch };
		orderStates = next;
	}

	function toggleCustomize(i: number) {
		const next = [...showCustomize];
		next[i] = !next[i];
		showCustomize = next;
	}

	function resetCustomize(i: number) {
		const order = selectedStrategy.orders[i];
		setOrderState(i, {
			customFieldValues: { ...order.fieldValues },
			customDeposits: { ...order.deposits }
		});
	}

	// Friendly display label for a binding key, e.g. "baseline-multiplier" → "baseline multiplier"
	function fmtKey(k: string) {
		return k.replace(/-/g, ' ');
	}

	// ---------------------------------------------------------------------------
	// Build order (preview)
	// ---------------------------------------------------------------------------

	async function buildOrder(i: number) {
		const addr = get(signerAddress);
		if (!addr) return;

		const s = orderStates[i];
		// Merge custom params over the base order config
		const customizedOrder: OrderConfig = {
			...selectedStrategy.orders[i],
			fieldValues: s.customFieldValues,
			deposits: s.customDeposits
		};

		setOrderState(i, { status: 'loading', error: null });
		try {
			const result = await buildOrderDeployment(customizedOrder, addr);
			setOrderState(i, { status: 'ready', result });
		} catch (e) {
			setOrderState(i, {
				status: 'error',
				error: e instanceof Error ? e.message : String(e)
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Deploy order
	// ---------------------------------------------------------------------------

	async function deployOrder(i: number) {
		const s = orderStates[i];
		if (!s.result) return;

		setOrderState(i, { status: 'deploying' });

		try {
			if (deploymentMode === 'eoa') {
				const txHash = await sendOrderTransaction(s.result.args);
				setOrderState(i, { status: 'success', txHash });
			} else {
				if (!safeAddress.trim()) throw new Error('SAFE address required');
				const addr = get(signerAddress);
				if (!addr) throw new Error('Wallet not connected');
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
				setOrderState(i, { status: 'success', safeTxHash, safeAppUrl });
			}
		} catch (e) {
			setOrderState(i, {
				status: 'error',
				error: e instanceof Error ? e.message : String(e)
			});
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
			{#each selectedStrategy.orders as order, i (order.label)}
				{@const state = orderStates[i]}
				<div class="bg-gray-900 rounded-xl border border-gray-800 p-5 flex flex-col gap-4">
					<!-- Card header -->
					<div class="flex items-start justify-between gap-2">
						<div>
							<h2 class="text-base font-semibold">{order.label}</h2>
							{#if order.description}
								<p class="text-xs text-gray-500 mt-1">{order.description}</p>
							{/if}
							<p class="text-xs text-gray-600 mt-1">
								{order.strategyType} · {order.deploymentKey}
							</p>
						</div>
						<button
							on:click={() => toggleCustomize(i)}
							class="shrink-0 text-xs px-2 py-1 rounded border transition-colors {showCustomize[i]
								? 'bg-yellow-900/40 border-yellow-700 text-yellow-400'
								: 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'}"
							>customize</button
						>
					</div>

					<!-- Customization panel -->
					{#if showCustomize[i]}
						<div class="rounded-lg border border-gray-700 bg-gray-950 p-4 flex flex-col gap-4">
							<!-- Field values -->
							{#if Object.keys(state.customFieldValues).length > 0}
								<div>
									<div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Parameters</div>
									<div class="flex flex-col gap-2">
										{#each Object.keys(state.customFieldValues) as key}
											<label class="flex flex-col gap-1">
												<span class="text-xs text-gray-400">{fmtKey(key)}</span>
												<input
													type="text"
													value={state.customFieldValues[key]}
													on:input={(e) => setOrderState(i, { customFieldValues: { ...state.customFieldValues, [key]: e.currentTarget.value } })}
													class="text-xs px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
												/>
											</label>
										{/each}
									</div>
								</div>
							{/if}

							<!-- Deposits -->
							{#if Object.keys(state.customDeposits).length > 0}
								<div>
									<div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Deposits</div>
									<div class="flex flex-col gap-2">
										{#each Object.keys(state.customDeposits) as key}
											<label class="flex flex-col gap-1">
												<span class="text-xs text-gray-400"
													>token slot <span class="text-gray-300">{key}</span></span
												>
												<input
													type="text"
													value={state.customDeposits[key]}
													on:input={(e) => setOrderState(i, { customDeposits: { ...state.customDeposits, [key]: e.currentTarget.value } })}
													class="text-xs px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
												/>
											</label>
										{/each}
									</div>
								</div>
							{/if}

							<button
								on:click={() => resetCustomize(i)}
								class="self-start text-xs text-gray-500 hover:text-gray-300 underline underline-offset-2"
								>reset to defaults</button
							>
						</div>
					{/if}

					<!-- Composed rainlang -->
					{#if state.result?.composedRainlang}
						<details class="text-xs">
							<summary class="cursor-pointer text-gray-400 hover:text-gray-200"
								>view composed rainlang</summary
							>
							<pre
								class="mt-2 bg-gray-950 rounded p-3 overflow-auto text-gray-400 max-h-48 text-xs leading-relaxed">{state.result.composedRainlang}</pre>
						</details>
					{/if}

					<!-- Error -->
					{#if state.error}
						<div class="text-xs text-red-400 bg-red-900/20 rounded p-3 break-words">
							{state.error}
						</div>
					{/if}

					<!-- Success -->
					{#if state.status === 'success'}
						<div class="text-xs text-green-400 bg-green-900/20 rounded p-3">
							{#if state.txHash}
								<div>tx confirmed</div>
								<div class="mt-1 text-gray-500 break-all">{state.txHash}</div>
							{:else if state.safeTxHash}
								<div>proposed to SAFE queue</div>
								<div class="mt-1 text-gray-500 break-all">{state.safeTxHash}</div>
								{#if state.safeAppUrl}
									<a
										href={state.safeAppUrl}
										target="_blank"
										rel="noreferrer"
										class="mt-2 inline-block text-blue-400 underline">view in safe app →</a
									>
								{/if}
							{/if}
						</div>
					{/if}

					<!-- Actions -->
					<div class="flex gap-3 mt-auto">
						{#if state.status === 'idle' || state.status === 'error'}
							<button
								on:click={() => buildOrder(i)}
								class="flex-1 text-sm py-2 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
								>preview</button
							>
						{:else if state.status === 'loading'}
							<div class="flex-1 text-sm py-2 text-center text-gray-500">building…</div>
						{:else if state.status === 'ready'}
							<button
								on:click={() => buildOrder(i)}
								class="text-sm py-2 px-3 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
								>rebuild</button
							>
							<button
								on:click={() => deployOrder(i)}
								class="flex-1 text-sm py-2 rounded bg-blue-700 hover:bg-blue-600 font-semibold"
								>deploy</button
							>
						{:else if state.status === 'deploying'}
							<div class="flex-1 text-sm py-2 text-center text-gray-500">deploying…</div>
						{:else if state.status === 'success'}
							<button
								on:click={() => buildOrder(i)}
								class="flex-1 text-sm py-2 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
								>deploy another</button
							>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
