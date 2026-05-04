<script lang="ts">
	import { onMount } from 'svelte';
	import { connect, disconnect } from '@wagmi/core';
	import { injected } from '@wagmi/connectors';
	import { wagmiConfig, signerAddress, connected } from 'svelte-wagmi';
	import { get } from 'svelte/store';
	import { STRATEGIES, type StrategyConfig, type OrderConfig } from '$lib/config/strategies';
	import { buildOrderDeployment, type DeploymentResult } from '$lib/services/orderDeployment';
	import { loadRegistryFromSource } from '$lib/services/registryLoader';
	import {
		registrySourceInput,
		loadedRegistry,
		hydrateFromStorage,
		persistSource,
		DEFAULT_SOURCE,
		type LoadedRegistry,
	} from '$lib/stores/registrySource';
	import { sendOrderTransaction, sendOrderTransactionViaTurnkey } from '$lib/stores/wallet';
	import { proposeApprovalsToSafe, proposeToSafe } from '$lib/services/safeDeployment';
	import { connectTurnkeyWallet, type TurnkeyWallet } from '$lib/services/turnkeyService';
	import {
		depositEoa, withdrawEoa,
		depositSafe, withdrawSafe,
		depositTurnkey, withdrawTurnkey,
		type VaultOpInput
	} from '$lib/services/vaultOperations';

	// ── Default orderbook address (Base) ──────────────────────────────────────
	const DEFAULT_ORDERBOOK = '0xe522cB4a5fCb2eb31a52Ff41a4653d85A4fd7C9D';

	// ── Wallet ─────────────────────────────────────────────────────────────────

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

	// ── Deployment mode ────────────────────────────────────────────────────────

	let deploymentMode: 'eoa' | 'safe' | 'turnkey' = 'eoa';
	let safeAddress = '';

	// Turnkey connection state — credentials live in .env (server-only)
	let turnkeyWallet: TurnkeyWallet | null = null;
	let turnkeyConnecting = false;
	let turnkeyConnectError = '';

	async function connectTurnkey() {
		turnkeyConnecting = true;
		turnkeyConnectError = '';
		turnkeyWallet = null;
		try {
			turnkeyWallet = await connectTurnkeyWallet();
		} catch (e) {
			turnkeyConnectError = e instanceof Error ? e.message : String(e);
		} finally {
			turnkeyConnecting = false;
		}
	}

	// Reactive: are we "connected" for the current mode?
	$: isConnected = deploymentMode === 'turnkey'
		? turnkeyWallet !== null
		: $connected;

	// Reactive: the active signer address
	$: connectedAddress = deploymentMode === 'turnkey'
		? (turnkeyWallet?.address ?? '')
		: ($signerAddress ?? '');

	// Invalidate stale order previews when the signer changes (mode switch or wallet reconnect)
	let prevConnectedAddress = '';
	$: if (connectedAddress !== prevConnectedAddress) {
		if (prevConnectedAddress !== '') {
			orderStates = orderStates.map((s) =>
				s.status === 'ready' ? { ...s, status: 'idle', result: null } : s
			);
		}
		prevConnectedAddress = connectedAddress;
	}

	// ── Registry source ────────────────────────────────────────────────────────

	// Local editable state for the four input fields
	let registryOwner = DEFAULT_SOURCE.owner;
	let registryRepo  = DEFAULT_SOURCE.repo;
	let registryRef   = DEFAULT_SOURCE.ref;
	let registryPath  = DEFAULT_SOURCE.path;

	let registryLoadStatus: 'idle' | 'loading' | 'success' | 'error' = 'idle';
	let registryLoadError = '';

	// Derived: all four fields must be non-empty to allow loading
	$: registrySourceValid =
		registryOwner.trim().length > 0 &&
		registryRepo.trim().length > 0 &&
		registryRef.trim().length > 0 &&
		registryPath.trim().length > 0;

	async function loadRegistry() {
		if (!registrySourceValid) return;
		const source = {
			owner: registryOwner.trim(),
			repo:  registryRepo.trim(),
			ref:   registryRef.trim(),
			path:  registryPath.trim(),
		};
		registryLoadStatus = 'loading';
		registryLoadError  = '';
		try {
			const result = await loadRegistryFromSource(source);
			loadedRegistry.set(result);
			registrySourceInput.set(source);
			persistSource(source);
			registryLoadStatus = 'success';
		} catch (e) {
			registryLoadError  = e instanceof Error ? e.message : String(e);
			registryLoadStatus = 'error';
		}
	}

	function clearRegistry() {
		loadedRegistry.set(null);
		registryLoadStatus = 'idle';
		registryLoadError  = '';
	}

	// ── Strategy selection ─────────────────────────────────────────────────────

	// Filter STRATEGIES to those where every order type exists in the loaded registry.
	// Falls back to all STRATEGIES when no registry is loaded.
	function computeAvailableStrategies(registry: LoadedRegistry | null): StrategyConfig[] {
		if (!registry) return STRATEGIES;
		const types = new Set(registry.entries.map((e) => e.strategyType));
		return STRATEGIES.filter((s) => s.orders.every((o) => types.has(o.strategyType)));
	}

	let availableStrategies: StrategyConfig[] = STRATEGIES;
	$: availableStrategies = computeAvailableStrategies($loadedRegistry);

	let selectedStrategy: StrategyConfig = STRATEGIES[0];

	// Auto-reselect when the available list changes (e.g. after loading a registry)
	$: {
		const strats = availableStrategies;
		if (strats.length > 0 && !strats.find((s) => s.name === selectedStrategy.name)) {
			selectStrategy(strats[0]);
		}
	}

	function selectStrategy(s: StrategyConfig) {
		selectedStrategy = s;
		orderStates = s.orders.map((o) => emptyState(o));
		showCustomize = s.orders.map(() => false);
	}

	// ── Per-order state ────────────────────────────────────────────────────────

	type OrderState = {
		status: 'idle' | 'loading' | 'ready' | 'deploying' | 'success' | 'error';
		result: DeploymentResult | null;
		txHash: string | null;
		safeTxHash: string | null;
		safeAppUrl: string | null;
		error: string | null;
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

	function fmtKey(k: string) {
		return k.replace(/-/g, ' ');
	}

	// ── Build order (preview) ──────────────────────────────────────────────────

	async function buildOrder(i: number) {
		if (!connectedAddress) return;
		const s = orderStates[i];
		const customizedOrder: OrderConfig = {
			...selectedStrategy.orders[i],
			fieldValues: s.customFieldValues,
			deposits: s.customDeposits
		};
		setOrderState(i, { status: 'loading', error: null });
		try {
			// Use dynamic registry if loaded, otherwise fall back to static config
			const result = await buildOrderDeployment(
				customizedOrder,
				connectedAddress,
				$loadedRegistry ?? undefined,
			);
			setOrderState(i, { status: 'ready', result });
		} catch (e) {
			setOrderState(i, { status: 'error', error: e instanceof Error ? e.message : String(e) });
		}
	}

	// ── Deploy order ───────────────────────────────────────────────────────────

	async function deployOrder(i: number) {
		const s = orderStates[i];
		if (!s.result) return;
		setOrderState(i, { status: 'deploying' });
		try {
			if (deploymentMode === 'eoa') {
				const txHash = await sendOrderTransaction(s.result.args);
				setOrderState(i, { status: 'success', txHash });
			} else if (deploymentMode === 'safe') {
				if (!safeAddress.trim()) throw new Error('SAFE address required');
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const provider = (window as any).ethereum;
				if (!provider) throw new Error('No injected wallet found');
				await proposeApprovalsToSafe(safeAddress, connectedAddress, provider, s.result.args);
				const { safeTxHash, safeAppUrl } = await proposeToSafe(
					safeAddress, connectedAddress, provider, s.result.args
				);
				setOrderState(i, { status: 'success', safeTxHash, safeAppUrl });
			} else {
				// Turnkey — signing happens server-side
				if (!turnkeyWallet) throw new Error('Turnkey wallet not connected');
				const txHash = await sendOrderTransactionViaTurnkey(s.result.args);
				setOrderState(i, { status: 'success', txHash });
			}
		} catch (e) {
			setOrderState(i, { status: 'error', error: e instanceof Error ? e.message : String(e) });
		}
	}

	// ── Vault operations ───────────────────────────────────────────────────────

	let vaultOp: 'deposit' | 'withdraw' = 'deposit';
	let vaultToken  = '';
	let vaultId     = '';
	let vaultAmount = '';
	let vaultOrderbook = DEFAULT_ORDERBOOK;
	let vaultChainId = 8453; // Base by default
	let vaultStatus: 'idle' | 'busy' | 'success' | 'error' = 'idle';
	let vaultResult = '';
	let vaultError  = '';
	let vaultSafeTxHash = '';
	let vaultSafeAppUrl = '';

	async function executeVaultOp() {
		vaultStatus = 'busy';
		vaultResult = '';
		vaultError  = '';
		vaultSafeTxHash = '';
		vaultSafeAppUrl = '';

		const input: VaultOpInput = {
			tokenAddress:    vaultToken.trim(),
			vaultId:         vaultId.trim(),
			amount:          vaultAmount.trim() || 'all',
			orderbookAddress: vaultOrderbook.trim(),
			chainId:         vaultChainId,
		};

		try {
			if (vaultOp === 'deposit') {
				if (!vaultAmount.trim()) throw new Error('Amount required for deposit');
				if (deploymentMode === 'eoa') {
					const txHash = await depositEoa(input);
					vaultResult = txHash;
				} else if (deploymentMode === 'safe') {
					if (!safeAddress.trim()) throw new Error('SAFE address required');
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const provider = (window as any).ethereum;
					const r = await depositSafe(input, safeAddress, connectedAddress, provider);
					vaultSafeTxHash = r.safeTxHash;
					vaultSafeAppUrl = r.safeAppUrl;
				} else {
					if (!turnkeyWallet) throw new Error('Turnkey wallet not connected');
					const txHash = await depositTurnkey(input);
					vaultResult = txHash;
				}
			} else {
				// withdraw
				if (deploymentMode === 'eoa') {
					const txHash = await withdrawEoa(input, connectedAddress);
					vaultResult = txHash;
				} else if (deploymentMode === 'safe') {
					if (!safeAddress.trim()) throw new Error('SAFE address required');
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const provider = (window as any).ethereum;
					const r = await withdrawSafe(input, safeAddress, connectedAddress, provider);
					vaultSafeTxHash = r.safeTxHash;
					vaultSafeAppUrl = r.safeAppUrl;
				} else {
					if (!turnkeyWallet) throw new Error('Turnkey wallet not connected');
					const txHash = await withdrawTurnkey(input, turnkeyWallet.address);
					vaultResult = txHash;
				}
			}
			vaultStatus = 'success';
		} catch (e) {
			vaultError  = e instanceof Error ? e.message : String(e);
			vaultStatus = 'error';
		}
	}

	// ── Mount ──────────────────────────────────────────────────────────────────

	onMount(() => {
		const stored = hydrateFromStorage();
		registryOwner = stored.owner;
		registryRepo  = stored.repo;
		registryRef   = stored.ref;
		registryPath  = stored.path;
	});
</script>

<!-- =====================================================================
     Layout
     ===================================================================== -->

<div class="min-h-screen bg-gray-950 text-gray-100 p-6 font-mono">

	<!-- Header -->
	<header class="flex items-center justify-between mb-8">
		<div class="flex items-center gap-4">
			<h1 class="text-xl font-bold tracking-tight">st0x · order deploy</h1>
			<a
				href="/dashboard"
				class="text-sm px-3 py-1 rounded border border-gray-700 bg-gray-900 hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
			>dashboard →</a>
		</div>

		<!-- Wallet status in header -->
		<div>
			{#if deploymentMode === 'turnkey'}
				{#if turnkeyWallet}
					<div class="flex items-center gap-3">
						<span class="text-xs text-yellow-400">turnkey</span>
						<span class="text-xs text-gray-400">{turnkeyWallet.address.slice(0,6)}…{turnkeyWallet.address.slice(-4)}</span>
						<button on:click={() => (turnkeyWallet = null)} class="text-xs px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700">disconnect</button>
					</div>
				{:else}
					<span class="text-xs text-gray-500">turnkey not connected</span>
				{/if}
			{:else if $connected && $signerAddress}
				<div class="flex items-center gap-3">
					<span class="text-xs text-gray-400">{$signerAddress.slice(0,6)}…{$signerAddress.slice(-4)}</span>
					<button on:click={handleDisconnect} class="text-xs px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700">disconnect</button>
				</div>
			{:else}
				<button on:click={handleConnect} class="text-sm px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 font-semibold">connect wallet</button>
			{/if}
		</div>
	</header>

	<!-- ── Deployment mode selector (always visible) ───────────────────────── -->
	<section class="mb-6">
		<label class="block text-xs text-gray-400 mb-2 uppercase tracking-wider">Send via</label>
		<div class="flex gap-3 items-start flex-wrap">
			<button
				on:click={() => (deploymentMode = 'eoa')}
				class="text-sm px-4 py-2 rounded border transition-colors {deploymentMode === 'eoa' ? 'bg-green-800 border-green-600 text-white' : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500'}"
			>EOA wallet</button>
			<button
				on:click={() => (deploymentMode = 'safe')}
				class="text-sm px-4 py-2 rounded border transition-colors {deploymentMode === 'safe' ? 'bg-green-800 border-green-600 text-white' : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500'}"
			>SAFE multisig</button>
			<button
				on:click={() => (deploymentMode = 'turnkey')}
				class="text-sm px-4 py-2 rounded border transition-colors {deploymentMode === 'turnkey' ? 'bg-yellow-800 border-yellow-600 text-white' : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500'}"
			>Turnkey</button>

			{#if deploymentMode === 'safe'}
				<input
					bind:value={safeAddress}
					placeholder="0x… SAFE address"
					class="ml-2 text-sm px-3 py-2 rounded bg-gray-800 border border-gray-600 text-gray-100 w-80 focus:outline-none focus:border-blue-500"
				/>
			{/if}
		</div>

		{#if deploymentMode === 'safe'}
			<p class="mt-2 text-xs text-gray-500">Transactions will be proposed to the SAFE queue. Your connected wallet signs; other owners confirm in the Safe app.</p>
		{/if}

		<!-- Turnkey connect panel — credentials are read from .env server-side -->
		{#if deploymentMode === 'turnkey'}
			<div class="mt-4 rounded-lg border border-yellow-900/50 bg-gray-900/60 p-4 max-w-xl flex flex-col gap-3">
				<div class="text-xs text-yellow-500/80 uppercase tracking-wider mb-1">Turnkey</div>
				<p class="text-xs text-gray-500">Credentials are loaded from <code>.env</code> on the server — they are never sent to the browser.</p>
				<div class="flex items-center gap-3">
					<button
						on:click={connectTurnkey}
						disabled={turnkeyConnecting}
						class="text-sm px-4 py-2 rounded bg-yellow-700 hover:bg-yellow-600 disabled:opacity-50 font-semibold"
					>{turnkeyConnecting ? 'connecting…' : turnkeyWallet ? 'reconnect' : 'connect'}</button>
					{#if turnkeyWallet}
						<span class="text-xs text-green-400">connected · {turnkeyWallet.address.slice(0,10)}…</span>
					{/if}
				</div>
				{#if turnkeyConnectError}
					<div class="text-xs text-red-400 bg-red-900/20 rounded p-2 break-words">{turnkeyConnectError}</div>
				{/if}
			</div>
		{/if}
	</section>

	<!-- ── Registry source ────────────────────────────────────────────────── -->
	<section class="mb-6">
		<label class="block text-xs text-gray-400 mb-2 uppercase tracking-wider">Registry source</label>
		<div class="rounded-lg border border-gray-800 bg-gray-900/50 p-4 flex flex-col gap-3">

			<!-- Input grid -->
			<div class="grid grid-cols-2 md:grid-cols-4 gap-2">
				<label class="flex flex-col gap-1">
					<span class="text-xs text-gray-500">owner</span>
					<input
						bind:value={registryOwner}
						placeholder="ST0x-Technology"
						class="text-xs px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
					/>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs text-gray-500">repo</span>
					<input
						bind:value={registryRepo}
						placeholder="st0x-oracle-server"
						class="text-xs px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
					/>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs text-gray-500">ref / commit</span>
					<input
						bind:value={registryRef}
						placeholder="main or commit hash"
						class="text-xs px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
					/>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs text-gray-500">path</span>
					<input
						bind:value={registryPath}
						placeholder="strategy/registry"
						class="text-xs px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
					/>
				</label>
			</div>

			<!-- Actions + status row -->
			<div class="flex items-center gap-3 flex-wrap">
				<button
					on:click={loadRegistry}
					disabled={!registrySourceValid || registryLoadStatus === 'loading'}
					class="text-xs px-4 py-1.5 rounded bg-gray-700 hover:bg-gray-600 border border-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
				>
					{#if registryLoadStatus === 'loading'}
						<span class="inline-flex items-center gap-1.5">
							<svg class="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
								<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
								<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
							</svg>
							loading…
						</span>
					{:else}
						load registry
					{/if}
				</button>

				{#if $loadedRegistry}
					<button
						on:click={clearRegistry}
						class="text-xs px-3 py-1.5 rounded border border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-500 transition-colors"
					>clear</button>
				{/if}

				{#if registryLoadStatus === 'success' && $loadedRegistry}
					<span class="text-xs text-green-400">
						✓ {$loadedRegistry.entries.length} strategy type{$loadedRegistry.entries.length !== 1 ? 's' : ''} loaded
						({availableStrategies.length} of {STRATEGIES.length} configured strategies available)
					</span>
				{/if}

				{#if registryLoadStatus === 'error'}
					<span class="text-xs text-red-400 break-words max-w-md">{registryLoadError}</span>
				{/if}
			</div>

			<!-- Active source display -->
			{#if $loadedRegistry}
				<div class="text-xs font-mono text-gray-500 bg-gray-800/50 rounded px-2 py-1 w-fit">
					active: {$loadedRegistry.source.owner}/{$loadedRegistry.source.repo}@{$loadedRegistry.source.ref.slice(0, 12)}/{$loadedRegistry.source.path}
				</div>
			{:else}
				<div class="text-xs font-mono text-gray-600 bg-gray-800/30 rounded px-2 py-1 w-fit">
					active: {DEFAULT_SOURCE.owner}/{DEFAULT_SOURCE.repo}@{DEFAULT_SOURCE.ref.slice(0, 12)}/{DEFAULT_SOURCE.path}
					<span class="text-gray-700 ml-1">(static config — click "load registry" to override)</span>
				</div>
			{/if}
		</div>
	</section>

	<!-- ── Strategy selector ───────────────────────────────────────────────── -->
	<section class="mb-6">
		<div class="flex items-center gap-3 mb-2">
			<label class="text-xs text-gray-400 uppercase tracking-wider">Strategy</label>
			{#if $loadedRegistry && availableStrategies.length < STRATEGIES.length}
				<span class="text-xs text-gray-600">
					({availableStrategies.length} of {STRATEGIES.length} match loaded registry)
				</span>
			{/if}
		</div>

		{#if availableStrategies.length === 0}
			<div class="text-xs text-yellow-500/80 bg-yellow-900/10 border border-yellow-900/40 rounded p-3 max-w-xl">
				No configured strategies match the loaded registry's strategy types.
				<button on:click={clearRegistry} class="underline ml-1 hover:text-yellow-400">clear registry</button>
				to fall back to all strategies.
			</div>
		{:else}
			<div class="flex flex-wrap gap-2">
				{#each availableStrategies as s (s.name)}
					<button
						on:click={() => selectStrategy(s)}
						class="text-sm px-4 py-2 rounded border transition-colors {selectedStrategy.name === s.name ? 'bg-blue-700 border-blue-500 text-white' : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500'}"
					>{s.name}</button>
				{/each}
			</div>
		{/if}
	</section>

	{#if !isConnected}
		<div class="mb-4 text-xs text-gray-500 bg-gray-900/50 rounded px-4 py-2 border border-gray-800">
			{#if deploymentMode === 'turnkey'}
				Connect Turnkey above to enable preview &amp; deploy.
			{:else}
				Connect your wallet (header) to enable preview &amp; deploy.
			{/if}
		</div>
	{/if}

	<!-- ── Order cards ─────────────────────────────────────────────────────── -->
	<div class="grid md:grid-cols-2 gap-6 mb-10">
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
						<p class="text-xs text-gray-600 mt-1">{order.strategyType} · {order.deploymentKey}</p>
					</div>
					<button
						on:click={() => toggleCustomize(i)}
						class="shrink-0 text-xs px-2 py-1 rounded border transition-colors {showCustomize[i] ? 'bg-yellow-900/40 border-yellow-700 text-yellow-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'}"
					>customize</button>
				</div>

				<!-- Customization panel -->
				{#if showCustomize[i]}
					<div class="rounded-lg border border-gray-700 bg-gray-950 p-4 flex flex-col gap-4">
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
						{#if Object.keys(state.customDeposits).length > 0}
							<div>
								<div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Deposits</div>
								<div class="flex flex-col gap-2">
									{#each Object.keys(state.customDeposits) as key}
										<label class="flex flex-col gap-1">
											<span class="text-xs text-gray-400">token slot <span class="text-gray-300">{key}</span></span>
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
						<!-- Vault IDs from tokens.yaml (read-only display) -->
						{#if order.vaultIds && Object.keys(order.vaultIds).length > 0}
							<div>
								<div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Word (vault) IDs</div>
								<div class="flex flex-col gap-1">
									{#each Object.entries(order.vaultIds) as [ioType, tokens]}
										{#each Object.entries(tokens) as [tokenKey, vaultId]}
											<div class="flex gap-2 text-xs">
												<span class="text-gray-500 w-16 shrink-0">{ioType}/{tokenKey}</span>
												<span class="text-gray-400 font-mono break-all">{vaultId}</span>
											</div>
										{/each}
									{/each}
								</div>
							</div>
						{/if}
						<button
							on:click={() => resetCustomize(i)}
							class="self-start text-xs text-gray-500 hover:text-gray-300 underline underline-offset-2"
						>reset to defaults</button>
					</div>
				{/if}

				<!-- Composed rainlang -->
				{#if state.result?.composedRainlang}
					<details class="text-xs">
						<summary class="cursor-pointer text-gray-400 hover:text-gray-200">view composed rainlang</summary>
						<pre class="mt-2 bg-gray-950 rounded p-3 overflow-auto text-gray-400 max-h-48 text-xs leading-relaxed">{state.result.composedRainlang}</pre>
					</details>
				{/if}

				<!-- Error -->
				{#if state.error}
					<div class="text-xs text-red-400 bg-red-900/20 rounded p-3 break-words">{state.error}</div>
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
								<a href={state.safeAppUrl} target="_blank" rel="noreferrer" class="mt-2 inline-block text-blue-400 underline">view in safe app →</a>
							{/if}
						{/if}
						<!-- Show resolved vault IDs after deploy -->
						{#if state.result?.vaultIds && Object.keys(state.result.vaultIds).length > 0}
							<div class="mt-2 border-t border-green-900/40 pt-2">
								<div class="text-green-600 mb-1">vault IDs</div>
								{#each Object.entries(state.result.vaultIds) as [ioType, tokens]}
									{#each Object.entries(tokens) as [tokenKey, vid]}
										<div class="flex gap-2 text-xs">
											<span class="text-gray-500 w-16 shrink-0">{ioType}/{tokenKey}</span>
											<span class="font-mono break-all text-gray-400">{vid}</span>
										</div>
									{/each}
								{/each}
							</div>
						{/if}
					</div>
				{/if}

				<!-- Actions -->
				<div class="flex gap-3 mt-auto">
					{#if state.status === 'idle' || state.status === 'error'}
						<button on:click={() => buildOrder(i)} disabled={!isConnected} class="flex-1 text-sm py-2 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed">preview</button>
					{:else if state.status === 'loading'}
						<div class="flex-1 text-sm py-2 text-center text-gray-500">building…</div>
					{:else if state.status === 'ready'}
						<button on:click={() => buildOrder(i)} disabled={!isConnected} class="text-sm py-2 px-3 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed">rebuild</button>
						<button on:click={() => deployOrder(i)} disabled={!isConnected} class="flex-1 text-sm py-2 rounded bg-blue-700 hover:bg-blue-600 font-semibold disabled:opacity-40 disabled:cursor-not-allowed">deploy</button>
					{:else if state.status === 'deploying'}
						<div class="flex-1 text-sm py-2 text-center text-gray-500">deploying…</div>
					{:else if state.status === 'success'}
						<button on:click={() => buildOrder(i)} class="flex-1 text-sm py-2 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700">deploy another</button>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	<!-- ── Vault operations ────────────────────────────────────────────────── -->
	<section class="border-t border-gray-800 pt-8">
		<h2 class="text-sm font-semibold text-gray-300 mb-4 uppercase tracking-wider">Vault operations</h2>

		<!-- Op toggle -->
		<div class="flex gap-3 mb-4">
			<button
				on:click={() => { vaultOp = 'deposit'; vaultStatus = 'idle'; }}
				class="text-sm px-4 py-2 rounded border transition-colors {vaultOp === 'deposit' ? 'bg-blue-800 border-blue-600 text-white' : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500'}"
			>deposit</button>
			<button
				on:click={() => { vaultOp = 'withdraw'; vaultStatus = 'idle'; }}
				class="text-sm px-4 py-2 rounded border transition-colors {vaultOp === 'withdraw' ? 'bg-purple-800 border-purple-600 text-white' : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500'}"
			>withdraw</button>
		</div>

		<!-- Form -->
		<div class="grid sm:grid-cols-2 gap-4 max-w-2xl">
			<label class="flex flex-col gap-1">
				<span class="text-xs text-gray-400">Token address</span>
				<input bind:value={vaultToken} placeholder="0x…" class="text-xs px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-100 focus:outline-none focus:border-blue-500 font-mono" />
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-xs text-gray-400">Vault ID (bytes32)</span>
				<input bind:value={vaultId} placeholder="0x0000…0001" class="text-xs px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-100 focus:outline-none focus:border-blue-500 font-mono" />
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-xs text-gray-400">Amount{vaultOp === 'withdraw' ? ' (leave blank to withdraw all)' : ''}</span>
				<input bind:value={vaultAmount} placeholder={vaultOp === 'withdraw' ? 'all' : '100.0'} class="text-xs px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-100 focus:outline-none focus:border-blue-500 font-mono" />
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-xs text-gray-400">Chain</span>
				<select bind:value={vaultChainId} class="text-xs px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-100 focus:outline-none focus:border-blue-500 font-mono">
					<option value={8453}>Base (8453)</option>
					<option value={137}>Polygon (137)</option>
					<option value={42161}>Arbitrum (42161)</option>
				</select>
			</label>
			<label class="flex flex-col gap-1 sm:col-span-2">
				<span class="text-xs text-gray-400">Orderbook address</span>
				<input bind:value={vaultOrderbook} class="text-xs px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-100 focus:outline-none focus:border-blue-500 font-mono" />
			</label>
		</div>

		<!-- Submit -->
		<button
			on:click={executeVaultOp}
			disabled={vaultStatus === 'busy' || !isConnected}
			class="mt-4 text-sm px-5 py-2 rounded font-semibold disabled:opacity-50 transition-colors {vaultOp === 'deposit' ? 'bg-blue-700 hover:bg-blue-600' : 'bg-purple-700 hover:bg-purple-600'}"
		>{vaultStatus === 'busy' ? (vaultOp === 'deposit' ? 'depositing…' : 'withdrawing…') : vaultOp}</button>

		<!-- Vault result -->
		{#if vaultStatus === 'success'}
			<div class="mt-3 text-xs text-green-400 bg-green-900/20 rounded p-3 max-w-2xl">
				{#if vaultResult}
					<div>{vaultOp} confirmed</div>
					<div class="mt-1 text-gray-500 break-all">{vaultResult}</div>
				{:else if vaultSafeTxHash}
					<div>{vaultOp} proposed to SAFE queue</div>
					<div class="mt-1 text-gray-500 break-all">{vaultSafeTxHash}</div>
					{#if vaultSafeAppUrl}
						<a href={vaultSafeAppUrl} target="_blank" rel="noreferrer" class="mt-2 inline-block text-blue-400 underline">view in safe app →</a>
					{/if}
				{/if}
			</div>
		{/if}
		{#if vaultStatus === 'error'}
			<div class="mt-3 text-xs text-red-400 bg-red-900/20 rounded p-3 max-w-2xl break-words">{vaultError}</div>
		{/if}

		{#if deploymentMode === 'safe' && vaultOp === 'deposit'}
			<p class="mt-2 text-xs text-gray-600">Safe deposit: approve + deposit4 are proposed as two sequential transactions to the SAFE queue.</p>
		{/if}
	</section>

</div>
