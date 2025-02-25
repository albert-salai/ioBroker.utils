import { IoAdapter, ValType, IoStateOpts, dateStr, valStr }		from './io-adapter';
import { IoOperator }		from './io-operator';


// AnyState			-		IoState<number | boolean | string>
export type AnyState = IoState<ValType>;

// WriteState		-		callback
type WriteState	= (state: AnyState, val: ValType) => Promise<void>;

// ~~~~~~~
// IoState
// ~~~~~~~
export class IoStates {
	public static readonly	allStates:		Record<string, AnyState> = {};		// by stateId
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

	/**
	 *
	 * @param param0
	 */
	constructor({ stateId, name, unit, write }: { stateId: string, name: string, unit: string, write: boolean }) {
		this.stateId	= stateId;
		this.name		= name;
		this.unit		= unit;
		this.writable	= write;
	}

	/**
	 *
	 * @param stateId
	 * @param valObj
	 * @returns
	 */
	public static async create<T extends ValType>(stateId: string, valObj: IoStateOpts<T>): Promise<IoState<T>> {
		//adapter.logf.debug('%-15s %-15s %-10s %-50s', this.name, 'create()', '', stateId);
		if (IoState.allStates[stateId])	{
			throw new Error(`${this.name}: create(): ${stateId} already created`);
		}

		const { name, write, unit, def } = valObj.common;
		//Object.assign(valObj.common, { type: typeof def });		FIXME: needed?

		// create state object
		await IoAdapter.this.writeStateObj(stateId, valObj);

		// write default state val
		const valState = await IoAdapter.this.readState(stateId) ?? { val: null };
		if (valState.val === null) {
			await IoAdapter.this.writeState(stateId, { 'val': def, 'ack': true });
		}

		// create IoState
		return new IoState<T>({
			stateId,
			'name':			name,
			'write':		write ?? false,
			'unit':			unit  ?? '',
			'val':			def,
		});
	}


	/**
	 *
	 * @param stateId
	 * @returns
	 */
	public static async load<T extends ValType>(stateId: string): Promise<IoState<T> | null> {
		const adapter = IoAdapter.this;

		// return existing state
		if (IoStates.allStates[stateId]) {
			adapter.logf.debug('%-15s %-15s %-10s %-50s', this.name, 'load()', 'reusing', stateId);
			return IoStates.allStates[stateId] as IoState<T>;
		}

		// return null if state object does not exist
		const stateObj = await adapter.readStateObject(stateId);
		if (! stateObj) {
			adapter.logf.error('%-15s %-15s %-10s %-50s', this.name, 'load()', 'missing', 'valObj '+stateId);
			return null;
		}

		// return null if state does not exist
		const state = await adapter.readState(stateId);
		if (! state) {
			adapter.logf.error('%-15s %-15s %-10s %-50s', this.name, 'load()', 'missing', 'valState '+stateId);
			return null;
		} else if (state.val === null) {
			adapter.logf.error('%-15s %-15s %-10s %-50s', this.name, 'load()', 'invalid', 'valState '+stateId);
			return null;
		}

		// ensure val type is correct
		let val: T | undefined;
		try			{ val = state.val as T;	}
		catch (e)	{ /* empty */			}
		if (val === undefined  ||  typeof val !== typeof state.val  ||  typeof val !== stateObj.common.type) {
			adapter.logf.error('%-15s %-15s %-10s %-50s %s', this.name, 'load()', 'type error', stateId, typeof state.val);
			return null;
		}

		// return new IoState
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



// ~~~~~~~
// IoState
// ~~~~~~~
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

	/**
	 *
	 * @param val
	 * @param ts
	 */
	public init(val: T, ts: number): void {
		if (ts <= 0) {
			this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'init()', 'invalid ts', this.stateId, dateStr(ts), valStr(val));

		} else {
			//this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'init()', '',  this.stateId, dateStr(ts), valStr(val));
			this.val	= val;		// latest val
			this.ts		= ts;		// latest ts (always > 0)
		}
	}

	/**
	 *
	 * @param val
	 * @param ts
	 */
	public async update(val: T, ts: number): Promise<void> {		// also called vom history
		if (ts <= 0) {
			this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'update()', 'invalid ts', this.stateId, dateStr(ts), valStr(val));
			return;

		} else if (IoOperator.isOnline()) {
			//this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'update()', '', this.stateId, dateStr(ts), valStr(val));
		}

		// set val, ts, lastChange, valChangeTs
		this.ts = ts;					// latest ts (always > 0)
		if (this.val !== val) {
			this.val   = val;			// latest val

			// execute operator triggered from 'this' input state
			for (const operator of this.inputFor) {
				await  operator.exec(this);
			}
		}
	}

	/**
	 *
	 * @param val
	 */
	public async write(val: ValType): Promise<void> {
		if ((typeof val === 'number'  &&  ! Number.isFinite(val))) {
			this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'write()', '', this.stateId, dateStr(), valStr(val));

		} else {
			await IoState.write(this, val);
		}
	}

	/**
	 *
	 * @returns
	 */
	toJSON(): { stateId: string, name: string, unit: string, writable: boolean, val: string, ts: string, inputFor: string[], outputFrom: string[] } {
		return {
			'stateId':		this.stateId,
			'name':			this.name,
			'unit':			this.unit,
			'writable':		this.writable,
			'val':			JSON.stringify(this.val),
			'ts':			dateStr(this.ts),
			'inputFor':		this.inputFor  .map(op => `Operator<${op.constructor.name}>`),
			'outputFrom':	this.outputFrom.map(op => `Operator<${op.constructor.name}>`),
		}
	}
}
