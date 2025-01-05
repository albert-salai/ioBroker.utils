import { IoAdapter, ValType, IoStateObj, dateStr, valStr }		from './io-adapter';
import { IoOperator }		from './io-operator';
import { Timer }			from './io-timer';


// AnyState			-		IoState<number | boolean | string>
export type AnyState = IoState<ValType>;

// WriteState		-		callback
type WriteState	= (state: AnyState, val: ValType) => Promise<void>;

// ~~~~~~~
// IoState
// ~~~~~~~
export class IoStates {
	public static readonly	allStates:	Record<string, AnyState>		= {};		// by stateId
	public static			write:		WriteState						= (): Promise<void> => Promise.resolve();
	protected readonly		logf										= IoAdapter.logf;

	/**
	 *
	 * @param stateId
	 * @param obj
	 * @returns
	 */
	public static async create<T extends ValType>(stateId: string, obj: IoStateObj): Promise<IoState<T>> {
		const adapter = IoAdapter.this;
		if (IoState.allStates[stateId]) {
			throw new Error(`${this.name}: create(): ${stateId} already created`);
		}
		//adapter.logf.debug('%-15s %-15s %-10s %-50s', this.name, 'create()', '', stateId);

		// create state object
		const { name, type, write, unit } = obj.common;
		const def = obj.common.def as ValType | undefined;
		delete obj.common.def;
		await IoAdapter.this.writeStateObj(stateId, obj);

		// write default state val
		let stateChange = await IoAdapter.this.readState(stateId);
		if (def !== undefined) {
			if (typeof def !== type) {
				adapter.logf.error('%-15s %-15s %-10s %-50s %s', this.name, 'load()', 'invalid', 'def type of '+stateId, typeof def);
			} else if (! stateChange) {
				await IoAdapter.this.writeState(stateId, { 'val': def, 'ack': true });
				stateChange = await IoAdapter.this.readState(stateId);
			}
		}

		// val
		const defaultVal = def ?? ((type === 'number') ? 0 : (type === 'boolean' ? false : ''));
		if (! isType<T>(defaultVal)) {
			throw new Error(`${this.name}: create(): ${stateId} invalid defaultVal type ${typeof defaultVal}`);
		}

		// create IoState
		return new IoState<T>({
			stateId,
			'name':				name,
			'write':			write ?? false,
			'unit':				unit  ?? '',
			'val':				defaultVal,
			'ts':				stateChange?.ts ?? Date.now(),
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

		// load state
		} else {
			const stateObj = await adapter.readStateObject(stateId);
			if (! stateObj) {
				adapter.logf.error('%-15s %-15s %-10s %-50s', this.name, 'load()', 'missing', 'stateObj '+stateId);

			} else {
				const state = await adapter.readState(stateId);
				if (! state) {
					adapter.logf.error('%-15s %-15s %-10s %-50s', this.name, 'load()', 'missing', 'state '+stateId);

				} else if (state.val === null) {
					adapter.logf.error('%-15s %-15s %-10s %-50s %s', this.name, 'load()', 'invalid', 'val of '+stateId, JSON.stringify(state.val));

				} else {
					const { name, unit, write } = stateObj.common;

					if (typeof state.val !== stateObj.common.type) {
						adapter.logf.error('%-15s %-15s %-10s %-50s %s', this.name, 'load()', 'invalid', 'val type of '+stateId, typeof state.val);

					} else if (! isType<T>(state.val)) {
						adapter.logf.error('%-15s %-15s %-10s %-50s %s', this.name, 'load()', 'invalid', 'state.val type of '+stateId, typeof state.val);

					} else {
						// create IoState<T>
						return new IoState<T>({
							stateId,
							'name':				(typeof name === 'string') ? name : name.en,
							write,
							'unit':				unit ?? '',
							'val':				state.val,
							'ts':				state.ts,
						});
					}
				}
			}

			return null;
		}
	}
}



// ~~~~~~~
// IoState
// ~~~~~~~
export class IoState<T extends ValType> extends IoStates {
	public	readonly	stateId:		string;
	public	readonly	name:			string;
	public	readonly	unit:			string;
	public	readonly	writable:		boolean;
	public				val:			T;
	public				ts									= 0;
	private				valChangeTs							= 0;				// updated whenever val changes
	public	readonly	lastChange:		{ val: T, ts: number };					// updated whenever val changes

