export type		{	AdapterOptions	}			from '@iobroker/adapter-core';
import { Adapter,	AdapterOptions	}			from '@iobroker/adapter-core';
import { Mutex, withTimeout }					from 'async-mutex';
import { sprintf }								from 'sprintf-js';
import { diff as deepDiff }						from 'deep-diff';

// see also
//		https://github.com/ioBroker/ioBroker/wiki/Adapter-Development-Documentation#structure-of-io-packagejson
//		https://github.com/ioBroker/ioBroker.js-controller/blob/master/packages/adapter/src/lib/adapter/adapter.ts

// AsyncTimeoutMs
const AsyncTimeoutMs = 1000*10;			// 10 seconds


// dateStr(ts)
export function dateStr(ts: number = Date.now()): string {
	const  d = new Date(ts);
	return sprintf('%02d.%02d.%04d %02d:%02d:%02d', d.getDate(), d.getMonth() + 1, d.getFullYear(), d.getHours(), d.getMinutes(), d.getSeconds());
}

// valStr(ts)
export function valStr(val: ioBroker.StateValue): string {					// val: string | number | boolean | null
	if		(typeof val ===	'number'	)	{ return isFinite(val) ? (Math.round(val*1e6)/1e6).toString() : val.toString(); }
	else if (typeof val ===	'boolean'	)	{ return val ? 'ON' : 'OFF';	}
	else if (typeof val === 'string'	)	{ return val;					}
	else									{ return JSON.stringify(val);	}
}


// StateValType, StateChange, StateChangeCb
export type			ValType			=  number  |  boolean  |  string;
export interface	StateChange		{ val: ValType, ack: boolean, ts: number }
type 				StateChangeCb	= (stateChange: StateChange) => void | Promise<void>;

// StateChangeOpts
interface StateChangeOpts {
	stateId: 		string,
	cb:				StateChangeCb,
	val?:			ValType,			// subscribe only to this val
	ack?:			boolean,			// subscribe only to this ack
}

// WriteStateObj
export interface HistoryObj {						// DEFAULT
	'enabled'?:						boolean,		// false
	'changesOnly'?:					boolean,		// false		Record changes only
	'debounceTime'?:				number,			// 0			Only logs the value if it stays unchanged for X ms
	'blockTime'?:					number,			// 0			Ignore all new values for X ms after last logged value
	'changesRelogInterval'?:		number,			// 0 			Record the same values (seconds)
	'changesMinDelta'?:				number,			// 0			Minimum difference from last value
	'ignoreBelowNumber'?:			string,			// ''			Ignore values below
	'disableSkippedValueLogging'?:	boolean,		// false		Disable charting optimized logging of skipped values
	'storageType'?:					string,			// ''
	'counter'?:						boolean,		// false		Counter
	'aliasId'?:						string,			// ''
	'retention'?:					number,			// 0 			Storage retention (seconds)
	'customRetentionDuration'?:		number,			// 365
	'maxLength'?:					number,			// 10			maximum datapoint count in RAM
	'enableDebugLogs'?:				boolean,		// false		Enable enhanced debug logs for the state
	'debounce'?:					number,			// 0
}

// IoStateOpts<T>		-		same as ioBroker.StateCommon but only with 'name' and 'def' as required properties
export interface IoStateOpts<T extends ValType> {
	common:		Omit<Partial<ioBroker.StateCommon>, 'def' | 'type'> & {
					name:	string,
					def:	T,
				},
	native?:	ioBroker.SettableStateObject['native'],
	history?:	HistoryObj,
}


// ~~~~~~~~~
// IoAdapter
// ~~~~~~~~~
export class IoAdapter extends Adapter {
	private static	this_:				IoAdapter;
	public			historyId													= '';		// 'sql.0'
	private			stateChangeSpecs:	Record<string, StateChangeOpts[]>		= {};		// by stateId
	private			stateObject:		Record<string, ioBroker.StateObject>	= {};		// by stateId
	private			mutex														= withTimeout(new Mutex(), AsyncTimeoutMs);
	private			saveConfig:			boolean;
	public logf = {
		'silly':	(_fmt: string, ..._args: unknown[]): void => { /* empty */ },
		'info':		(_fmt: string, ..._args: unknown[]): void => { /* empty */ },
		'debug':	(_fmt: string, ..._args: unknown[]): void => { /* empty */ },
		'warn':		(_fmt: string, ..._args: unknown[]): void => { /* empty */ },
		'error':	(_fmt: string, ..._args: unknown[]): void => { /* empty */ },
	};

	// static getters: IoAdapter.this, IoAdapter.logf
	public static get this()	{ return IoAdapter.this_;		}
	public static get logf()	{ return IoAdapter.this_.logf;	}

