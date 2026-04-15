<script lang="ts">
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { connect, disconnect } from '@wagmi/core';
	import { injected } from '@wagmi/connectors';
	import { wagmiConfig, signerAddress, connected } from 'svelte-wagmi';
	import { sendTransaction, waitForTransactionReceipt } from '@wagmi/core';
	import type { RaindexClient, RaindexOrder, RaindexVault, GetOrdersTokenFilter } from '@rainlanguage/orderbook';
	import type { Address } from 'viem';
	import { getOrderbookClient } from '$lib/services/raindexClient';
	import { STRATEGIES } from '$lib/config/strategies';
	import {
		proposeSingleTx,
		getNextNonce,
		SAFE_TX_SERVICE_URLS
	} from '$lib/services/safeDeployment';
	import { connectTurnkeyWallet, sendViaTurnkey, type TurnkeyWallet } from '$lib/services/turnkeyService';
	import { depositEoa, withdrawEoa, depositSafe, withdrawSafe, depositTurnkey, withdrawTurnkey, type VaultOpInput } from '$lib/services/vaultOperations';
	import type { Hex } from 'viem';


	const PAGE_SIZE = 25;

	// ── Raindex client ─────────────────────────────────────────────────────────
	let client: RaindexClient | null = null;
	let initError: string | null = null;
	let initializing = true;

	// ── Wallet / deployment mode ───────────────────────────────────────────────
	let deploymentMode: 'eoa' | 'safe' | 'turnkey' = 'eoa';
	let safeAddress = '';
	let turnkeyWallet: TurnkeyWallet | null = null;
	let turnkeyConnecting = false;
	let turnkeyConnectError = '';

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
	async function connectTurnkey() {
		turnkeyConnecting = true;
		turnkeyConnectError = '';
		turnkeyWallet = null;
		try { turnkeyWallet = await connectTurnkeyWallet(); }
		catch (e) { turnkeyConnectError = e instanceof Error ? e.message : String(e); }
		finally { turnkeyConnecting = false; }
	}

	$: isConnected = deploymentMode === 'turnkey' ? turnkeyWallet !== null : $connected;
	$: connectedAddress = deploymentMode === 'turnkey' ? (turnkeyWallet?.address ?? '') : ($signerAddress ?? '');

	// ── Filters ────────────────────────────────────────────────────────────────
	let ownerFilterInput = '';
	let ownerFilter = '';
	let showInactive = false;
	let selectedPair = 'All';

	// ── Results ────────────────────────────────────────────────────────────────
	let orders: RaindexOrder[] = [];
	let totalCount = 0;
	let currentPage = 1;
	let fetchError: string | null = null;
	let fetching = false;

	// ── Expanded state ─────────────────────────────────────────────────────────
	let expandedOrders = new Set<string>(); // orderHash

	// ── Remove order state ─────────────────────────────────────────────────────
	type RemoveState = { status: 'idle' | 'busy' | 'success' | 'error'; error: string };
	let removeStates = new Map<string, RemoveState>(); // orderHash → state

	// ── Vault op state per vault ───────────────────────────────────────────────
	// key: `${orderHash}:${ioType}:${vaultId}`
	type VaultOpState = {
		mode: 'none' | 'deposit' | 'withdraw';
		amount: string;
		status: 'idle' | 'busy' | 'success' | 'error';
		error: string;
		result: string;
		safeTxHash: string;
		safeAppUrl: string;
	};
	let vaultOpStates = new Map<string, VaultOpState>();

	function vaultKey(orderHash: string, ioType: 'input' | 'output', vault: RaindexVault) {
		return `${orderHash}:${ioType}:${vault.vaultId}`;
	}
	function getVaultOp(key: string): VaultOpState {
		if (!vaultOpStates.has(key)) {
			vaultOpStates.set(key, { mode: 'none', amount: '', status: 'idle', error: '', result: '', safeTxHash: '', safeAppUrl: '' });
		}
		return vaultOpStates.get(key)!;
	}
	function setVaultOp(key: string, patch: Partial<VaultOpState>) {
		vaultOpStates.set(key, { ...getVaultOp(key), ...patch });
		vaultOpStates = vaultOpStates;
	}

	// ── Mount ──────────────────────────────────────────────────────────────────
	onMount(async () => {
		try {
			client = await getOrderbookClient();
			await fetchOrders();
		} catch (e) {
			initError = e instanceof Error ? e.message : String(e);
		} finally {
			initializing = false;
		}
	});

	// ── Token pair grouping ────────────────────────────────────────────────────
	const STABLES = new Set(['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD']);
	const STRATEGY_ORDER = new Map(STRATEGIES.map((s, i) => [s.name, i]));

	function getPairKey(order: RaindexOrder): string {
		const syms = new Set([
			...order.inputsList.items.map((v) => v.token.symbol ?? '?'),
			...order.outputsList.items.map((v) => v.token.symbol ?? '?')
		]);
		const wt = [...syms].find((s) => !STABLES.has(s));
		const stable = [...syms].find((s) => STABLES.has(s));
		if (wt && stable) return `${wt}/${stable}`;
		return [...syms].join('/');
	}

	/**
	 * Accumulated map of pairKey → unique token addresses for that pair.
	 * Persists across page changes so tabs are stable even when a pair filter
	 * is active and `orders` only contains that pair's results.
	 */
	let pairTokenAddrs = new Map<string, Address[]>();

	function updatePairTokenMap(newOrders: RaindexOrder[]) {
		let changed = false;
		for (const order of newOrders) {
			const key = getPairKey(order);
			if (!pairTokenAddrs.has(key)) {
				const addrs = new Set<string>();
				order.inputsList.items.forEach((v) => addrs.add(v.token.address));
				order.outputsList.items.forEach((v) => addrs.add(v.token.address));
				pairTokenAddrs.set(key, [...addrs] as Address[]);
				changed = true;
			}
		}
		if (changed) pairTokenAddrs = pairTokenAddrs; // trigger reactivity
	}

	$: pairTabs = [...pairTokenAddrs.keys()].sort((a, b) => {
		const ia = STRATEGY_ORDER.get(a) ?? 999;
		const ib = STRATEGY_ORDER.get(b) ?? 999;
		return ia - ib;
	});

	// ── Fetch ──────────────────────────────────────────────────────────────────
	async function fetchOrders(resetPage = false) {
		if (!client) return;
		if (resetPage) currentPage = 1;
		fetching = true;
		fetchError = null;
		try {
			// When a specific pair is selected, filter server-side by both token
			// addresses so ALL pages for that pair are correct (not just client-side
			// filtering on the current 25 results).
			let tokenFilter: GetOrdersTokenFilter | undefined;
			if (selectedPair !== 'All') {
				const addrs = pairTokenAddrs.get(selectedPair);
				if (addrs) tokenFilter = { inputs: addrs, outputs: addrs };
			}

			const result = await client.getOrders(
				null,
				{
					owners: ownerFilter.trim() ? [ownerFilter.trim() as `0x${string}`] : [],
					active: showInactive ? undefined : true,
					tokens: tokenFilter,
				},
				currentPage,
				PAGE_SIZE
			);
			if (result.error) { fetchError = result.error.readableMsg; return; }
			orders = result.value.orders;
			totalCount = result.value.totalCount;
			updatePairTokenMap(orders);
		} catch (e) {
			fetchError = e instanceof Error ? e.message : String(e);
		} finally {
			fetching = false;
		}
	}

	function applyOwnerFilter() { ownerFilter = ownerFilterInput; selectedPair = 'All'; fetchOrders(true); }
	function clearOwnerFilter() { ownerFilterInput = ''; ownerFilter = ''; selectedPair = 'All'; fetchOrders(true); }
	function handleOwnerKeydown(e: KeyboardEvent) { if (e.key === 'Enter') applyOwnerFilter(); }
	function toggleInactive() { showInactive = !showInactive; selectedPair = 'All'; fetchOrders(true); }
	function selectPair(pair: string) { selectedPair = pair; fetchOrders(true); }
	function prevPage() { if (currentPage > 1) { currentPage--; fetchOrders(); } }
	function nextPage() { if (currentPage * PAGE_SIZE < totalCount) { currentPage++; fetchOrders(); } }

	function toggleOrder(hash: string) {
		if (expandedOrders.has(hash)) expandedOrders.delete(hash);
		else expandedOrders.add(hash);
		expandedOrders = expandedOrders;
	}

	$: totalPages = Math.ceil(totalCount / PAGE_SIZE);

	// ── Helpers ────────────────────────────────────────────────────────────────
	function fmtAddress(addr: string) { return addr.slice(0, 6) + '…' + addr.slice(-4); }
	function fmtTimestamp(ts: bigint) { return new Date(Number(ts) * 1000).toLocaleString(); }

	function vaultIdToBytes32(id: bigint): string {
		return '0x' + id.toString(16).padStart(64, '0');
	}

	type VaultSection = { label: string; items: RaindexVault[]; ioType: 'input' | 'output'; color: string };
	function getVaultSections(order: RaindexOrder): VaultSection[] {
		return [
			{ label: 'Input vaults',  items: order.inputsList.items,  ioType: 'input',  color: 'text-blue-400'   },
			{ label: 'Output vaults', items: order.outputsList.items, ioType: 'output', color: 'text-purple-400' },
		];
	}

	// ── Remove order ───────────────────────────────────────────────────────────
	async function removeOrder(order: RaindexOrder) {
		const key = order.orderHash;
		removeStates.set(key, { status: 'busy', error: '' });
		removeStates = removeStates;
		try {
			const r = order.getRemoveCalldata();
			if (r.error) throw new Error(r.error.readableMsg);
			const calldata = r.value;

			if (deploymentMode === 'eoa') {
				const config = get(wagmiConfig);
				if (!config) throw new Error('Wagmi not initialised');
				const hash = await sendTransaction(config, {
					to: order.orderbook as Hex,
					data: calldata,
					chainId: order.chainId
				});
				await waitForTransactionReceipt(config, { hash });
			} else if (deploymentMode === 'safe') {
				if (!safeAddress.trim()) throw new Error('Safe address required');
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const provider = (window as any).ethereum;
				if (!provider) throw new Error('No injected wallet');
				const txServiceUrl = SAFE_TX_SERVICE_URLS[order.chainId];
				if (!txServiceUrl) throw new Error(`No Safe service for chain ${order.chainId}`);
				const nonce = await getNextNonce(txServiceUrl, safeAddress);
				await proposeSingleTx(txServiceUrl, order.chainId, safeAddress, connectedAddress, provider, order.orderbook, calldata, nonce);
			} else {
				if (!turnkeyWallet) throw new Error('Turnkey wallet not connected');
				await sendViaTurnkey([{ to: order.orderbook, data: calldata }], order.chainId);
			}

			removeStates.set(key, { status: 'success', error: '' });
			// Refresh so removed order disappears
			await fetchOrders();
		} catch (e) {
			removeStates.set(key, { status: 'error', error: e instanceof Error ? e.message : String(e) });
			removeStates = removeStates;
		}
	}

	// ── Vault operations ───────────────────────────────────────────────────────
	async function executeVaultOp(order: RaindexOrder, ioType: 'input' | 'output', vault: RaindexVault) {
		const key = vaultKey(order.orderHash, ioType, vault);
		const state = getVaultOp(key);
		const op = state.mode === 'none' ? 'deposit' : state.mode;
		setVaultOp(key, { status: 'busy', error: '', result: '', safeTxHash: '', safeAppUrl: '' });

		const input: VaultOpInput = {
			tokenAddress: vault.token.address,
			vaultId: vaultIdToBytes32(vault.vaultId),
			amount: state.amount.trim() || 'all',
			orderbookAddress: vault.orderbook,
			chainId: vault.chainId
		};

		try {
			if (op === 'deposit') {
				if (!state.amount.trim()) throw new Error('Amount required for deposit');
				if (deploymentMode === 'eoa') {
					const txHash = await depositEoa(input);
					setVaultOp(key, { status: 'success', result: txHash });
				} else if (deploymentMode === 'safe') {
					if (!safeAddress.trim()) throw new Error('Safe address required');
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const provider = (window as any).ethereum;
					const r = await depositSafe(input, safeAddress, connectedAddress, provider);
					setVaultOp(key, { status: 'success', safeTxHash: r.safeTxHash, safeAppUrl: r.safeAppUrl });
				} else {
					if (!turnkeyWallet) throw new Error('Turnkey wallet not connected');
					const txHash = await depositTurnkey(input);
					setVaultOp(key, { status: 'success', result: txHash });
				}
			} else {
				if (deploymentMode === 'eoa') {
					const txHash = await withdrawEoa(input, connectedAddress);
					setVaultOp(key, { status: 'success', result: txHash });
				} else if (deploymentMode === 'safe') {
					if (!safeAddress.trim()) throw new Error('Safe address required');
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const provider = (window as any).ethereum;
					const r = await withdrawSafe(input, safeAddress, connectedAddress, provider);
					setVaultOp(key, { status: 'success', safeTxHash: r.safeTxHash, safeAppUrl: r.safeAppUrl });
				} else {
					if (!turnkeyWallet) throw new Error('Turnkey wallet not connected');
					const txHash = await withdrawTurnkey(input, turnkeyWallet.address);
					setVaultOp(key, { status: 'success', result: txHash });
				}
			}
		} catch (e) {
			setVaultOp(key, { status: 'error', error: e instanceof Error ? e.message : String(e) });
		}
	}
