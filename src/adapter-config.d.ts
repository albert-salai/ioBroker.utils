declare global {
	namespace ioBroker {
		interface AdapterConfig {
			'sql-optimize':		boolean
		}
	}
}

// Required: makes this file a module so the global augmentation above is recognized by TypeScript
export {};
