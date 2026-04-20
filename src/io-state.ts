import { IoAdapter, ValType, IoStateOpts, dateStr, valStr }		from './io-adapter';
import { IoOperator }		from './io-operator';

// exported for IoOperator definitions to reference the generic state type
export type AnyState = IoState<ValType>;

// Injected by IoEngine to route writes through the adapter
type WriteState	= (state: AnyState, val: ValType) => Promise<void>;

/* Registry and factory for IoState instances. writeFn is injected by IoEngine before engine.start(). */
class IoStateStore {
	// getters instead of fields: IoAdapter.this/.logf are set after module load, so capturing at class init would be undefined
	private get adapter()	{ return IoAdapter.this; }
	private get logf()		{ return IoAdapter.logf; }

	private readonly	registry:	Record<string, AnyState>	= {};		// keyed by stateId
	private				writeFn:	WriteState					= (): Promise<void> => Promise.resolve();

	/* Injected by IoEngine (live) and IoHistoryEngine (history replay) to redirect writes. */
	public setWriteFn(fn: WriteState): void { this.writeFn = fn; }

	/* Routes the write through the active writeFn. Called by IoState.write(). */
	public async write(state: AnyState, val: ValType): Promise<void> { return this.writeFn(state, val); }

	/* Self-registration entry point — called by the IoState constructor. */
	public register(state: AnyState): void { this.registry[state.stateId] = state; }

	/* Returns the registered instance for stateId, or undefined if not yet registered. */
	public get(stateId: string): AnyState | undefined { return this.registry[stateId]; }

	/* Returns all registered states sorted by stateId. Used by IoEngine during startup. */
	public values(): AnyState[] { return Object.values(this.registry); }

	/*
	 * Creates the ioBroker state object and its IoState wrapper.
	 * Preserves a persisted value; only writes the default when val is null (state was never written).
	 * Throws if stateId is already registered or load() fails after write.
	 */
	public async create<T extends ValType>(stateId: string, valObj: IoStateOpts<T>): Promise<IoState<T>> {
		if (this.get(stateId))	{
			throw new Error(`${this.constructor.name}: create(): ${stateId} already created`);
		}

		// preserve persisted value — only write default when val is null (state was never written)
		await this.adapter.writeStateObj(stateId, valObj);
		const valState = await this.adapter.readState(stateId);
		if (valState?.val === null) {
			await this.adapter.writeState(stateId, { 'val': valObj.common.def, 'ack': true });
		}

		const ioState = await this.load<T>(stateId);
		if (! ioState) {
			throw new Error(`${this.constructor.name}: create(): ${stateId} load() failed`);
		}

		return ioState;
	}

	/*
	 * Loads an existing ioBroker state into an IoState wrapper.
	 * Returns the existing instance when already registered (avoids duplicates).
	 * Returns null with an error log when stateId is empty, the state object is missing,
	 * the value is null (never written), or the runtime type does not match the declared type.
	 */
	public async load<T extends ValType>(stateId: string): Promise<IoState<T> | null> {
		const cn = this.constructor.name;

		if (! stateId) {
			this.logf.warn('%-15s %-15s %-10s %-50s\n%s', cn, 'load()', 'stateId', 'empty', (new Error()).stack ?? '');
			return null;
		}

		const existing = this.get(stateId);
		if (existing) {
			this.logf.debug('%-15s %-15s %-50s', cn, 'load()', stateId);
			return existing as IoState<T>;
		}

		const stateObj = await this.adapter.readStateObject(stateId);
		if (! stateObj) {
			this.logf.error('%-15s %-15s %-50s', cn, 'load(): missing stateObj', stateId);
			return null;
		}

		const state = await this.adapter.readState(stateId);
		if (! state) {
			this.logf.error('%-15s %-15s %-50s', cn, 'load(): missing state', stateId);
			return null;

		} else if (state.val === null) {
			this.logf.error('%-15s %-15s %-50s', cn, 'load(): never written', stateId);
			return null;
		}

		if (typeof state.val !== stateObj.common.type) {
			this.logf.error('%-15s %-15s %-50s %s', cn, 'load(): type error', stateId, typeof state.val);
			return null;
		}

		return new IoState<T>({
			'stateId':		stateId,
			'name':			(typeof stateObj.common.name === 'string') ? stateObj.common.name : stateObj.common.name.en,
			'writable':		stateObj.common.write,
			'unit':			stateObj.common.unit ?? '',
			'val':			state.val as T,
			'ts':			state.ts,
		});
	}
}

// singleton: Node module cache ensures one instance across all importers
export const IoStates = new IoStateStore();



/*
 * Typed wrapper around a single ioBroker state value.
 * Self-registers in IoStates.registry on construction so load() can return existing instances.
 * Caller must not construct directly; use IoStates.create() or IoStates.load().
 */
