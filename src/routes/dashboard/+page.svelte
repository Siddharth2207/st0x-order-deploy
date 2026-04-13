<script lang="ts">
	import { onMount } from 'svelte';
	import type { RaindexClient, RaindexOrder } from '@rainlanguage/orderbook';
	import { getOrderbookClient } from '$lib/services/raindexClient';

	const PAGE_SIZE = 25;

	let client: RaindexClient | null = null;
	let initError: string | null = null;
	let initializing = true;

	// Filters
	let ownerFilterInput = '';
	let ownerFilter = '';
	let showInactive = false;

	// Results
	let orders: RaindexOrder[] = [];
	let totalCount = 0;
	let currentPage = 1;
	let fetchError: string | null = null;
	let fetching = false;

	// Expanded rainlang set (by orderHash)
	let expandedRainlang = new Set<string>();

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

	async function fetchOrders(resetPage = false) {
		if (!client) return;
		if (resetPage) currentPage = 1;
		fetching = true;
		fetchError = null;
		try {
			const result = await client.getOrders(
				null, // all chains
				{
					owners: ownerFilter.trim() ? [ownerFilter.trim() as `0x${string}`] : [],
					active: showInactive ? undefined : true
				},
				currentPage,
				PAGE_SIZE
			);
			if (result.error) {
				fetchError = result.error.readableMsg;
				return;
			}
			orders = result.value.orders;
			totalCount = result.value.totalCount;
		} catch (e) {
			fetchError = e instanceof Error ? e.message : String(e);
		} finally {
			fetching = false;
		}
	}

	function applyOwnerFilter() {
		ownerFilter = ownerFilterInput;
		fetchOrders(true);
	}

	function clearOwnerFilter() {
		ownerFilterInput = '';
		ownerFilter = '';
		fetchOrders(true);
	}

	function handleOwnerKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') applyOwnerFilter();
	}

	function toggleInactive() {
		showInactive = !showInactive;
		fetchOrders(true);
	}

	function toggleRainlang(hash: string) {
		if (expandedRainlang.has(hash)) {
			expandedRainlang.delete(hash);
		} else {
			expandedRainlang.add(hash);
		}
		expandedRainlang = expandedRainlang; // trigger reactivity
	}

	function prevPage() {
		if (currentPage > 1) {
			currentPage--;
			fetchOrders();
		}
	}

	function nextPage() {
		if (currentPage * PAGE_SIZE < totalCount) {
			currentPage++;
			fetchOrders();
		}
	}

	function fmtAddress(addr: string) {
		return addr.slice(0, 6) + '…' + addr.slice(-4);
	}

	function fmtTimestamp(ts: bigint) {
		return new Date(Number(ts) * 1000).toLocaleString();
	}

	function getTokenSymbols(vaultList: RaindexOrder['inputsList'] | RaindexOrder['outputsList']) {
		const seen = new Set<string>();
		const syms: string[] = [];
		for (const vault of vaultList.items) {
			const sym = vault.token.symbol ?? vault.token.address.slice(0, 8) + '…';
			if (!seen.has(sym)) {
				seen.add(sym);
				syms.push(sym);
			}
		}
		return syms.join(', ') || '—';
	}

	$: totalPages = Math.ceil(totalCount / PAGE_SIZE);
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
		{#if !initializing && client}
			<span class="text-xs text-green-500">● connected</span>
		{/if}
	</header>

	<main class="px-6 py-6 max-w-7xl mx-auto">
		<!-- Init error -->
		{#if initError}
			<div class="bg-red-900/30 border border-red-700 rounded-lg p-4 text-sm text-red-300 mb-6">
				{initError}
			</div>
		{/if}

		<!-- Initializing -->
		{#if initializing}
			<div class="flex items-center gap-3 text-gray-400 mt-20 justify-center">
				<svg class="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
				</svg>
				<span class="text-sm">initializing subgraph client…</span>
			</div>
		{:else if !initError}
			<!-- Filters -->
			<section class="mb-6 flex flex-wrap gap-4 items-end">
				<!-- Owner filter -->
				<div class="flex flex-col gap-1">
					<label class="text-xs text-gray-400 uppercase tracking-wider">Order Owner</label>
					<div class="flex gap-2">
						<input
							type="text"
							bind:value={ownerFilterInput}
							on:keydown={handleOwnerKeydown}
							placeholder="0x… address"
							class="text-sm px-3 py-2 rounded bg-gray-900 border border-gray-700 text-gray-100 w-80 focus:outline-none focus:border-blue-500 placeholder-gray-600"
						/>
						<button
							on:click={applyOwnerFilter}
							class="text-sm px-4 py-2 rounded bg-blue-700 hover:bg-blue-600 font-semibold"
						>
							filter
						</button>
						{#if ownerFilter}
							<button
								on:click={clearOwnerFilter}
								class="text-sm px-3 py-2 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400"
							>
								clear
							</button>
						{/if}
					</div>
				</div>

				<!-- Active/Inactive toggle -->
				<div class="flex flex-col gap-1">
					<label class="text-xs text-gray-400 uppercase tracking-wider">Status</label>
					<div class="flex gap-2">
						<button
							on:click={() => { if (showInactive) toggleInactive(); }}
							class="text-sm px-4 py-2 rounded border transition-colors {!showInactive
								? 'bg-green-800 border-green-600 text-white'
								: 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'}"
						>
							active only
						</button>
						<button
							on:click={() => { if (!showInactive) toggleInactive(); }}
							class="text-sm px-4 py-2 rounded border transition-colors {showInactive
								? 'bg-gray-700 border-gray-500 text-white'
								: 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'}"
						>
							all orders
						</button>
					</div>
				</div>
			</section>

			<!-- Active filter badge -->
			{#if ownerFilter}
				<div class="mb-4 flex items-center gap-2">
					<span class="text-xs text-gray-500">filtering by owner:</span>
					<span class="text-xs bg-blue-900/40 border border-blue-700 text-blue-300 px-2 py-0.5 rounded font-mono"
						>{ownerFilter}</span
					>
				</div>
			{/if}

			<!-- Fetch error -->
			{#if fetchError}
				<div class="bg-red-900/30 border border-red-700 rounded-lg p-4 text-sm text-red-300 mb-4">
					{fetchError}
				</div>
			{/if}

			<!-- Summary row -->
			<div class="flex items-center justify-between mb-4">
				<div class="text-xs text-gray-500">
					{#if fetching}
						loading…
					{:else}
						{totalCount} order{totalCount !== 1 ? 's' : ''} · page {currentPage} of {Math.max(1, totalPages)}
					{/if}
				</div>
				{#if fetching}
					<svg class="animate-spin h-4 w-4 text-gray-500" viewBox="0 0 24 24" fill="none">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
					</svg>
				{/if}
			</div>

			<!-- Orders table -->
			{#if orders.length === 0 && !fetching}
				<div class="text-center text-gray-600 py-20 text-sm">no orders found</div>
			{:else}
				<div class="space-y-3">
					{#each orders as order (order.orderHash)}
						{@const isExpanded = expandedRainlang.has(order.orderHash)}
						<div
							class="bg-gray-900 rounded-xl border transition-colors {order.active
								? 'border-gray-800'
								: 'border-gray-800/50 opacity-70'}"
						>
							<!-- Order row -->
							<div class="px-5 py-4 flex flex-wrap items-center gap-x-6 gap-y-2">
								<!-- Status badge -->
								<span
									class="shrink-0 text-xs px-2 py-0.5 rounded-full font-semibold {order.active
										? 'bg-green-900/50 text-green-400 border border-green-800'
										: 'bg-gray-800 text-gray-500 border border-gray-700'}"
								>
									{order.active ? 'active' : 'inactive'}
								</span>

								<!-- Chain -->
								<span class="shrink-0 text-xs text-gray-500">chain {order.chainId}</span>

								<!-- Order hash -->
								<span class="font-mono text-xs text-gray-300" title={order.orderHash}>
									{fmtAddress(order.orderHash)}
								</span>

								<!-- Owner -->
								<div class="flex items-center gap-1.5">
									<span class="text-xs text-gray-600">owner</span>
									<span class="font-mono text-xs text-gray-400" title={order.owner}>
										{fmtAddress(order.owner)}
									</span>
								</div>

								<!-- Input tokens -->
								<div class="flex items-center gap-1.5">
									<span class="text-xs text-gray-600">in</span>
									<span class="text-xs text-blue-400">{getTokenSymbols(order.inputsList)}</span>
								</div>

								<!-- Output tokens -->
								<div class="flex items-center gap-1.5">
									<span class="text-xs text-gray-600">out</span>
									<span class="text-xs text-purple-400">{getTokenSymbols(order.outputsList)}</span>
								</div>

								<!-- Timestamp -->
								<span class="text-xs text-gray-600 ml-auto">{fmtTimestamp(order.timestampAdded)}</span>

								<!-- Rainlang toggle -->
								<button
									on:click={() => toggleRainlang(order.orderHash)}
									class="shrink-0 text-xs px-3 py-1 rounded border transition-colors {isExpanded
										? 'bg-yellow-900/30 border-yellow-700 text-yellow-400'
										: 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'}"
								>
									{isExpanded ? 'hide rainlang' : 'view rainlang'}
								</button>
							</div>

							<!-- Expanded rainlang -->
							{#if isExpanded}
								<div class="border-t border-gray-800 px-5 py-4">
									{#if order.rainlang}
										<div class="mb-2 text-xs text-gray-500 uppercase tracking-wider">decoded rainlang</div>
										<pre
											class="bg-gray-950 rounded-lg p-4 overflow-x-auto text-xs text-gray-300 leading-relaxed max-h-96 whitespace-pre-wrap break-words">{order.rainlang}</pre>
									{:else}
										<div class="text-xs text-gray-600 italic">
											rainlang not available for this order (bytecode may not be decompilable from current registry)
										</div>
									{/if}

									<!-- Order details grid -->
									<div class="mt-4 grid grid-cols-2 md:grid-cols-3 gap-3">
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

									<!-- Vault info -->
									{#if order.inputsList.items.length > 0 || order.outputsList.items.length > 0}
										<div class="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
											{#if order.inputsList.items.length > 0}
												<div>
													<div class="text-xs text-gray-600 uppercase tracking-wider mb-2">input vaults</div>
													<div class="space-y-1">
														{#each order.inputsList.items as vault}
															<div class="flex items-center justify-between bg-gray-950 rounded px-3 py-2">
																<span class="text-xs text-blue-400 font-semibold"
																	>{vault.token.symbol ?? '?'}</span
																>
																<span class="text-xs text-gray-500 font-mono"
																	>{fmtAddress(vault.token.address)}</span
																>
															</div>
														{/each}
													</div>
												</div>
											{/if}
											{#if order.outputsList.items.length > 0}
												<div>
													<div class="text-xs text-gray-600 uppercase tracking-wider mb-2">output vaults</div>
													<div class="space-y-1">
														{#each order.outputsList.items as vault}
															<div class="flex items-center justify-between bg-gray-950 rounded px-3 py-2">
																<span class="text-xs text-purple-400 font-semibold"
																	>{vault.token.symbol ?? '?'}</span
																>
																<span class="text-xs text-gray-500 font-mono"
																	>{fmtAddress(vault.token.address)}</span
																>
															</div>
														{/each}
													</div>
												</div>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>

				<!-- Pagination -->
				{#if totalCount > PAGE_SIZE}
					<div class="flex items-center justify-center gap-4 mt-8">
						<button
							on:click={prevPage}
							disabled={currentPage <= 1 || fetching}
							class="text-sm px-4 py-2 rounded border border-gray-700 bg-gray-900 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
						>
							← prev
						</button>
						<span class="text-sm text-gray-500">{currentPage} / {totalPages}</span>
						<button
							on:click={nextPage}
							disabled={currentPage >= totalPages || fetching}
							class="text-sm px-4 py-2 rounded border border-gray-700 bg-gray-900 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
						>
							next →
						</button>
					</div>
				{/if}
			{/if}
		{/if}
	</main>
</div>
