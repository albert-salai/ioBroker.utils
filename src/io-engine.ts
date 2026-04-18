import { IoAdapter, StateChange, ValType, dateStr, valStr }		from './io-adapter';
import { IoStates, AnyState }		from './io-state';
import { IoTimer }					from './io-timer';
import { sortBy }					from './io-util';
import { IoHistoryEngine }			from './io-history-engine';


/* Orchestrates history replay and live-mode state seeding, SQL integration, and timer lifecycle. */
export class IoEngine {
	private readonly	adapter	= IoAdapter.this;
	private readonly	logf	= IoAdapter.logf;

	public constructor() {
		this.logf.debug('%-15s %-15s %-10s', this.constructor.name, 'constructor()', '');
	}

	/* Seeds all registered IoStates and activates subscriptions. If historyDays > 0, runs SQL history replay first. Resolves after live mode is fully active. */
	public async start(historyDays: number): Promise<void> {
		const adapter	= this.adapter;
		const allStates	= Object.values(IoStates.registry).sort(sortBy('stateId'));

		await this.add_folders(allStates);

		// history: replay SQL or seed from current ioBroker state
		const historyReplayed = (historyDays > 0)  &&  await new IoHistoryEngine().run(historyDays, allStates);

		// ensure IoTimer is configured for live mode
		IoTimer.configure();

		if (! historyReplayed) {
			let notInitialized = 0;
			await Promise.all(allStates.map(async ioState => {
				const state = await this.adapter.readState(ioState.stateId);

				if (state?.val == null) {
					this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'start()', state === null ? 'no state' : 'null val', ioState.stateId, dateStr(ioState.ts), valStr(ioState.val));
					notInitialized++;
				} else if (state.ts > IoTimer.now()) {
					// future ts indicates clock skew or bad data
					this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'start()', 'future ts', ioState.stateId, dateStr(state.ts), valStr(state.val));
					notInitialized++;
				} else {
					ioState.seed(state.val, state.ts);
				}
			}));
			if (notInitialized > 0) {
				throw new Error(`${this.constructor.name}: start(): ${String(notInitialized)} of ${String(allStates.length)} states not initialized`);
			}
		}

		// live: install writeFn and subscribe to all states
		IoStates.writeFn = async (ioState: AnyState, val: ValType): Promise<void> => {
			const ts  =   Date.now();
			const ack = ! ioState.writable;
			if (ioState.logType === 'write') {
				this.logf.debug('%-15s %-15s %-10s %-50s %s   %s%s', ioState.constructor.name, 'write()', '', ioState.stateId, dateStr(ts), valStr(val), ack ? '' : ' cmd');
			}
			await adapter.writeState(ioState.stateId, { val, ack, ts });
		};

		await Promise.all(allStates.map(ioState =>
			adapter.subscribe({ 'stateId': ioState.stateId, 'ack': true, 'cb': async (state: StateChange) => {
				if (ioState.logType === 'changed'  &&  state.val !== ioState.val) {
					this.logf.debug('%-15s %-15s %-10s %-50s %s   %s%s', ioState.constructor.name, 'onChange()', ((state.val === ioState.val) ? 'unchanged' : ''), ioState.stateId, dateStr(state.ts), valStr(state.val), state.ack ? '' : ' cmd');
				}
				await ioState.onStateChange(state.val, state.ts);
			}})
		));

		this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'start()', 'done', '');
	}


	/* Creates folder objects for every non-leaf path segment of states under this adapter's namespace. */
	private async add_folders(ioStates: AnyState[]): Promise<void> {
		const folderIds = new Set<string>();

		for (const stateId of ioStates.map(ioState => ioState.stateId)) {
			if (stateId.startsWith(this.adapter.namespace)) {
				const path = stateId.split('.').slice(0, -1);
				if (path.length >= 3) {
					folderIds.add(path.join('.'));
				}
			}
		}

		await Promise.all([...folderIds].map(folderId =>
			this.adapter.writeFolderObj(folderId, { 'name': folderId.split('.').slice(-1)[0] ?? 'error' })
		));
	}
}
