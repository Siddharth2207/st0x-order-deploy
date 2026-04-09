<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { defaultConfig } from 'svelte-wagmi';
	import { base, polygon, arbitrum } from '@wagmi/core/chains';
	import { injected, walletConnect } from '@wagmi/connectors';

	onMount(async () => {
		const connectors = [injected()];

		// Optionally add WalletConnect — set VITE_PUBLIC_WALLETCONNECT_ID in .env
		const projectId = import.meta.env.VITE_PUBLIC_WALLETCONNECT_ID ?? '';
		if (projectId) {
			// @ts-expect-error wagmi connector type mismatch
			connectors.push(walletConnect({ projectId }));
		}

		const cfg = defaultConfig({
			autoConnect: true,
			appName: 'st0x-order-deploy',
			chains: [base, polygon, arbitrum],
			connectors,
			walletConnectProjectId: projectId || 'dummy'
		});
		await cfg.init();
	});
</script>

<slot />