	public	readonly	inputFor:		IoOperator[]		= [];				// 'this' state is input   for  inputFor   operators
	public	readonly	outputFrom:		IoOperator[]		= [];				// 'this' state is output  from outputFrom operators
	public				logType:		'none' | 'changed' | 'write'		= 'none';

	constructor({ stateId, name, unit, write, val, ts }: {
		stateId:		string,
		name:			string,
		unit:			string,
		write:			boolean,
		val:			T,
		ts:				number,
	}) {
		super();
		this.stateId		= stateId;
		this.name			= name;
		this.unit			= unit;
		this.writable		= write;
		this.val			= val;
		this.lastChange		= { val, ts };		// updated whenever val changes

		IoStates.allStates[stateId] = this;
	}


	/**
	 *
	 * @param param0
	 */
	public valInit({ val, ts }: { val: T, ts: number }): void {
		const isInput	= this.inputFor  .length > 0;
		const isOutput	= this.outputFrom.length > 0;
		const dirStr	= (isInput && isOutput) ? 'in+out' : (isInput ? 'in' : (isOutput ? '   out' : ''));
		this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'valInit()', dirStr, this.stateId, dateStr(ts), valStr(val));

		this.lastChange.val	= this.val	= val;
		this.lastChange.ts	= this.ts	= ts;
		this.valChangeTs				= ts;
	}


	/**
	 *
	 * @param val
	 * @param ts
	 */
	public async valSet(val: T, ts: number): Promise<void> {		// also called vom history
		if (val !== this.val) {
			this.lastChange.val	= this.val;					// updated whenever val changes
			this.lastChange.ts	= this.valChangeTs;			// updated whenever val changes
			this.valChangeTs	= ts;						// updated whenever val changes
			this.val			= val;						// latest val
		}
		this.ts = ts;										// latest ts

		// execute operators
		for (const operator of this.inputFor) {
			if (this.valChanged()  ||  operator.execUnchanged()) {
				await  operator.execute(this);				// execute operator triggered from 'this' input state
			}
		}
	}


	/**
	 *
	 * @returns
	 */
	public valChanged(): boolean {
		return (this.ts === this.valChangeTs);
	}


	/**
	 *
	 * @param val
	 */
	public async write(val: ValType): Promise<void> {
		if ((typeof val === 'number'  &&  ! Number.isFinite(val))) {
			this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'write()', '', this.stateId, dateStr(Timer.now()), valStr(val));

		} else {
			await IoState.write(this, val);
		}
	}


	/**
	 *
	 * @returns
	 */
	toJSON(): { stateId: string, name: string, unit: string, writable: boolean, val: string, ts: string, lastChange: string, inputFor: string[], outputFrom: string[] } {
		return {
			'stateId':		this.stateId,
			'name':			this.name,
			'unit':			this.unit,
			'writable':		this.writable,
			'val':			JSON.stringify(this.val),
			'ts':			dateStr(this.ts),
			'lastChange':	JSON.stringify(this.lastChange),
			'inputFor':		this.inputFor  .map(op => `Operator<${op.constructor.name}>`),
			'outputFrom':	this.outputFrom.map(op => `Operator<${op.constructor.name}>`),
		}
	}
}




/**
 *
 * @param val
 * @returns
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function isType<T>(val: unknown): val is T {
	let tmp: T | undefined;
	try {
		tmp =  val as T;					// try to assign val to tmp: T
		tmp = (val === tmp) ? tmp : undefined;		// check if tmp has been converted
	} catch (err) {
		// empty
	}

	return (tmp !== undefined);
}
