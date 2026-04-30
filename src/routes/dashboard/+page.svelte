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
	import { registrySourceInput, loadedRegistry, hydrateFromStorage } from '$lib/stores/registrySource';


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

	// Auto-fill owner filter from connected wallet.
	// Tracks the last address we auto-filled so manual edits are not overridden.
	let _autoFilledAddress = '';
	$: if (connectedAddress && connectedAddress !== _autoFilledAddress) {
		// Only auto-fill if the filter is currently empty or holds the previous auto address
		if (ownerFilter === '' || ownerFilter === _autoFilledAddress) {
			_autoFilledAddress = connectedAddress;
			ownerFilterInput = connectedAddress;
			ownerFilter = connectedAddress;
			// Re-fetch once the client is ready (onMount sets client before fetching)
			if (client) fetchOrders(true);
		} else {
			_autoFilledAddress = connectedAddress; // track without overriding manual filter
		}
	}

	// Debounced owner filter — fires 400 ms after the user stops typing
	let _ownerDebounce: ReturnType<typeof setTimeout> | null = null;
	function onOwnerInput(e: Event) {
		ownerFilterInput = (e.currentTarget as HTMLInputElement).value;
		if (_ownerDebounce) clearTimeout(_ownerDebounce);
		_ownerDebounce = setTimeout(() => {
			ownerFilter = ownerFilterInput.trim();
			fetchOrders(true);
		}, 400);
	}
	function onOwnerKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			if (_ownerDebounce) { clearTimeout(_ownerDebounce); _ownerDebounce = null; }
			ownerFilter = ownerFilterInput.trim();
			fetchOrders(true);
		}
		if (e.key === 'Escape') clearOwnerFilter();
	}
	function clearOwnerFilter() {
		if (_ownerDebounce) { clearTimeout(_ownerDebounce); _ownerDebounce = null; }
		ownerFilterInput = ''; ownerFilter = ''; selectedPair = 'All'; fetchOrders(true);
	}

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
	let removeStates: Record<string, RemoveState> = {};

	// ── Vault op state per vault ───────────────────────────────────────────────
	// key: `${orderHash}:${ioType}:${vaultId}`
	// Plain object (not Map) so Svelte's reactivity tracks mutations correctly.
	type VaultOpState = {
		mode: 'none' | 'deposit' | 'withdraw';
		amount: string;
		status: 'idle' | 'approving' | 'busy' | 'success' | 'error';
		error: string;
		result: string;
		safeTxHash: string;
		safeAppUrl: string;
	};
	const EMPTY_VAULT_OP: VaultOpState = { mode: 'none', amount: '', status: 'idle', error: '', result: '', safeTxHash: '', safeAppUrl: '' };
	let vaultOpStates: Record<string, VaultOpState> = {};

	function vaultKey(orderHash: string, ioType: 'input' | 'output', vault: RaindexVault) {
		return `${orderHash}:${ioType}:${vault.vaultId}`;
	}
	function getVaultOp(key: string): VaultOpState {
		return vaultOpStates[key] ?? EMPTY_VAULT_OP;
	}
	function setVaultOp(key: string, patch: Partial<VaultOpState>) {
		// Object spread + reassign triggers Svelte reactivity reliably
		vaultOpStates = { ...vaultOpStates, [key]: { ...getVaultOp(key), ...patch } };
	}
	function toggleVaultMode(key: string, currentMode: VaultOpState['mode'], nextMode: 'deposit' | 'withdraw') {
		setVaultOp(key, {
			mode: currentMode === nextMode ? 'none' : nextMode,
			status: 'idle',
			error: '',
			result: '',
			safeTxHash: '',
			safeAppUrl: ''
		});
	}

	// ── Mount ──────────────────────────────────────────────────────────────────
	onMount(async () => {
		// Restore registry source from localStorage so the indicator is accurate
		// even when navigating directly to the dashboard.
		hydrateFromStorage();
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
	 * Accumulated map of pairKey → non-stable token address.
	 * Persists across page changes so tabs are stable even when a pair filter
	 * is active and `orders` only contains that pair's results.
	 *
	 * We filter by ONLY the non-stable (wt*) token address, not by USDC.
	 * The SDK ORs within each side of the filter, so passing USDC would match
	 * every X/USDC pair on the orderbook.
	 */
	let pairNonStableAddr = new Map<string, Address>();

	function updatePairTokenMap(newOrders: RaindexOrder[]) {
		let changed = false;
		for (const order of newOrders) {
			const key = getPairKey(order);
			if (!pairNonStableAddr.has(key)) {
				const nonStable = [
					...order.inputsList.items,
					...order.outputsList.items
				].find((v) => !STABLES.has(v.token.symbol ?? ''));
				if (nonStable) {
					pairNonStableAddr.set(key, nonStable.token.address as Address);
					changed = true;
				}
			}
		}
		if (changed) pairNonStableAddr = pairNonStableAddr;
	}

	$: pairTabs = [...pairNonStableAddr.keys()].sort((a, b) => {
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
			// When a specific pair is selected, filter server-side using ONLY the
			// non-stable token address (e.g. wtNVDA, not USDC). The SDK ORs within
			// each side of the filter, so including USDC would match every X/USDC
			// pair on the orderbook. Filtering by just wtNVDA returns orders where
			// wtNVDA is an input (sell) OR an output (buy) — exactly this pair.
			let tokenFilter: GetOrdersTokenFilter | undefined;
			if (selectedPair !== 'All') {
				const addr = pairNonStableAddr.get(selectedPair);
				if (addr) tokenFilter = { inputs: [addr], outputs: [addr] };
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

	function toggleInactive() { showInactive = !showInactive; fetchOrders(true); }
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
	function getRaindexOrderUrl(order: RaindexOrder) {
		return `https://v6.raindex.finance/orders/${order.chainId}-${order.orderbook}-${order.orderHash}`;
	}

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
		removeStates = { ...removeStates, [key]: { status: 'busy', error: '' } };
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

			removeStates = { ...removeStates, [key]: { status: 'success', error: '' } };
			// Refresh so removed order disappears
			await fetchOrders();
		} catch (e) {
			removeStates = { ...removeStates, [key]: { status: 'error', error: e instanceof Error ? e.message : String(e) } };
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
					const txHash = await depositTurnkey(input, (step) => {
						setVaultOp(key, { status: step });
					});
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

			// Refresh balances after a successful vault operation so the UI reflects
			// the updated onchain vault state.
			await fetchOrders();
		} catch (e) {
			setVaultOp(key, { status: 'error', error: e instanceof Error ? e.message : String(e) });
		}
	}
</script>

<div class="min-h-screen bg-gray-950 text-gray-100 font-mono">

	<!-- ── Header ──────────────────────────────────────────────────────────────── -->
	<header class="sticky top-0 z-10 bg-gray-950/95 backdrop-blur border-b border-gray-800 px-6 py-3 flex items-center justify-between gap-4">
		<div class="flex items-center gap-3 min-w-0">
			<a href="/" class="text-gray-500 hover:text-gray-200 text-xs transition-colors shrink-0">← deploy</a>
			<span class="text-gray-700 shrink-0">/</span>
			<h1 class="text-sm font-semibold tracking-tight text-gray-100 truncate">orderbook dashboard</h1>
		</div>

		<!-- Wallet strip (right side of header) -->
		<div class="flex items-center gap-2 shrink-0">
			<!-- Mode pills -->
			<div class="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
				<button on:click={() => (deploymentMode = 'eoa')}
					class="text-xs px-2.5 py-1 rounded transition-colors {deploymentMode === 'eoa' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}"
				>EOA</button>
				<button on:click={() => (deploymentMode = 'safe')}
					class="text-xs px-2.5 py-1 rounded transition-colors {deploymentMode === 'safe' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}"
				>Safe</button>
				<button on:click={() => (deploymentMode = 'turnkey')}
					class="text-xs px-2.5 py-1 rounded transition-colors {deploymentMode === 'turnkey' ? 'bg-yellow-700 text-white' : 'text-gray-500 hover:text-gray-300'}"
				>Turnkey</button>
			</div>

			<!-- Context: SAFE address input -->
			{#if deploymentMode === 'safe'}
				<input bind:value={safeAddress} placeholder="Safe 0x…"
					class="text-xs px-2 py-1.5 rounded bg-gray-900 border border-gray-700 text-gray-100 w-44 focus:outline-none focus:border-blue-500" />
			{/if}

			<!-- Context: connected wallet address -->
			{#if deploymentMode === 'turnkey'}
				{#if turnkeyWallet}
					<div class="flex items-center gap-2">
						<span class="text-xs text-yellow-400/80 font-mono">{fmtAddress(turnkeyWallet.address)}</span>
						<button on:click={() => (turnkeyWallet = null)} class="text-xs text-gray-600 hover:text-gray-400 transition-colors">✕</button>
					</div>
				{:else}
					<button on:click={connectTurnkey} disabled={turnkeyConnecting}
						class="text-xs px-3 py-1.5 rounded bg-yellow-800 hover:bg-yellow-700 disabled:opacity-50 transition-colors"
					>{turnkeyConnecting ? 'connecting…' : 'connect'}</button>
				{/if}
			{:else if $connected && $signerAddress}
				<div class="flex items-center gap-2">
					<span class="text-xs text-gray-400 font-mono">{fmtAddress($signerAddress)}</span>
					<button on:click={handleDisconnect} class="text-xs text-gray-600 hover:text-gray-400 transition-colors">✕</button>
				</div>
			{:else}
				<button on:click={handleConnect} class="text-xs px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 font-semibold transition-colors">connect</button>
			{/if}
		</div>
	</header>

	<!-- Turnkey error banner -->
	{#if turnkeyConnectError}
		<div class="px-6 py-2 text-xs text-red-400 bg-red-900/20 border-b border-red-900/40 break-words">{turnkeyConnectError}</div>
	{/if}

	<main class="px-6 py-5 max-w-7xl mx-auto">

		{#if initError}
			<div class="bg-red-900/20 border border-red-800 rounded-lg p-4 text-sm text-red-300 mb-5">{initError}</div>
		{/if}

		{#if initializing}
			<!-- Skeleton loader -->
			<div class="space-y-2 mt-6">
				{#each [0,1,2,3,4] as _}
					<div class="h-12 bg-gray-900 rounded-lg border border-gray-800 animate-pulse"></div>
				{/each}
			</div>
		{:else if !initError}

			<!-- ── Active registry source indicator ──────────────────────────────── -->
			{#if $loadedRegistry}
				<div class="mb-4 flex items-center gap-2 text-xs bg-gray-900/50 border border-gray-800 rounded-lg px-3 py-2">
					<span class="text-gray-600 shrink-0">registry:</span>
					<span class="font-mono text-gray-400 truncate">
						{$loadedRegistry.source.owner}/{$loadedRegistry.source.repo}@{$loadedRegistry.source.ref.slice(0, 12)}/{$loadedRegistry.source.path}
					</span>
					<span class="text-green-600/70 shrink-0">✓ active</span>
					<a href="/" class="ml-auto text-blue-600/70 hover:text-blue-400 transition-colors shrink-0">change →</a>
				</div>
			{:else}
				<div class="mb-4 flex items-center gap-2 text-xs bg-gray-900/30 border border-gray-800/60 rounded-lg px-3 py-2">
					<span class="text-gray-700 shrink-0">registry:</span>
					<span class="font-mono text-gray-600 truncate">
						{$registrySourceInput.owner}/{$registrySourceInput.repo}@{$registrySourceInput.ref.slice(0, 12)}/{$registrySourceInput.path}
					</span>
					<span class="text-gray-700 shrink-0">(default)</span>
					<a href="/" class="ml-auto text-blue-700/60 hover:text-blue-500 transition-colors shrink-0 text-xs">load registry →</a>
				</div>
			{/if}

			<!-- ── Filter bar ──────────────────────────────────────────────────────── -->
			<div class="mb-4 flex flex-wrap items-center gap-3">

				<!-- Owner search (instant / debounced) -->
				<div class="relative flex-1 min-w-52 max-w-xs">
					<svg class="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-600 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
					</svg>
					<input
						type="text"
						value={ownerFilterInput}
						on:input={onOwnerInput}
						on:keydown={onOwnerKeydown}
						placeholder="filter by owner address…"
						class="w-full pl-8 pr-8 py-1.5 text-xs rounded-lg bg-gray-900 border border-gray-800 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-600 transition-colors"
					/>
					{#if ownerFilterInput}
						<button on:click={clearOwnerFilter} class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-300 transition-colors text-xs">✕</button>
					{/if}
				</div>

				<!-- Status toggle pills -->
				<div class="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
					<button on:click={() => { if (showInactive) toggleInactive(); }}
						class="text-xs px-3 py-1 rounded transition-colors {!showInactive ? 'bg-green-800 text-green-200' : 'text-gray-500 hover:text-gray-300'}"
					>active</button>
					<button on:click={() => { if (!showInactive) toggleInactive(); }}
						class="text-xs px-3 py-1 rounded transition-colors {showInactive ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}"
					>all</button>
				</div>

				<!-- Spacer + count + spinner -->
				<div class="ml-auto flex items-center gap-2">
					{#if fetching}
						<svg class="animate-spin h-3.5 w-3.5 text-gray-500" viewBox="0 0 24 24" fill="none">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
						</svg>
					{/if}
					<span class="text-xs text-gray-600">
						{#if !fetching}{totalCount} order{totalCount !== 1 ? 's' : ''}{/if}
					</span>
				</div>
			</div>

			<!-- Active filter chips -->
			{#if ownerFilter || selectedPair !== 'All' || showInactive}
				<div class="mb-3 flex flex-wrap gap-2">
					{#if ownerFilter}
						<span class="inline-flex items-center gap-1.5 text-xs bg-blue-900/30 border border-blue-800/50 text-blue-300 px-2.5 py-1 rounded-full font-mono">
							owner: {fmtAddress(ownerFilter)}
							<button on:click={clearOwnerFilter} class="text-blue-500 hover:text-blue-300 transition-colors">✕</button>
						</span>
					{/if}
					{#if selectedPair !== 'All'}
						<span class="inline-flex items-center gap-1.5 text-xs bg-purple-900/30 border border-purple-800/50 text-purple-300 px-2.5 py-1 rounded-full">
							pair: {selectedPair}
							<button on:click={() => selectPair('All')} class="text-purple-500 hover:text-purple-300 transition-colors">✕</button>
						</span>
					{/if}
					{#if showInactive}
						<span class="inline-flex items-center gap-1.5 text-xs bg-gray-800 border border-gray-700 text-gray-400 px-2.5 py-1 rounded-full">
							showing inactive
							<button on:click={toggleInactive} class="text-gray-500 hover:text-gray-300 transition-colors">✕</button>
						</span>
					{/if}
				</div>
			{/if}

			{#if fetchError}
				<div class="bg-red-900/20 border border-red-800 rounded-lg p-3 text-xs text-red-300 mb-4">{fetchError}</div>
			{/if}

			<!-- ── Token pair tabs (wrapped rows) ─────────────────────────────────── -->
			{#if pairTabs.length > 0}
				<div class="mb-4 flex flex-wrap items-center gap-1.5">
					<button on:click={() => selectPair('All')}
						class="shrink-0 text-xs px-3 py-1 rounded-full border transition-colors {selectedPair === 'All' ? 'bg-blue-700 border-blue-600 text-white' : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'}"
					>All</button>
					{#each pairTabs as pair}
						<button on:click={() => selectPair(pair)}
							class="shrink-0 text-xs px-3 py-1 rounded-full border transition-colors {selectedPair === pair ? 'bg-blue-700 border-blue-600 text-white' : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'}"
						>{pair}</button>
					{/each}
				</div>
			{/if}

			<!-- ── Orders list ──────────────────────────────────────────────────────── -->
			{#if orders.length === 0 && !fetching}
				<div class="text-center text-gray-700 py-20 text-sm">no orders found</div>
			{:else}
				<div class="rounded-xl border border-gray-800 overflow-hidden">
					<!-- Column headers -->
					<div
						class="grid items-center gap-0 border-b border-gray-800 bg-gray-900/80"
						style="grid-template-columns: 2rem 0.75rem 8rem 5.5rem 1fr auto auto"
					>
						<div></div>
						<div></div>
						<div class="py-2 pr-3 text-xs text-gray-600 uppercase tracking-wider">pair</div>
						<div class="py-2 pr-3 text-xs text-gray-600 uppercase tracking-wider">hash</div>
						<div class="py-2 pr-3 text-xs text-gray-600 uppercase tracking-wider">owner</div>
						<div class="py-2 pr-4 text-xs text-gray-600 uppercase tracking-wider hidden lg:block">added</div>
						<div class="py-2 pr-4"></div>
					</div>

					{#each orders as order (order.orderHash)}
						{@const isExpanded = expandedOrders.has(order.orderHash)}
						{@const removeState = removeStates[order.orderHash] ?? { status: 'idle', error: '' }}
						<div class="border-b border-gray-800 last:border-0 {!order.active ? 'opacity-50' : ''}">

							<!-- ── Dense order row ──────────────────────────────────────── -->
							<div
								class="grid items-center gap-0 hover:bg-gray-900/60 transition-colors cursor-pointer select-none"
								style="grid-template-columns: 2rem 0.75rem 8rem 5.5rem 1fr auto auto"
								on:click={() => toggleOrder(order.orderHash)}
								on:keydown={(e) => e.key === 'Enter' && toggleOrder(order.orderHash)}
								role="button"
								tabindex="0"
							>
								<!-- Expand chevron (col 1) -->
								<div class="flex items-center justify-center py-3">
									<svg class="h-3 w-3 text-gray-600 transition-transform duration-150 {isExpanded ? 'rotate-90' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
									</svg>
								</div>

								<!-- Status dot (col 2) -->
								<div class="flex items-center py-3">
									<span class="h-1.5 w-1.5 rounded-full {order.active ? 'bg-green-500' : 'bg-gray-600'}"></span>
								</div>

								<!-- Pair (col 3) -->
								<div class="py-3 pr-3 min-w-0">
									<span class="text-xs font-semibold text-blue-300 block truncate">{getPairKey(order)}</span>
								</div>

								<!-- Hash (col 4) -->
								<div class="py-3 pr-3 min-w-0">
									<a
										href={getRaindexOrderUrl(order)}
										target="_blank"
										rel="noreferrer"
										class="font-mono text-xs text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline block truncate"
										title={order.orderHash}
										on:click|stopPropagation
									>{fmtAddress(order.orderHash)}</a>
								</div>

								<!-- Owner (col 5 — flex-1, truncates) -->
								<div class="py-3 pr-3 min-w-0">
									<span class="font-mono text-xs text-gray-700 block truncate" title={order.owner}>{fmtAddress(order.owner)}</span>
								</div>

								<!-- Timestamp (col 6) -->
								<div class="py-3 pr-4 hidden lg:block">
									<span class="text-xs text-gray-700 whitespace-nowrap">{fmtTimestamp(order.timestampAdded)}</span>
								</div>

								<!-- Actions (col 7 — stop propagation) -->
								<!-- svelte-ignore a11y-click-events-have-key-events -->
								<!-- svelte-ignore a11y-no-static-element-interactions -->
								<div class="py-3 pr-4 flex items-center gap-2" on:click|stopPropagation>
									{#if isConnected && order.active}
										{#if removeState.status === 'busy'}
											<span class="text-xs text-gray-600 whitespace-nowrap">removing…</span>
										{:else if removeState.status === 'success'}
											<span class="text-xs text-green-500 whitespace-nowrap">✓ removed</span>
										{:else}
											<button on:click={() => removeOrder(order)}
												class="text-xs px-2.5 py-1 rounded border border-red-900/60 text-red-500 bg-red-900/10 hover:bg-red-900/30 transition-colors whitespace-nowrap"
											>remove</button>
										{/if}
									{/if}
								</div>
							</div>

							<!-- Remove error inline -->
							{#if removeState.status === 'error'}
								<div class="px-10 py-2 text-xs text-red-400 bg-red-900/10 border-t border-red-900/20 break-words">{removeState.error}</div>
							{/if}

							<!-- ── Expanded panel ─────────────────────────────────────────── -->
							{#if isExpanded}
								<div class="bg-gray-900/40 border-t border-gray-800 px-6 py-4 space-y-4">

									<!-- Vault sections -->
									{#each getVaultSections(order) as section}
										{#if section.items.length > 0}
											<div>
												<div class="text-xs text-gray-600 uppercase tracking-wider mb-2">{section.label}</div>
												<div class="space-y-1.5">
													{#each section.items as vault}
														{@const vk = vaultKey(order.orderHash, section.ioType, vault)}
														{#each [vaultOpStates[vk] ?? EMPTY_VAULT_OP] as vs}
														<div class="bg-gray-950/80 rounded-lg border border-gray-800/60 px-3 py-2.5">
															<div class="flex flex-wrap items-center gap-3">
																<!-- Token symbol + balance -->
																<span class="text-sm font-semibold {section.color} w-16 shrink-0">{vault.token.symbol ?? '?'}</span>
																<div class="flex items-baseline gap-1">
																	<span class="text-sm font-semibold text-gray-100">{vault.formattedBalance}</span>
																	<span class="text-xs text-gray-600">{vault.token.symbol}</span>
																</div>
																<!-- Vault ID -->
																<span class="text-xs text-gray-700 font-mono hidden sm:block" title={vaultIdToBytes32(vault.vaultId)}>
																	vault {vaultIdToBytes32(vault.vaultId).slice(0, 10)}…
																</span>
																<!-- Token address -->
																<span class="text-xs text-gray-700 font-mono hidden md:block" title={vault.token.address}>{fmtAddress(vault.token.address)}</span>

																<!-- Action buttons — always visible -->
																<div class="ml-auto flex gap-1.5">
																	<button
																		type="button"
																		on:click|stopPropagation={() => toggleVaultMode(vk, vs.mode, 'deposit')}
																		class="text-xs px-2.5 py-1 rounded border transition-colors {vs.mode === 'deposit' ? 'bg-blue-800 border-blue-700 text-blue-100' : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'}"
																	>deposit</button>
																	<button
																		type="button"
																		on:click|stopPropagation={() => toggleVaultMode(vk, vs.mode, 'withdraw')}
																		class="text-xs px-2.5 py-1 rounded border transition-colors {vs.mode === 'withdraw' ? 'bg-purple-800 border-purple-700 text-purple-100' : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'}"
																	>withdraw</button>
																</div>
															</div>

															<!-- Inline amount form — shown when a mode is selected -->
															{#if vs.mode !== 'none'}
																<div class="mt-2.5 pt-2.5 border-t border-gray-800/60 flex flex-wrap items-center gap-2">
																	<input
																		value={vs.amount}
																		on:click|stopPropagation
																		on:input={(e) => setVaultOp(vk, { amount: e.currentTarget.value })}
																		placeholder={vs.mode === 'withdraw' ? 'amount (blank = all)' : 'amount'}
																		class="text-xs px-2.5 py-1.5 rounded bg-gray-900 border border-gray-700 text-gray-100 w-40 focus:outline-none focus:border-blue-500 font-mono"
																	/>
																	<button
																		type="button"
																		on:click|stopPropagation={() => executeVaultOp(order, section.ioType, vault)}
																			disabled={['approving','busy'].includes(vs.status) || !isConnected}
																			title={!isConnected ? (deploymentMode === 'turnkey' ? 'Connect Turnkey above' : 'Connect wallet') : undefined}
																			class="text-xs px-3 py-1.5 rounded font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors {vs.mode === 'deposit' ? 'bg-blue-700 hover:bg-blue-600' : 'bg-purple-700 hover:bg-purple-600'}"
																	>{
																			vs.status === 'approving' ? 'approve + deposit…' :
																			vs.status === 'busy'      ? (vs.mode === 'deposit' ? 'depositing…' : 'withdrawing…') :
																			vs.mode
																	}</button>
																	{#if vs.status === 'approving'}
																			<span class="text-xs text-yellow-400/80">approve → deposit · signing on-chain…</span>
																	{:else if !isConnected}
																		<span class="text-xs text-gray-600">{deploymentMode === 'turnkey' ? 'connect Turnkey above ↑' : 'connect wallet'}</span>
																	{/if}
																	{#if vs.status === 'success'}
																		<span class="text-xs text-green-400">
																			{#if vs.result}✓ <span class="font-mono">{vs.result.slice(0,10)}…</span>
																			{:else if vs.safeTxHash}queued · <a href={vs.safeAppUrl} target="_blank" rel="noreferrer" class="underline text-blue-400">view →</a>
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
													{/each}
												</div>
											</div>
										{/if}
									{/each}

									<!-- Order metadata grid -->
									<div class="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 pt-1">
										<div>
											<div class="text-xs text-gray-700 mb-0.5">hash</div>
											<a
												href={getRaindexOrderUrl(order)}
												target="_blank"
												rel="noreferrer"
												class="font-mono text-xs text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline break-all"
											>{order.orderHash}</a>
										</div>
										<div>
											<div class="text-xs text-gray-700 mb-0.5">owner</div>
											<div class="font-mono text-xs text-gray-400 break-all">{order.owner}</div>
										</div>
										<div>
											<div class="text-xs text-gray-700 mb-0.5">orderbook</div>
											<div class="font-mono text-xs text-gray-400 break-all">{order.orderbook}</div>
										</div>
										<div>
											<div class="text-xs text-gray-700 mb-0.5">added</div>
											<div class="text-xs text-gray-400">{fmtTimestamp(order.timestampAdded)}</div>
										</div>
									</div>

									<!-- Rainlang -->
									{#if order.rainlang}
										<details class="group">
											<summary class="text-xs text-gray-600 cursor-pointer hover:text-gray-400 transition-colors list-none flex items-center gap-1.5">
												<svg class="h-3 w-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
												</svg>
												rainlang
											</summary>
											<pre class="mt-2 bg-gray-950 rounded-lg p-4 overflow-x-auto text-xs text-gray-400 leading-relaxed max-h-72 whitespace-pre-wrap break-words">{order.rainlang}</pre>
										</details>
									{/if}
								</div>
							{/if}

						</div>
					{/each}
				</div>

				<!-- Pagination -->
				{#if totalCount > PAGE_SIZE}
					<div class="flex items-center justify-center gap-3 mt-6">
						<button on:click={prevPage} disabled={currentPage <= 1 || fetching}
							class="text-xs px-3 py-1.5 rounded border border-gray-700 bg-gray-900 hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
						>← prev</button>
						<span class="text-xs text-gray-600">{currentPage} / {totalPages}</span>
						<button on:click={nextPage} disabled={currentPage >= totalPages || fetching}
							class="text-xs px-3 py-1.5 rounded border border-gray-700 bg-gray-900 hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
						>next →</button>
					</div>
				{/if}
			{/if}

		{/if}
	</main>
</div>