	/**
	 *
	 * @param options
	 */
	public constructor(options: AdapterOptions) {
		super(options);
		IoAdapter.this_  = this;
		this.saveConfig = false;

		// on ready
		// ~~~~~~~~
		this.on('ready', async () => {
			try {
				await this.setState('info.connection', false, true);

				// unhandledRejection
				process.on('unhandledRejection', (reason: string, p: Promise<unknown>) => {
					this.log.error(`unhandledRejection ${reason} ${JSON.stringify(p, null, 4)} ${(new Error('')).stack ?? ''}`);
				});

				// uncaughtException
				process.on('uncaughtException', (err, origin) => {
					this.log.error(`uncaughtException ${err}\n${origin}`);
				});

				// logf
				const pad = ' '.repeat(Math.max(0, 16 - this.namespace.length));
				this.logf.silly		= (fmt: string, ...args) => { this.log.silly(sprintf(pad		+ fmt, ...args)); };
				this.logf.info		= (fmt: string, ...args) => { this.log.info (sprintf(pad+' '	+ fmt, ...args)); };
				this.logf.debug		= (fmt: string, ...args) => { this.log.debug(sprintf(pad		+ fmt, ...args)); };
				this.logf.warn		= (fmt: string, ...args) => { this.log.warn (sprintf(pad+' '	+ fmt, ...args)); };
				this.logf.error		= (fmt: string, ...args) => { this.log.error(sprintf(pad		+ fmt, ...args)); };

				// historyId
				const systemConfig = await this.getForeignObjectAsync('system.config');
				this.historyId = systemConfig?.common.defaultHistory  ??  '';

				// call onReady()
				await this.onReady();
				await this.setState('info.connection', true, true);

				// save config and restart adapter
				if (this.saveConfig) {
					await this.updateConfig(this.config);			// don't await here; will restart adapter
					return;
				}

			} catch (e: unknown) {
				const stack = (e instanceof Error) ? (e.stack ?? '') : JSON.stringify(e);
				this.log.error(stack);
				await this.setState('info.connection', false, true);
			}
		});

		// on stateChange
		// ~~~~~~~~~~~~~~
		this.on('stateChange', (stateId: string, stateChange: ioBroker.State | null | undefined) => {
			void this.runAsync(async () => {		// don't await here; handle state changes one-by-one!
				if (stateChange) {
					const { val, ack, ts } = stateChange;
					if (val === null) {
						this.logf.warn('%-15s %-15s %-10s %-50s', this.constructor.name, 'onChange()', 'val null', stateId);
					} else {
						await this.onChange(stateId, { val, ack, ts });		// dont't await here to avoid mutex deadlock
					}
				} else {
					this.logf.warn('%-15s %-15s %-10s %-50s', this.constructor.name, 'onChange()', 'deleted',  stateId);
				}
			});
		});

		// on unload
		// ~~~~~~~~~
		this.on('unload', async (callback: () => void) => {
			try					{ await this.onUnload();														}
			catch (e: unknown)	{ this.log.error((e instanceof Error) ? (e.stack ?? '') : JSON.stringify(e));	}
			finally				{ callback();																	}
		});

		// this.on('objectChange',	this.onObjectChange.bind(this));
		// this.on('message',		this.onMessage.bind(this));
	}


	/**
	 *
	 */
	public save_config(): void {
		this.logf.warn('%-15s %-15s %-10s %-50s', this.constructor.name, 'save_config()', '', 'will restart ...');
		this.saveConfig = true;
	}


	/**
	 *
	 */
	protected async onReady(): Promise<void> { /* empty */ }


	/**
	 *
	 */
	protected async onUnload(): Promise<void> { /* empty */ }


	/**
	 *
	 * @param stateId
	 * @param common
	 */
	public async writeFolderObj(stateId: string, common: ioBroker.SettableFolderObject['common']): Promise<void> {
		const obj: ioBroker.SettableFolderObject = {
			'type':			'folder',
			'common':		common,
			'native':		{}
		};
		// `setForeignObjectAsync` is deprecated. use `adapter.setForeignObject` without a callback instead
		await this.setForeignObject(stateId, obj);
	}


	/**
	 *
	 * @param stateId
	 * @param common
	 */
	public async writeDeviceObj(stateId: string, common: ioBroker.SettableDeviceObject['common']): Promise<void> {
		const obj: ioBroker.SettableDeviceObject = {
			'type':			'device',
			'common':		common,
			'native':		{}
		};
		// `setForeignObjectAsync` is deprecated. use `adapter.setForeignObject` without a callback instead
		await this.setForeignObject(stateId, obj);
	}


	/**
	 *
	 * @param stateId
	 * @param common
	 */
	public async writeChannelObj(stateId: string, common: ioBroker.SettableChannelObject['common']): Promise<void> {
		const obj: ioBroker.SettableChannelObject = {
			'type':			'channel',
			'common':		common,
			'native':		{}
		};
		// `setForeignObjectAsync` is deprecated. use `adapter.setForeignObject` without a callback instead
		await this.setForeignObject(stateId, obj);
	}

