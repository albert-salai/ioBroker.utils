import { IoAdapter, ValType, IoStateOpts, dateStr, valStr }		from './io-adapter';
import { IoOperator }		from './io-operator';


export type AnyState = IoState<ValType>;

// Injected by IoEngine to route writes through the adapter
type WriteState	= (state: AnyState, val: ValType) => Promise<void>;

/** Registry and factory for IoState instances. Caller must inject `write` before use. */
export class IoStates {
	public static readonly	allStates:		Record<string, AnyState> = {};		// keyed by stateId
	public static			write:			WriteState = (): Promise<void> => Promise.resolve();
	protected	readonly	logf			= IoAdapter.logf;
	public		readonly	stateId:		string;
	public		readonly	name:			string;
	public		readonly	unit:			string;
	public		readonly	writable:		boolean;
	public					ts												= 0;
	public					logType:		'none' | 'changed' | 'write'	= 'none';
	public		readonly	inputFor:		IoOperator[]	= [];		// 'this' state is input   for  inputFor   operators
	public		readonly	outputFrom:		IoOperator[]	= [];		// 'this' state is output  from outputFrom operators

	constructor({ stateId, name, unit, write }: {
		stateId: string,
		name:	string,
		unit:	string,
		write:	boolean,
	}) {
		this.stateId	= stateId;
		this.name		= name;
		this.unit		= unit;
		this.writable	= write;
	}

	/** Creates the ioBroker state object and its IoState wrapper. Throws if already created or state is missing after write. */
	public static async create<T extends ValType>(stateId: string, valObj: IoStateOpts<T>): Promise<IoState<T>> {
		//adapter.logf.debug('%-15s %-15s %-10s %-50s', this.name, 'create()', '', stateId);
		if (IoState.allStates[stateId])	{
			throw new Error(`${this.name}: create(): ${stateId} already created`);
		}

		const { name, write, unit, def } = valObj.common;

		await IoAdapter.this.writeStateObj(stateId, valObj);

		// only write default if val is null (avoid overwriting persisted value)
		const valState = await IoAdapter.this.readState(stateId);
		if (valState === null) {
			throw new Error(`${this.name}: create(): ${stateId} state undefined`);
		}
		if (valState.val === null) {
			await IoAdapter.this.writeState(stateId, { 'val': def, 'ack': true });
		}

		return new IoState<T>({
			stateId,
			'name':			name,
			'write':		write ?? false,
			'unit':			unit  ?? '',
			'val':			def,
		});
	}

	/** Loads an existing ioBroker state into an IoState wrapper. Returns null (with error log) if missing or type-mismatched. */
	public static async load<T extends ValType>(stateId: string): Promise<IoState<T> | null> {
		const adapter = IoAdapter.this;

		if (! stateId) {
			adapter.logf.warn('%-15s %-15s %-10s %-50s\n%s', this.name, 'load()', 'stateId', 'empty', (new Error()).stack ?? '');
			return null;
		}

		if (IoStates.allStates[stateId]) {
			adapter.logf.debug('%-15s %-15s %-10s %-50s', this.name, 'load()', 'reusing', stateId);
			return IoStates.allStates[stateId] as IoState<T>;
		}

		const stateObj = await adapter.readStateObject(stateId);
		if (! stateObj) {
			adapter.logf.error('%-15s %-15s %-10s %-50s', this.name, 'load()', 'missing', 'valObj '+stateId);
			return null;
		}

		const state = await adapter.readState(stateId);
		if (! state) {
			adapter.logf.error('%-15s %-15s %-10s %-50s', this.name, 'load()', 'missing', 'valState '+stateId);
			return null;
		} else if (state.val === null) {
			adapter.logf.error('%-15s %-15s %-10s %-50s', this.name, 'load()', 'invalid', 'valState '+stateId);
			return null;
		}

		// cast and verify — ioBroker stores val as any, so runtime check is necessary
		let val: T | undefined;
		try			{ val = state.val as T;	}
		catch (e)	{ /* empty */			}
		if (val === undefined  ||  typeof val !== typeof state.val  ||  typeof val !== stateObj.common.type) {
			adapter.logf.error('%-15s %-15s %-10s %-50s %s', this.name, 'load()', 'type error', stateId, typeof state.val);
			return null;
		}

		const { name, write, unit } = stateObj.common;
		return new IoState<T>({
			'stateId':		stateId,
			'name':			(typeof name === 'string') ? name : name.en,
			'write':		write,
			'unit':			unit ?? '',
			'val':			val,
		});
	}
}