export class IoState<T extends ValType> {
	private	readonly	logf				= IoAdapter.logf;
	public	readonly	stateId:			string;
	public	readonly	name:				string;
	public	readonly	unit:				string;
	public	readonly	writable:			boolean;
	public				logType:			'none' | 'changed' | 'write'	= 'none';
	private	readonly	triggerOperators:	IoOperator[]	= [];		// operators triggered when 'this' state changes
	private	readonly	writtenByOperators:	IoOperator[]	= [];		// operators that write 'this' state
	private				_val:				T;
	private				_ts					= -1;

	public get val(): T			{ return this._val; }
	public get ts():  number	{ return this._ts;  }

	/* Wires up trigger/writer relationships. Called by the IoOperator constructor. */
	public registerTrigger(op: IoOperator): void { this.triggerOperators  .push(op); }
	public registerWriter (op: IoOperator): void { this.writtenByOperators.push(op); }

	/* Read by IoHistoryEngine to classify states as src vs dst. */
	public get writerCount(): number { return this.writtenByOperators.length; }

	/* Registers the instance in IoStates.registry under stateId; sets val/ts as the initial value. */
	constructor({ stateId, name, unit, writable, val, ts }: {
		stateId:	string,
		name:		string,
		unit:		string,
		writable:	boolean,
		val:		T,
		ts:			number,
	}) {
		this.stateId	= stateId;
		this.name		= name;
		this.unit		= unit;
		this.writable	= writable;
		this._val		= val;
		this._ts		= ts;
		IoStates.register(this);		// self-register so IoStates.load() can return existing instances
	}

	/* Seeds val/ts from the initial state read. Logs an error and leaves val unchanged when ts is invalid (state was never written). */
	public set(val: T, ts: number): void {
		if (ts < 0) {
			this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'set()', 'invalid ts', this.stateId, dateStr(ts), valStr(val));

		} else {
			this._val	= val;
			this._ts	= ts;
		}
	}

	/*
	 * Handles a state-change event (also replayed from history).
	 * Triggers dependent operators only when val changes; skips operators when val is unchanged.
	 * Promise resolves after all triggerOperators have finished executing.
	 * Logs an error and skips all processing when ts is invalid.
	 */
	public async onStateChange(val: T, ts: number): Promise<void> {
		if (ts < 0) {
			this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'onStateChange()', 'invalid ts', this.stateId, dateStr(ts), valStr(val));

		} else {
			this._ts = ts;
			if (this._val !== val) {
				this._val  = val;
				for (const operator of this.triggerOperators) {
					await  operator.onTrigger(this);
				}
			}
		}
	}

	/*
	 * Writes val to the ioBroker state via IoStates.writeFn.
	 * Logs an error and skips non-finite numbers to avoid persisting NaN or Infinity.
	 */
	public async write(val: T): Promise<void> {
		if ((typeof val === 'number'  &&  ! Number.isFinite(val))) {
			this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'write()', '', this.stateId, dateStr(), valStr(val));

		} else {
			await IoStates.write(this, val);
		}
	}


	/*
	 * Fetches history from the configured history adapter (e.g. ioBroker.sql).
	 * Promise resolves after the sendTo round-trip completes; result array is never mutated after return.
	 * Returns [] when no historyId is configured.
	 * see https://github.com/ioBroker/ioBroker.sql/blob/master/main.js#L2302
	 */
	public async getHistory(options: { start?: number, end?: number, ack?: boolean, limit?: number }): Promise<{ ts: number, val: T }[]> {
		if (IoAdapter.this.historyId) {
			const history = await IoAdapter.this.sendToAsync(IoAdapter.this.historyId, 'getHistory', {
				'id':		this.stateId,
				'options':	{ 'aggregate': 'none', 'ignoreNull': true, ...options },
			}) as {result: {ts: number, val: T}[]} | undefined;
			return history?.result ?? [];

		} else {
			return [];
		}
	}


	/* Returns a JSON-serializable snapshot of the state's current values and operator linkage. */
	toJSON(): { stateId: string, name: string, unit: string, writable: boolean, ts: string, logType: string, triggerOperators: string[], writtenByOperators: string[], val: string } {
		return {
			'stateId':				this.stateId,
			'name':					this.name,
			'unit':					this.unit,
			'writable':				this.writable,
			'ts':					dateStr(this._ts),
			'val':					valStr(this._val),
			'triggerOperators':		this.triggerOperators  .map((op: IoOperator) => `Operator<${op.constructor.name}>`),
			'writtenByOperators':	this.writtenByOperators.map((op: IoOperator) => `Operator<${op.constructor.name}>`),
			'logType':				this.logType,
		}
	}
}