</script>

<div class="min-h-screen bg-gray-950 text-gray-100 font-mono">
	<!-- Header -->
	<header class="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
		<div class="flex items-center gap-4">
			<a href="/" class="text-gray-500 hover:text-gray-300 text-sm">← deploy</a>
			<h1 class="text-lg font-bold tracking-tight">st0x · orderbook dashboard</h1>
			<a
				href="/export"
				class="text-sm px-3 py-1 rounded border border-gray-700 bg-gray-900 hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
				>export →</a
			>
		</div>
		<!-- Wallet status -->
		<div>
			{#if deploymentMode === 'turnkey'}
				{#if turnkeyWallet}
					<div class="flex items-center gap-3">
						<span class="text-xs text-yellow-400">turnkey</span>
						<span class="text-xs text-gray-400">{fmtAddress(turnkeyWallet.address)}</span>
						<button on:click={() => (turnkeyWallet = null)} class="text-xs px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700">disconnect</button>
					</div>
				{:else}
					<span class="text-xs text-gray-500">turnkey not connected</span>
				{/if}
			{:else if $connected && $signerAddress}
				<div class="flex items-center gap-3">
					<span class="text-xs text-gray-400">{fmtAddress($signerAddress)}</span>
					<button on:click={handleDisconnect} class="text-xs px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700">disconnect</button>
				</div>
			{:else}
				<button on:click={handleConnect} class="text-sm px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 font-semibold">connect wallet</button>
			{/if}
		</div>
	</header>

	<main class="px-6 py-6 max-w-7xl mx-auto">
		{#if initError}
			<div class="bg-red-900/30 border border-red-700 rounded-lg p-4 text-sm text-red-300 mb-6">{initError}</div>
		{/if}

		{#if initializing}
			<div class="flex items-center gap-3 text-gray-400 mt-20 justify-center">
				<svg class="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
				</svg>
				<span class="text-sm">initializing subgraph client…</span>
			</div>
		{:else if !initError}

			<!-- ── Wallet mode ────────────────────────────────────────────────────── -->
			<section class="mb-6">
				<div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Wallet mode (for remove / vault ops)</div>
				<div class="flex gap-3 items-start flex-wrap">
					<button on:click={() => (deploymentMode = 'eoa')}
						class="text-sm px-4 py-2 rounded border transition-colors {deploymentMode === 'eoa' ? 'bg-green-800 border-green-600 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'}"
					>EOA wallet</button>
					<button on:click={() => (deploymentMode = 'safe')}
						class="text-sm px-4 py-2 rounded border transition-colors {deploymentMode === 'safe' ? 'bg-green-800 border-green-600 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'}"
					>SAFE multisig</button>
					<button on:click={() => (deploymentMode = 'turnkey')}
						class="text-sm px-4 py-2 rounded border transition-colors {deploymentMode === 'turnkey' ? 'bg-yellow-800 border-yellow-600 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'}"
					>Turnkey</button>
					{#if deploymentMode === 'safe'}
						<input bind:value={safeAddress} placeholder="0x… SAFE address"
							class="text-sm px-3 py-2 rounded bg-gray-800 border border-gray-600 text-gray-100 w-80 focus:outline-none focus:border-blue-500" />
					{/if}
					{#if deploymentMode === 'turnkey' && !turnkeyWallet}
						<button on:click={connectTurnkey} disabled={turnkeyConnecting}
							class="text-sm px-4 py-2 rounded bg-yellow-700 hover:bg-yellow-600 disabled:opacity-50 font-semibold"
						>{turnkeyConnecting ? 'connecting…' : 'connect turnkey'}</button>
					{/if}
				</div>
				{#if turnkeyConnectError}
					<div class="mt-2 text-xs text-red-400 bg-red-900/20 rounded p-2 max-w-xl break-words">{turnkeyConnectError}</div>
				{/if}
			</section>

			<!-- ── Filters ────────────────────────────────────────────────────────── -->
			<section class="mb-6 flex flex-wrap gap-4 items-end">
				<div class="flex flex-col gap-1">
					<div class="text-xs text-gray-400 uppercase tracking-wider">Order Owner</div>
					<div class="flex gap-2">
						<input type="text" bind:value={ownerFilterInput} on:keydown={handleOwnerKeydown}
							placeholder="0x… address"
							class="text-sm px-3 py-2 rounded bg-gray-900 border border-gray-700 text-gray-100 w-80 focus:outline-none focus:border-blue-500 placeholder-gray-600" />
						<button on:click={applyOwnerFilter} class="text-sm px-4 py-2 rounded bg-blue-700 hover:bg-blue-600 font-semibold">filter</button>
						{#if ownerFilter}
							<button on:click={clearOwnerFilter} class="text-sm px-3 py-2 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400">clear</button>
						{/if}
					</div>
				</div>
				<div class="flex flex-col gap-1">
					<div class="text-xs text-gray-400 uppercase tracking-wider">Status</div>
					<div class="flex gap-2">
						<button on:click={() => { if (showInactive) toggleInactive(); }}
							class="text-sm px-4 py-2 rounded border transition-colors {!showInactive ? 'bg-green-800 border-green-600 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'}"
						>active only</button>
						<button on:click={() => { if (!showInactive) toggleInactive(); }}
							class="text-sm px-4 py-2 rounded border transition-colors {showInactive ? 'bg-gray-700 border-gray-500 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'}"
						>all orders</button>
					</div>
				</div>
			</section>

			{#if ownerFilter}
				<div class="mb-4 flex items-center gap-2">
					<span class="text-xs text-gray-500">filtering by owner:</span>
					<span class="text-xs bg-blue-900/40 border border-blue-700 text-blue-300 px-2 py-0.5 rounded font-mono">{ownerFilter}</span>
				</div>
			{/if}

			{#if fetchError}
				<div class="bg-red-900/30 border border-red-700 rounded-lg p-4 text-sm text-red-300 mb-4">{fetchError}</div>
			{/if}

			<!-- ── Token pair tabs ─────────────────────────────────────────────────── -->
			{#if pairTabs.length > 0}
				<div class="mb-5 flex flex-wrap gap-2">
					<button on:click={() => selectPair('All')}
						class="text-sm px-4 py-1.5 rounded border transition-colors {selectedPair === 'All' ? 'bg-blue-700 border-blue-500 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'}"
					>All</button>
					{#each pairTabs as pair}
						<button on:click={() => selectPair(pair)}
							class="text-sm px-4 py-1.5 rounded border transition-colors {selectedPair === pair ? 'bg-blue-700 border-blue-500 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'}"
						>{pair}</button>
					{/each}
				</div>
			{/if}

			<!-- Summary -->
			<div class="flex items-center justify-between mb-4">
				<div class="text-xs text-gray-500">
					{#if fetching}loading…
					{:else}{totalCount}{selectedPair !== 'All' ? ` ${selectedPair}` : ''} order{totalCount !== 1 ? 's' : ''} · page {currentPage} of {Math.max(1, totalPages)}
					{/if}
				</div>
				{#if fetching}
					<svg class="animate-spin h-4 w-4 text-gray-500" viewBox="0 0 24 24" fill="none">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
					</svg>
				{/if}
			</div>

			<!-- ── Order cards ─────────────────────────────────────────────────────── -->
			{#if orders.length === 0 && !fetching}
				<div class="text-center text-gray-600 py-20 text-sm">no orders found</div>
			{:else}
				<div class="space-y-3">
					{#each orders as order (order.orderHash)}
						{@const isExpanded = expandedOrders.has(order.orderHash)}
						{@const removeState = removeStates.get(order.orderHash) ?? { status: 'idle', error: '' }}
						<div class="bg-gray-900 rounded-xl border transition-colors {order.active ? 'border-gray-800' : 'border-gray-800/50 opacity-70'}">

							<!-- Order row -->
							<div class="px-5 py-4 flex flex-wrap items-center gap-x-5 gap-y-2">
								<!-- Status badge -->
								<span class="shrink-0 text-xs px-2 py-0.5 rounded-full font-semibold {order.active ? 'bg-green-900/50 text-green-400 border border-green-800' : 'bg-gray-800 text-gray-500 border border-gray-700'}">
									{order.active ? 'active' : 'inactive'}
								</span>

								<!-- Chain -->
								<span class="shrink-0 text-xs text-gray-500">chain {order.chainId}</span>

								<!-- Hash -->
								<span class="font-mono text-xs text-gray-300" title={order.orderHash}>{fmtAddress(order.orderHash)}</span>

								<!-- Owner -->
								<div class="flex items-center gap-1.5">
									<span class="text-xs text-gray-600">owner</span>
									<span class="font-mono text-xs text-gray-400" title={order.owner}>{fmtAddress(order.owner)}</span>
								</div>

								<!-- Pair key -->
								<span class="text-xs text-blue-400 font-semibold">{getPairKey(order)}</span>

								<!-- Timestamp -->
								<span class="text-xs text-gray-600 ml-auto">{fmtTimestamp(order.timestampAdded)}</span>

								<!-- Expand toggle -->
								<button on:click={() => toggleOrder(order.orderHash)}
									class="shrink-0 text-xs px-3 py-1 rounded border transition-colors {isExpanded ? 'bg-yellow-900/30 border-yellow-700 text-yellow-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'}"
								>{isExpanded ? 'collapse' : 'expand'}</button>

								<!-- Remove button -->
								{#if isConnected && order.active}
									{#if removeState.status === 'busy'}
										<span class="text-xs text-gray-500">removing…</span>
									{:else if removeState.status === 'success'}
										<span class="text-xs text-green-400">removed ✓</span>
									{:else}
										<button on:click={() => removeOrder(order)}
											class="shrink-0 text-xs px-3 py-1 rounded border border-red-800/60 text-red-400 bg-red-900/20 hover:bg-red-900/40 transition-colors"
										>remove order</button>
									{/if}
								{/if}
							</div>

							<!-- Remove error -->
							{#if removeState.status === 'error'}
								<div class="px-5 pb-3 text-xs text-red-400 bg-red-900/10 break-words">{removeState.error}</div>
							{/if}

							<!-- Expanded section -->
							{#if isExpanded}
								<div class="border-t border-gray-800 px-5 py-4 space-y-5">

									<!-- Vault balances + deposit/withdraw -->
									{#each getVaultSections(order) as section}
										{#if section.items.length > 0}
											<div>
												<div class="text-xs text-gray-500 uppercase tracking-wider mb-2">{section.label}</div>
												<div class="space-y-2">
													{#each section.items as vault}
														{@const vk = vaultKey(order.orderHash, section.ioType, vault)}
														{@const vs = getVaultOp(vk)}
														<div class="bg-gray-950 rounded-lg border border-gray-800 p-3">
															<!-- Vault info row -->
															<div class="flex flex-wrap items-center gap-3">
																<span class="text-sm font-semibold {section.color}">{vault.token.symbol ?? '?'}</span>
																<span class="text-xs text-gray-500 font-mono" title={vault.token.address}>{fmtAddress(vault.token.address)}</span>
																<div class="flex items-center gap-1">
																	<span class="text-xs text-gray-500">balance:</span>
																	<span class="text-xs text-gray-200 font-semibold">{vault.formattedBalance}</span>
																</div>
																<span class="text-xs text-gray-600 font-mono" title={vaultIdToBytes32(vault.vaultId)}>vault {vaultIdToBytes32(vault.vaultId).slice(0, 10)}…</span>
																<!-- Deposit / Withdraw buttons -->
																{#if isConnected}
																	<div class="ml-auto flex gap-2">
																		<button on:click={() => setVaultOp(vk, { mode: vs.mode === 'deposit' ? 'none' : 'deposit', status: 'idle', error: '', result: '' })}
																			class="text-xs px-2.5 py-1 rounded border transition-colors {vs.mode === 'deposit' ? 'bg-blue-800 border-blue-600 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'}"
																		>deposit</button>
																		<button on:click={() => setVaultOp(vk, { mode: vs.mode === 'withdraw' ? 'none' : 'withdraw', status: 'idle', error: '', result: '' })}
																			class="text-xs px-2.5 py-1 rounded border transition-colors {vs.mode === 'withdraw' ? 'bg-purple-800 border-purple-600 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'}"
																		>withdraw</button>
																	</div>
																{/if}
															</div>

															<!-- Deposit / withdraw form -->
															{#if vs.mode !== 'none' && isConnected}
																<div class="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-800 pt-3">
																	<input
																		value={vs.amount}
																		on:input={(e) => setVaultOp(vk, { amount: e.currentTarget.value })}
																		placeholder={vs.mode === 'withdraw' ? 'amount (blank = all)' : 'amount'}
																		class="text-xs px-2 py-1.5 rounded bg-gray-900 border border-gray-700 text-gray-100 w-44 focus:outline-none focus:border-blue-500 font-mono"
																	/>
																	<button
																		on:click={() => executeVaultOp(order, section.ioType, vault)}
																		disabled={vs.status === 'busy'}
																		class="text-xs px-3 py-1.5 rounded font-semibold disabled:opacity-50 transition-colors {vs.mode === 'deposit' ? 'bg-blue-700 hover:bg-blue-600' : 'bg-purple-700 hover:bg-purple-600'}"
																	>{vs.status === 'busy' ? (vs.mode === 'deposit' ? 'depositing…' : 'withdrawing…') : vs.mode}</button>

																	{#if vs.status === 'success'}
																		<span class="text-xs text-green-400">
																			{#if vs.result}confirmed · <span class="font-mono">{vs.result.slice(0,10)}…</span>
																			{:else if vs.safeTxHash}queued in Safe · <a href={vs.safeAppUrl} target="_blank" rel="noreferrer" class="underline text-blue-400">view →</a>
																			{/if}
																		</span>
																	{/if}
																	{#if vs.status === 'error'}
																		<span class="text-xs text-red-400 break-words max-w-xs">{vs.error}</span>
																	{/if}
																</div>
															{/if}
														</div>
													{/each}
												</div>
											</div>
										{/if}
									{/each}

									<!-- Order details -->
									<div class="grid grid-cols-2 md:grid-cols-3 gap-3">
										<div>
											<div class="text-xs text-gray-600 mb-1">order hash</div>
											<div class="font-mono text-xs text-gray-300 break-all">{order.orderHash}</div>
										</div>
										<div>
											<div class="text-xs text-gray-600 mb-1">owner</div>
											<div class="font-mono text-xs text-gray-300 break-all">{order.owner}</div>
										</div>
										<div>
											<div class="text-xs text-gray-600 mb-1">orderbook</div>
											<div class="font-mono text-xs text-gray-300 break-all">{order.orderbook}</div>
										</div>
										<div>
											<div class="text-xs text-gray-600 mb-1">chain</div>
											<div class="text-xs text-gray-300">{order.chainId}</div>
										</div>
										<div>
											<div class="text-xs text-gray-600 mb-1">added</div>
											<div class="text-xs text-gray-300">{fmtTimestamp(order.timestampAdded)}</div>
										</div>
									</div>

									<!-- Rainlang -->
									{#if order.rainlang}
										<details>
											<summary class="text-xs text-gray-500 cursor-pointer hover:text-gray-300">view rainlang</summary>
											<pre class="mt-2 bg-gray-950 rounded-lg p-4 overflow-x-auto text-xs text-gray-300 leading-relaxed max-h-80 whitespace-pre-wrap break-words">{order.rainlang}</pre>
										</details>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>

				<!-- Pagination -->
				{#if totalCount > PAGE_SIZE}
					<div class="flex items-center justify-center gap-4 mt-8">
						<button on:click={prevPage} disabled={currentPage <= 1 || fetching}
							class="text-sm px-4 py-2 rounded border border-gray-700 bg-gray-900 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
						>← prev</button>
						<span class="text-sm text-gray-500">{currentPage} / {totalPages}</span>
						<button on:click={nextPage} disabled={currentPage >= totalPages || fetching}
							class="text-sm px-4 py-2 rounded border border-gray-700 bg-gray-900 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
						>next →</button>
					</div>
				{/if}
			{/if}
		{/if}
	</main>
</div>
