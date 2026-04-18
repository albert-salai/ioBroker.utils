declare global {
	namespace ioBroker {
		// eslint-disable-next-line @typescript-eslint/no-empty-object-type
		interface AdapterConfig {
		}
	}
}

// Required: makes this file a module so the global augmentation above is recognized by TypeScript
export {};
