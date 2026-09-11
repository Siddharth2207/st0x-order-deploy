<script lang="ts">
	import { onMount } from 'svelte';
	import type { RaindexOrder } from '@rainlanguage/raindex';
	import { getOrderbookClient } from '$lib/services/raindexClient';
	import { feedAlias } from '$lib/config/feedIds';

	const OWNER = '0x71b94911FD1CE621FC40970450004c544e5287a8' as const;
	const FETCH_PAGE_SIZE = 100; // max per request

	// ── Rainlang parsing ────────────────────────────────────────────────────────

	const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase();

	interface OrderParams {
		multiplier: string;
		timeout: string;
		feed: string;
	}

	function getUniqueSymbols(vaultList: RaindexOrder['inputsList']): string {
		const seen = new Set<string>();
		for (const vault of vaultList.items) {
			const sym = vault.token.symbol ?? vault.token.address;
			seen.add(sym);
		}
		return [...seen].join(' / ') || '—';
	}

	function getOrderType(order: RaindexOrder): 'buy' | 'sell' {
		for (const vault of order.outputsList.items) {
			if (vault.token.address.toLowerCase() === USDC_ADDRESS) return 'buy';
		}
		return 'sell';
	}

	/**
	 * Returns parsed params if the rainlang matches the pyth-price-baseline pattern,
	 * otherwise null (so we can filter it out).
	 *
	 * Expected snippets:
	 *   io: mul(call<2>() 1.005)
	 *   pyth-price(0xFEED... 28800)
	 */
	function parseOrderParams(rainlang: string): OrderParams | null {
		// multiplier: mul(call<2>() 1.005)
		const multMatch = rainlang.match(/mul\(\s*call\s*<\s*2\s*>\s*\(\s*\)\s+([\d.]+)\s*\)/);
		if (!multMatch) return null;

		// feed + timeout: pyth-price(0x... 28800)
		const pythMatch = rainlang.match(/pyth-price\(\s*(0x[0-9a-fA-F]+)\s+(\d+)\s*\)/);
		if (!pythMatch) return null;

		return {
			multiplier: multMatch[1],
			feed: pythMatch[1],
			timeout: pythMatch[2]
		};
	}

	// ── State ───────────────────────────────────────────────────────────────────

	type Row = { order: RaindexOrder; params: OrderParams };

	let status: 'idle' | 'fetching' | 'done' | 'error' = 'idle';
	let progress = '';
	let errorMsg = '';
	let rows: Row[] = [];
	let totalFetched = 0;
	let totalMatched = 0;

	// ── Fetch all orders (paginated) and filter ─────────────────────────────────

	async function run() {
		status = 'fetching';
		rows = [];
		totalFetched = 0;
		totalMatched = 0;
		errorMsg = '';

		try {
			const client = await getOrderbookClient();

			let page = 1;
			let keepGoing = true;

			while (keepGoing) {
				progress = `fetching page ${page}…`;
				const result = await client.getOrders(
					null,
					{
						owners: [OWNER],
						active: true
					},
					page,
					FETCH_PAGE_SIZE
				);

				if (result.error) {
					throw new Error(result.error.readableMsg);
				}

				const batch = result.value.orders;
				const total = result.value.totalCount;
				totalFetched += batch.length;

				for (const order of batch) {
					if (!order.rainlang) continue;
					const params = parseOrderParams(order.rainlang);
					if (params) {
						rows = [...rows, { order, params }];
						totalMatched++;
					}
				}

				progress = `fetched ${totalFetched} / ${total} orders · ${totalMatched} matched`;

				// Stop when we've seen all orders or got an empty page
				if (batch.length === 0 || totalFetched >= total) {
					keepGoing = false;
				} else {
					page++;
				}
			}

			status = 'done';
			progress = '';
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
			status = 'error';
		}
	}

	// ── CSV export ──────────────────────────────────────────────────────────────

	function exportCsv() {
		const header = [
			'orderHash',
			'chainId',
			'raindex',
			'type',
			'inputToken',
			'outputToken',
			'multiplier',
			'timeout',
			'feed'
		];
		const csvRows = rows.map(({ order, params }) =>
			[
				order.orderHash,
				order.chainId,
				order.raindex,
				getOrderType(order),
				getUniqueSymbols(order.inputsList),
				getUniqueSymbols(order.outputsList),
				params.multiplier,
				params.timeout,
				feedAlias(params.feed)
			]
				.map((v) => `"${String(v).replace(/"/g, '""')}"`)
				.join(',')
		);

		const csv = [header.join(','), ...csvRows].join('\n');
		const blob = new Blob([csv], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `orders-${OWNER.slice(0, 8)}-${Date.now()}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	}

	onMount(() => {
		run();
	});
</script>

<div class="min-h-screen bg-gray-950 text-gray-100 font-mono">
	<!-- Header -->
	<header class="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
		<a href="/dashboard" class="text-gray-500 hover:text-gray-300 text-sm">← dashboard</a>
		<h1 class="text-lg font-bold tracking-tight">order export</h1>
	</header>

	<main class="px-6 py-6 max-w-5xl mx-auto">
		<!-- Owner badge -->
		<div class="mb-6 flex items-center gap-3">
			<span class="text-xs text-gray-500 uppercase tracking-wider">owner</span>
			<span class="font-mono text-xs text-blue-300 bg-blue-900/20 border border-blue-800 px-3 py-1 rounded">
				{OWNER}
			</span>
			<span class="text-xs text-gray-600">· active orders · pyth-price-baseline filter</span>
		</div>

		<!-- Status / progress -->
		{#if status === 'fetching'}
			<div class="flex items-center gap-3 mb-6 text-gray-400">
				<svg class="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
				</svg>
				<span class="text-sm">{progress}</span>
			</div>
		{/if}

		{#if status === 'error'}
			<div class="bg-red-900/30 border border-red-700 rounded-lg p-4 text-sm text-red-300 mb-6">
				{errorMsg}
				<button on:click={run} class="ml-4 underline text-red-400 hover:text-red-200">retry</button>
			</div>
		{/if}

		{#if status === 'done' || rows.length > 0}
			<!-- Summary + export -->
			<div class="flex items-center justify-between mb-4">
				<div class="text-sm text-gray-400">
					{rows.length} order{rows.length !== 1 ? 's' : ''} matched
					{#if status === 'fetching'}
						<span class="text-gray-600">(still loading…)</span>
					{/if}
				</div>
				{#if rows.length > 0}
					<button
						on:click={exportCsv}
						class="text-sm px-4 py-2 rounded bg-green-700 hover:bg-green-600 font-semibold flex items-center gap-2"
					>
						<svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
							<path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd" />
						</svg>
						export CSV
					</button>
				{/if}
			</div>

			<!-- Table -->
			{#if rows.length > 0}
				<div class="overflow-x-auto rounded-xl border border-gray-800">
					<table class="w-full text-xs">
						<thead>
							<tr class="bg-gray-900 border-b border-gray-800 text-gray-500 uppercase tracking-wider">
								<th class="px-4 py-3 text-left font-medium">order hash</th>
								<th class="px-4 py-3 text-left font-medium">chain</th>
								<th class="px-4 py-3 text-left font-medium">type</th>
								<th class="px-4 py-3 text-left font-medium">input</th>
								<th class="px-4 py-3 text-left font-medium">output</th>
								<th class="px-4 py-3 text-right font-medium">multiplier</th>
								<th class="px-4 py-3 text-right font-medium">timeout</th>
								<th class="px-4 py-3 text-left font-medium">feed</th>
								<th class="px-4 py-3 text-left font-medium">rainlang</th>
							</tr>
						</thead>
						<tbody>
							{#each rows as { order, params }, i}
								{@const orderType = getOrderType(order)}
								<tr
									class="border-b border-gray-800/60 hover:bg-gray-900/40 transition-colors {i % 2 === 0
										? 'bg-gray-950'
										: 'bg-gray-900/20'}"
								>
									<!-- Order hash -->
									<td class="px-4 py-3 font-mono">
										<a
											href="https://v6.raindex.finance/orders/{order.orderHash}"
											target="_blank"
											rel="noreferrer"
											class="text-blue-400 hover:text-blue-300 hover:underline"
											title={order.orderHash}
										>
											{order.orderHash.slice(0, 10)}…{order.orderHash.slice(-6)}
										</a>
									</td>
									<!-- Chain -->
									<td class="px-4 py-3 text-gray-500">{order.chainId}</td>
									<!-- Type -->
									<td class="px-4 py-3">
										<span
											class="px-2 py-0.5 rounded text-xs font-semibold {orderType === 'buy'
												? 'bg-green-900/50 text-green-400 border border-green-800'
												: 'bg-red-900/40 text-red-400 border border-red-800'}"
										>
											{orderType}
										</span>
									</td>
									<!-- Input token -->
									<td class="px-4 py-3 text-blue-400">{getUniqueSymbols(order.inputsList)}</td>
									<!-- Output token -->
									<td class="px-4 py-3 text-purple-400">{getUniqueSymbols(order.outputsList)}</td>
									<!-- Multiplier -->
									<td class="px-4 py-3 text-right text-yellow-400 font-semibold"
										>{params.multiplier}</td
									>
									<!-- Timeout -->
									<td class="px-4 py-3 text-right text-blue-300">{params.timeout}s</td>
									<!-- Feed alias -->
									<td class="px-4 py-3 text-gray-300" title={params.feed}>
										{feedAlias(params.feed)}
									</td>
									<!-- Rainlang toggle -->
									<td class="px-4 py-3">
										<details class="max-w-xs">
											<summary
												class="cursor-pointer text-gray-600 hover:text-gray-400 select-none whitespace-nowrap"
												>view</summary
											>
											<pre
												class="mt-2 bg-gray-950 rounded p-2 text-gray-300 text-xs leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto w-96">{order.rainlang}</pre>
										</details>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else if status === 'done'}
				<div class="text-center text-gray-600 py-20 text-sm">
					no orders matched the pyth-price-baseline pattern
				</div>
			{/if}
		{/if}
	</main>
</div>