/** Typed wrapper around a single ioBroker state. Registered in `IoStates.allStates` on construction. */
export class IoState<T extends ValType> extends IoStates {
	public val:		T;

	constructor({ stateId, name, unit, write, val }: {
		stateId:	string,
		name:		string,
		unit:		string,
		write:		boolean,
		val:		T,
	}) {
		super({ stateId, name, unit, write });
		IoStates.allStates[stateId] = this;
		this.val = val;
	}

	/** Sets val/ts from an initial state read. Logs error if ts is invalid (state was never written). */
	public init(val: T, ts: number): void {
		if (ts <= 0) {
			this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'init()', 'invalid ts', this.stateId, dateStr(ts), valStr(val));

		} else {
			//this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'init()', '',  this.stateId, dateStr(ts), valStr(val));
			this.val	= val;
			this.ts		= ts;
		}
	}

	/** Called on every state-change event (also replayed from history). Triggers dependent operators only when val changes. */
	public async update(val: T, ts: number): Promise<void> {
		if (ts <= 0) {
			this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'update()', 'invalid ts', this.stateId, dateStr(ts), valStr(val));
			return;

		} else if (IoOperator.isOnline()) {
			//this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'update()', '', this.stateId, dateStr(ts), valStr(val));
		}

		this.ts = ts;
		if (this.val !== val) {
			this.val = val;
			for (const operator of this.inputFor) {
				await  operator.exec(this);
			}
		}
	}

	/** Writes val to the ioBroker state. Rejects non-finite numbers to avoid persisting NaN/Infinity. */
	public async write(val: ValType): Promise<void> {
		if ((typeof val === 'number'  &&  ! Number.isFinite(val))) {
			this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'write()', '', this.stateId, dateStr(), valStr(val));

		} else {
			await IoState.write(this, val);
		}
	}


	/** Fetches history from the configured history adapter (e.g. ioBroker.sql). Returns [] if no historyId is configured. */
	public async getHistory(options: { start?: number, end?: number, ack?: boolean, limit?: number }): Promise<{ ts: number, val: T }[]> {
		// see https://github.com/ioBroker/ioBroker.sql/blob/master/main.js#L2302
		if (IoAdapter.this.historyId) {
			const history = await IoAdapter.this.sendToAsync(IoAdapter.this.historyId, 'getHistory', {
				'id':			this.stateId,
				'options':		Object.assign({
									'aggregate':	'none',
									'ignoreNull':	true,
								}, options),
			}) as {result: {ts: number, val: T}[]} | undefined;
			return history?.result ?? [];

		} else {
			return [];
		}
	}


	toJSON(): { stateId: string, name: string, unit: string, writable: boolean, ts: string, logType: string, inputFor: string[], outputFrom: string[], val: string } {
		return {
			'stateId':		this.stateId,
			'name':			this.name,
			'unit':			this.unit,
			'writable':		this.writable,
			'ts':			dateStr(this.ts),
			'val':			valStr(this.val),
			'inputFor':		this.inputFor  .map(op => `Operator<${op.constructor.name}>`),
			'outputFrom':	this.outputFrom.map(op => `Operator<${op.constructor.name}>`),
			'logType':		this.logType,
		}
	}
}
