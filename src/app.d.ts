// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

// Vite environment variable types
interface ImportMetaEnv {
	readonly VITE_PUBLIC_WALLETCONNECT_ID?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}

export {};