	/**
	 *
	 * @param stateId
	 * @param common
	 */
	//
	public async writeStateObj(stateId: string, opts: IoStateOpts<ValType>): Promise<ioBroker.StateObject> {
		// type
		const type: ioBroker.CommonType =
			(typeof opts.common.def === 'number' ) ? 'number'  :
			(typeof opts.common.def === 'boolean') ? 'boolean' : 'string';

		// optsCommon with assigned defaults
		const optsCommon = Object.assign({
			'type':		type,			// required by ioBroker.StateCommon
			'read':		true,			// required by ioBroker.StateCommon
			'write':	false,			// required by ioBroker.StateCommon
			'role':		'value',		// required by ioBroker.StateCommon
			'custom':	{},
		}, opts.common);

		// oldObj, newObj
		const oldObj: ioBroker.SettableStateObject = { 'type': 'state', 'common': optsCommon, 'native':                {} };
		const newObj: ioBroker.SettableStateObject = { 'type': 'state', 'common': optsCommon, 'native': opts.native ?? {} };

		// read existing state object
		let stateObj = await this.getForeignObjectAsync(stateId);
		if (stateObj) {
			Object.assign(oldObj.common, stateObj.common);
			Object.assign(oldObj.native, stateObj.native);
		}

		// update history in newObj.common.custom		-		see https://github.com/ioBroker/ioBroker.sql/blob/master/main.js
		// FIXME: will overwrite existing history settings
		if (this.historyId) {
			// add history from opts.history to newObj.common.custom
			const optsHistory = opts.history ?? { enabled: false };
			if (optsHistory.enabled) {
				const newCustom  = newObj.common.custom = newObj.common.custom ?? {};
				const newHistory = newCustom[this.historyId] as (HistoryObj | undefined) ?? { 'enabled': false };
				newCustom[this.historyId] = Object.assign(newHistory, optsHistory, {
					'changesOnly':				true,			// enable changesOnly
					'changesRelogInterval':		86400,			// relog  every day  (3600*24 s)
				});
				delete newHistory.retention;

			// copy history from oldObj.common.custom to newObj.common.custom
			} else if (oldObj.common.custom) {
				const oldCustom  = oldObj.common.custom;
				const oldHistory = oldCustom[this.historyId] as (HistoryObj | undefined);
				if (oldHistory) {
					const newCustom = newObj.common.custom = newObj.common.custom ?? {};
					newCustom[this.historyId] = oldHistory;
				}
			}
		}

		// create new or update existing object
		const diffs = (deepDiff(oldObj, newObj) ?? []);
		for (const diff of diffs) {
			const { path, kind } = diff;
			const pathStr = (path ?? ['']).map(val => String(val)).join('.');
			if		(kind === 'N')  { this.logf.info('%-15s %-15s %-10s %-50s %s',				this.constructor.name, 'writeStateObj()', 'added',   pathStr, JSON.stringify(diff.rhs));							}
			else if (kind === 'D')  { this.logf.info('%-15s %-15s %-10s %-50s %s',				this.constructor.name, 'writeStateObj()', 'deleted', pathStr, JSON.stringify(diff.lhs));							}
			else if (kind === 'E')  { this.logf.info('%-15s %-15s %-10s %-50s %-20s --> %s',	this.constructor.name, 'writeStateObj()', 'edited',  pathStr, JSON.stringify(diff.lhs), JSON.stringify(diff.rhs));	}
			else  /* kind === 'A'*/ { this.logf.info('%-15s %-15s %-10s %-50s %s',				this.constructor.name, 'writeStateObj()', 'changed', pathStr, JSON.stringify(diff.item));							}
		}

		// `setForeignObjectAsync` is deprecated. use `adapter.setForeignObject` without a callback instead
		if (! stateObj  ||  diffs.length > 0) {
			await this.setForeignObject(stateId, newObj);
			stateObj = await this.getForeignObjectAsync(stateId);
		}

		// return ioBroker.StateObject
		if (stateObj?.type !== 'state') {
			this.logf.error('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'writeStateObj()', 'oldObj', stateId, JSON.stringify(oldObj, null, 4));
			this.logf.error('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'writeStateObj()', 'newObj', stateId, JSON.stringify(newObj, null, 4));
				throw new Error(`${this.constructor.name}: writeStateObj(): invalid stateObj:\n${JSON.stringify(stateObj, null, 4)}`);
		}
		return stateObj;
	}


	/**
	 *
	 * @param stateId
	 * @returns
	 */
	public async readStateObject(stateId: string): Promise<ioBroker.StateObject | null> {
		const obj = await this.getForeignObjectAsync(stateId) ?? null;		// return null instead of undefined
		return (obj?.type === 'state') ? obj : null;
}


	/**
	 *
	 * @param stateId
	 * @param state
	 */
	public async writeState(stateId: string, state: ioBroker.SettableState): Promise<void> {
		//this.logf.debug('%-15s %-15s %-10s %-50s %-25s %-3s %s', this.constructor.name, 'writeState()', '', stateId, this.dateStr(state.ts), (state.ack ? '' : 'cmd'), valStr(state.val));
		await this.setForeignStateAsync(stateId, state);
	}


	/**
	 *
	 * @param stateId
	 * @returns
	 */
	public async readState(stateId: string): Promise<ioBroker.State | null> {
		const  state = await this.getForeignStateAsync(stateId);
		return state ?? null;
	}


	/**
	 *
	 * @param spec
	 */
	public async subscribe(spec: StateChangeOpts): Promise<void> {
		// add spec to stateChangeSpecs
		const stateId	= spec.stateId;
		const specs		= this.stateChangeSpecs[stateId] = this.stateChangeSpecs[stateId]  ??  [];
		const len		= specs.push(spec);
		this.logf.debug('%-15s %-15s %-10s %-50s %-4s %s', this.constructor.name, 'subscribe()', `#${String(len - 1)}`, stateId, String('val' in spec ? spec.val : 'any'), ('ack' in spec ? (spec.ack ? 'ack' : 'cmd') : '*'));
		if (len === 1) {
			const stateObj = await this.readStateObject(stateId);
			if (stateObj) {
				this.stateObject[stateId] = stateObj;
				await this.subscribeForeignStatesAsync(stateId);
			}
		}
	}


	/**
	 *
	 * @param spec
	 */
	public async unsubscribe(spec: StateChangeOpts): Promise<void> {
		// remove spec from stateChangeSpecs
		const stateId  = spec.stateId;
		const specs		= (this.stateChangeSpecs[stateId]  ??  []).filter((s) => (s !== spec));
		this.stateChangeSpecs[stateId] = specs;
		this.logf.debug('%-15s %-15s %-10s %-50s %-4s %s', this.constructor.name, 'unsubscribe()', `#${String(specs.length)}`, stateId, String('val' in spec ? spec.val : 'any'), ('ack' in spec ? (spec.ack ? 'ack' : 'cmd') : '*'));
		if (specs.length === 0) {
			await this.unsubscribeForeignStatesAsync(stateId);
		}
	}


	/**
	 *
	 * @param spec
	 */
	public async subscribeOnce(spec: StateChangeOpts): Promise<void> {
		const cb = spec.cb;
		spec.cb = async (stateChange: StateChange) => {
			await this.unsubscribe(spec);
			await cb(stateChange);
		};
		await this.subscribe(spec);
	}


	/**
	 *
	 * @param stateId
	 * @param state
	 */
	private async onChange(stateId: string, { val, ack, ts }: { val: ValType, ack: boolean, ts: number }): Promise<void> {
		// call callbacks if opts do match
		const specs = this.stateChangeSpecs[stateId];
		if (! specs) {
			this.logf.error('%-15s %-15s %-10s %-50s %s   %-3s %s', this.constructor.name, 'onChange()', 'no spec', stateId, dateStr(ts), (ack ? '' : 'cmd'), valStr(val));

		} else {
			for (const spec of specs) {
				const valMatch = ('val' in spec) ? (spec.val === val) : true;
				const ackMatch = ('ack' in spec) ? (spec.ack === ack) : true;
				if (valMatch  &&  ackMatch) {
					await spec.cb({ val, ack, ts });
				}
			}
		}
	}


	/**
	 *
	 * @param cb
	 * @param ms
	 * @returns
	 */
	public setTimeoutAsync(cb: () => Promise<void>, ms: number): ioBroker.Timeout {
		return this.setTimeout(() => {
			void this.runAsync(async () => {
				await cb();
			});
		}, ms) ?? null;
	}

	/**
	 *
	 * @param cb
	 * @param ms
	 * @returns
	 */
	public setIntervalAsync(cb: () => Promise<void>, ms: number): ioBroker.Interval {
		return this.setInterval(() => {
			void this.runAsync(async () => {
				await cb();
			});
		}, ms) ?? null;
	}


	/**
	 *
	 * @param cb
	 * @returns
	 */
	private async runAsync<T>(cb: () => Promise<T>): Promise<T> {
		// used it in all iobroker event handlers and timer handlers
		try {
			return await this.mutex.runExclusive(cb);

		} catch (err: unknown) {
			this.logf.error('%-15s %-15s %-10s after %d ms\n%s', this.constructor.name, 'runExclusive()', 'timeout', AsyncTimeoutMs, (new Error('')).stack);
			return cb();
		}
	}
}
