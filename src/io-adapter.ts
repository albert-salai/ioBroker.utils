import type	{ AdapterOptions }		from '@iobroker/adapter-core';
import { Adapter }					from '@iobroker/adapter-core';
import { Mutex, withTimeout }		from 'async-mutex';
import { sprintf }					from 'sprintf-js';
import { diff as deepDiff }			from 'deep-diff';
import { IoTimer }					from './io-timer';

const AsyncTimeoutMs = 1000*20;	// 20 s chosen to be safely longer than any expected async I/O round-trip to ioBroker


/* Formats ts (epoch-ms) as 'DD.MM.YYYY HH:MM:SS'. Defaults to now if ts is omitted. */
export function dateStr(ts: number = IoTimer.now()): string {
	const  d = new Date(ts);
	return sprintf('%02d.%02d.%04d %02d:%02d:%02d', d.getDate(), d.getMonth() + 1, d.getFullYear(), d.getHours(), d.getMinutes(), d.getSeconds());
}

/* Returns a human-readable string for any ioBroker state value. Numbers rounded to 6 decimal places. */
export function valStr(val: ioBroker.StateValue): string {
	if		(typeof val ===	'number'	)	{ return isFinite(val) ? (Math.round(val*1e6)/1e6).toString() : val.toString(); }
	else if (typeof val ===	'boolean'	)	{ return val ? 'ON' : 'OFF';	}
	else if (typeof val === 'string'	)	{ return val;					}
	else									{ return JSON.stringify(val);	}
}


export type			ValType			=  number  |  boolean  |  string;
export interface	StateChange		{ val: ValType, ack: boolean, ts: number }
type 				StateChangeCb	= (stateChange: StateChange) => void | Promise<void>;

/* Options for a single state-change subscription; val/ack act as filters when present. */
interface StateChangeOpts {
	stateId: 		string,
	cb:				StateChangeCb,
	val?:			ValType,			// subscribe only to this val
	ack?:			boolean,			// subscribe only to this ack
}

export interface HistoryOpts {						// DEFAULT
	'enabled'?:						boolean,		// n/a
	'storageType'?:					string,			// ''
	'counter'?:						boolean,		// false		Counter
	'aliasId'?:						string,			// ''
	'debounceTime'?:				number,			// 0			Only logs the value if it stays unchanged for X ms
	'blockTime'?:					number,			// 0			Ignore all new values for X ms after last logged value
	'changesOnly'?:					boolean,		// true			Record changes only
	'changesRelogInterval'?:		number,			// 0 			Record the same values (seconds)
	'changesMinDelta'?:				number,			// 0			Minimum difference from last value
	'ignoreBelowNumber'?:			string,			// ''			Ignore values below
	'disableSkippedValueLogging'?:	boolean,		// false		Disable charting optimized logging of skipped values
	'retention'?:					number,			// 0 			Storage retention (seconds)
	'customRetentionDuration'?:		number,			// 365
	'maxLength'?:					number,			// 0			maximum datapoint count in RAM
	'enableDebugLogs'?:				boolean,		// false		Enable enhanced debug logs for the state
	'debounce'?:					number,			// 1000
}

/* Same as ioBroker.StateCommon but with only name and def required. */
export interface IoStateOpts<T extends ValType> {
	common:		Omit<Partial<ioBroker.StateCommon>, 'def' | 'type'> & {
					name:	string,
					def:	T,
				},
	native?:	ioBroker.SettableStateObject['native'],
	history?:	HistoryOpts,
}


/*
 * Extends ioBroker Adapter with sprintf-formatted logging, mutex-serialized callbacks,
 * reference-counted foreign-state subscriptions, and history config merging.
 * logf is a no-op until onReady() resolves — caller must not rely on it before then.
 */
export class IoAdapter extends Adapter {
	private static	this_:				IoAdapter;						// singleton; set in constructor
	public			historyId													= '';		// 'sql.0'
	private			stateChangeSpecs:	Record<string, StateChangeOpts[]>		= {};		// by stateId; reference-counted
	private			mutex														= withTimeout(new Mutex(), AsyncTimeoutMs);
	private			saveConfig:			boolean;
	// Stubs replaced with real implementations in the `ready` handler once `this.log` and `this.namespace` are available
	public logf = {
		'silly':	(_fmt: string, ..._args: unknown[]): void => { /* noop */ },
		'info':		(_fmt: string, ..._args: unknown[]): void => { /* noop */ },
		'debug':	(_fmt: string, ..._args: unknown[]): void => { /* noop */ },
		'warn':		(_fmt: string, ..._args: unknown[]): void => { /* noop */ },
		'error':	(_fmt: string, ..._args: unknown[]): void => { /* noop */ },
	};

	/* Returns the singleton IoAdapter instance. */
	public static get this()	{ return IoAdapter.this_;		}
	/* Returns the logf object from the singleton instance. */
	public static get logf()	{ return IoAdapter.this_.logf;	}

	/* Registers ioBroker event handlers and sets the singleton. Caller must not use logf until onReady() resolves. */
	public constructor(options: AdapterOptions) {
		super(options);
		IoAdapter.this_  = this;
		this.saveConfig = false;

		this.on('ready', async () => {
			try {
				await this.setState('info.connection', false, true);

				process.once('unhandledRejection', (reason: string, p: Promise<unknown>) => {
					this.log.error(`unhandledRejection ${reason} ${JSON.stringify(p, null, 4)} ${(new Error('')).stack ?? ''}`);
				});

				process.once('uncaughtException', (err, origin) => {
					this.log.error(`uncaughtException ${err}\n${origin}`);
				});

				// pad aligns multi-adapter log output by namespace width
				const pad = ' '.repeat(Math.max(0, 16 - this.namespace.length));
				this.logf.silly		= (fmt: string, ...args) => { this.log.silly(sprintf(pad		+ fmt, ...args)); };
				this.logf.info		= (fmt: string, ...args) => { this.log.info (sprintf(pad+' '	+ fmt, ...args)); };
				this.logf.debug		= (fmt: string, ...args) => { this.log.debug(sprintf(pad		+ fmt, ...args)); };
				this.logf.warn		= (fmt: string, ...args) => { this.log.warn (sprintf(pad+' '	+ fmt, ...args)); };
				this.logf.error		= (fmt: string, ...args) => { this.log.error(sprintf(pad		+ fmt, ...args)); };

				const systemConfig = await this.getForeignObjectAsync('system.config');
				this.historyId = systemConfig?.common.defaultHistory  ??  '';

				await this.onReady();

				// updateConfig() restarts the adapter, so return immediately after
				if (this.saveConfig) {
					await this.updateConfig(this.config);			// will restart adapter
					return;
				}

				await this.setState('info.connection', true, true);

			} catch (e: unknown) {
				const stack = (e instanceof Error) ? (e.stack ?? '') : JSON.stringify(e);
				this.log.error(stack);
				await this.setState('info.connection', false, true);
			}
		});

		// All onStateChange dispatches are serialized through the mutex to prevent concurrent state mutations
		this.on('stateChange', (stateId: string, stateChange: ioBroker.State | null | undefined) => {
			if (stateChange) {
				const { val, ack, ts } = stateChange;
				if (val === null) {
					this.logf.warn('%-15s %-15s %-10s %-50s', this.constructor.name, 'onStateChange()', 'val null', stateId);

				} else {
					this.mutex.runExclusive(async () => {
						await this.onStateChange(stateId, { val, ack, ts });
					}).catch((err: unknown) => {
						const msg = (err instanceof Error) ? (err.stack ?? err.message) : String(err);
						this.logf.error('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'onStateChange()', 'error', stateId, msg);
					});
				}

			} else {
				this.logf.warn('%-15s %-15s %-10s %-50s', this.constructor.name, 'onStateChange()', 'deleted',  stateId);
			}
		});

		this.on('unload', async (callback: () => void) => {
			try					{ await this.onUnload();														}
			catch (e: unknown)	{ this.log.error((e instanceof Error) ? (e.stack ?? '') : JSON.stringify(e));	}
			finally				{ callback();																	}
		});

	}


	/** Flags config as dirty; the adapter will restart at the end of `onReady()` to apply changes. */
	public save_config(): void {
		this.logf.warn('%-15s %-15s %-10s %-50s', this.constructor.name, 'save_config()', '', 'will restart ...');
		this.saveConfig = true;
	}


	/* Override to perform adapter startup after ioBroker connection is established. */
	protected async onReady(): Promise<void> { /* noop */ }

	/* Override to perform cleanup before the adapter process exits. */
	protected async onUnload(): Promise<void> { /* noop */ }

	/* Creates or overwrites a folder object at stateId. Resolves after the write completes. */
	public async writeFolderObj(stateId: string, common: ioBroker.SettableFolderObject['common']): Promise<void> {
		const obj: ioBroker.SettableFolderObject = {
			'type':			'folder',
			'common':		common,
			'native':		{}
		};
		await this.setForeignObject(stateId, obj);
	}


	/* Creates or overwrites a device object at stateId. Resolves after the write completes. */
	public async writeDeviceObj(stateId: string, common: ioBroker.SettableDeviceObject['common']): Promise<void> {
		const obj: ioBroker.SettableDeviceObject = {
			'type':			'device',
			'common':		common,
			'native':		{}
		};
		await this.setForeignObject(stateId, obj);
	}


	/* Creates or overwrites a channel object at stateId. Resolves after the write completes. */
	public async writeChannelObj(stateId: string, common: ioBroker.SettableChannelObject['common']): Promise<void> {
		const obj: ioBroker.SettableChannelObject = {
			'type':			'channel',
			'common':		common,
			'native':		{}
		};
		await this.setForeignObject(stateId, obj);
	}


	/**
	 * Creates or updates a state object, merging history config with precedence:
	 * built-in defaults < existing ioBroker values < `opts.history`.
	 * Resolves to the post-write object as returned by ioBroker (not the input).
	 * Throws if the existing object at `stateId` is not of type `'state'`.
	 */
	public async writeStateObj(stateId: string, opts: IoStateOpts<ValType>): Promise<ioBroker.StateObject> {
		const oldStateObj = await this.getForeignObjectAsync(stateId);
		if (oldStateObj  &&  oldStateObj.type !== 'state') {
			throw new Error(`${this.constructor.name}: writeStateObj(): ${stateId}: invalid object type '${oldStateObj.type}'`);
		}

		const oldCustom: Record<string, unknown> = oldStateObj?.common.custom ?? {};

		// type is derived from def so callers don't have to specify both
		const newCommon: ioBroker.StateCommon = {
			'name':		opts.common.name,
			'def':		opts.common.def,
			'type':		(typeof opts.common.def === 'number' ) ? 'number' : (typeof opts.common.def === 'boolean') ? 'boolean' : 'string',
			'read':		true,
			'write':	false,
			'role':		'',
		};
		Object.assign(newCommon, opts.common);

		if (this.historyId) {
			if (opts.history?.enabled) {
				newCommon.custom = newCommon.custom ?? {};
				newCommon.custom[this.historyId] = Object.assign(
					{												// defaults
						"storageType":					"",
						"counter":						false,
						"aliasId":						"",
						"debounceTime":					0,
						"blockTime":					0,
						"changesOnly":					true,
						"changesRelogInterval":			0,
						"changesMinDelta":				0,
						"ignoreBelowNumber":			"",
						"disableSkippedValueLogging":	false,
						"retention":					0,
						"customRetentionDuration":		365,
						"maxLength":					0,
						"enableDebugLogs":				false,
						"debounce":						1000
					},
					oldCustom[this.historyId],						// existing values take precedence over defaults
					opts.history,									// caller opts take final precedence
				);
			} else if (oldCustom[this.historyId] !== undefined) {
				newCommon.custom = newCommon.custom ?? {};
				newCommon.custom[this.historyId] = null;			// null removes history from ioBroker object
			}
		}

		const newStateObj: ioBroker.SettableStateObject = {
			'type':		'state',
			'common':	newCommon,
			'native':	opts.native ?? {},							// Record<string, any>
		};

		if (! oldStateObj) {
			this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'writeStateObj()', 'newObj', stateId, JSON.stringify(newStateObj, null, 4));
			await this.setForeignObject(stateId, newStateObj);
			const stateObj = await this.getForeignObjectAsync(stateId);
			if (! stateObj  ||  stateObj.type !== 'state') {
				throw new Error(`${this.constructor.name}: writeStateObj(): ${stateId}: missing`);
			}
			return stateObj;

		} else {
			const diffs = deepDiff(oldStateObj.common, newCommon) ?? [];
			for (const diff of diffs) {
				const { path, kind } = diff;
				const pathStr = (path ?? ['']).map(val => String(val)).join('.');
				if		(kind === 'N')  { this.logf.info('%-15s %-15s %-10s %-50s %s: %s',			this.constructor.name, 'writeStateObj()', 'added',   stateId, pathStr, JSON.stringify(diff.rhs));							}
				else if (kind === 'D')  { this.logf.info('%-15s %-15s %-10s %-50s %s: %s',			this.constructor.name, 'writeStateObj()', 'deleted', stateId, pathStr, JSON.stringify(diff.lhs));							}
				else if (kind === 'E')  { this.logf.info('%-15s %-15s %-10s %-50s %s: %s -> %s',	this.constructor.name, 'writeStateObj()', 'edited',  stateId, pathStr, JSON.stringify(diff.lhs), JSON.stringify(diff.rhs));	}
				else  /* kind === 'A'*/ { this.logf.info('%-15s %-15s %-10s %-50s %s: %s',			this.constructor.name, 'writeStateObj()', 'changed', stateId, pathStr, JSON.stringify(diff.item));							}
			}

			if (diffs.length > 0) {
				await this.extendForeignObjectAsync(stateId, newStateObj);
				const stateObj = await this.getForeignObjectAsync(stateId);
				if (stateObj?.type !== 'state') {
					throw new Error(`${this.constructor.name}: writeStateObj(): ${stateId}: invalid object type '${stateObj?.type ?? 'undefined'}'`);
				}
				return stateObj;

			} else {
				return oldStateObj;
			}
		}
	}


	/* Returns the ioBroker state object for stateId, or null if missing or not of type 'state'. */
	public async readStateObject(stateId: string): Promise<ioBroker.StateObject | null> {
		const obj = await this.getForeignObjectAsync(stateId) ?? null;
		return (obj?.type === 'state') ? obj : null;
	}


	/* Writes a raw ioBroker state. Resolves after the write completes. */
	public async writeState(stateId: string, state: ioBroker.SettableState): Promise<void> {
		await this.setForeignStateAsync(stateId, state);
	}


	/* Returns the current ioBroker state for stateId, or null if not found. */
	public async readState(stateId: string): Promise<ioBroker.State | null> {
		const  state = await this.getForeignStateAsync(stateId);
		return state ?? null;
	}


	/**
	 * Registers `spec.cb` for state changes on `spec.stateId`.
	 * The foreign-state subscription is created on first subscriber and released on last unsubscribe.
	 * Multiple specs for the same `stateId` are dispatched independently; each filters by its own `val`/`ack`.
	 */
	public async subscribe(spec: StateChangeOpts): Promise<void> {
		const stateId	= spec.stateId;
		const specs		= this.stateChangeSpecs[stateId] = this.stateChangeSpecs[stateId]  ??  [];
		const len		= specs.push(spec);
		this.logf.debug('%-15s %-15s %-10s %-50s %-4s %s', this.constructor.name, 'subscribe()', `#${String(len - 1)}`, stateId, String('val' in spec ? spec.val : 'any'), ('ack' in spec ? (spec.ack ? 'ack' : 'cmd') : '*'));
		if (len === 1) {
			const stateObj = await this.readStateObject(stateId);
			if (stateObj) {
				await this.subscribeForeignStatesAsync(stateId);
			} else {
				this.logf.warn('%-15s %-15s %-10s %-50s', this.constructor.name, 'subscribe()', 'not found', stateId);
			}
		}
	}


	/* Removes spec from the dispatch list for spec.stateId; unsubscribes from ioBroker when the last spec is removed. */
	public async unsubscribe(spec: StateChangeOpts): Promise<void> {
		const stateId  = spec.stateId;
		const specs		= (this.stateChangeSpecs[stateId]  ??  []).filter((s) => (s !== spec));
		this.stateChangeSpecs[stateId] = specs;
		this.logf.debug('%-15s %-15s %-10s %-50s %-4s %s', this.constructor.name, 'unsubscribe()', `#${String(specs.length)}`, stateId, String('val' in spec ? spec.val : 'any'), ('ack' in spec ? (spec.ack ? 'ack' : 'cmd') : '*'));
		if (specs.length === 0) {
			await this.unsubscribeForeignStatesAsync(stateId);
		}
	}



	/* Dispatches a state-change event to all registered specs for stateId, filtering by val/ack if specified. */
	private async onStateChange(stateId: string, { val, ack, ts }: { val: ValType, ack: boolean, ts: number }): Promise<void> {
		const specs = this.stateChangeSpecs[stateId];
		if (! specs) {
			this.logf.error('%-15s %-15s %-10s %-50s %s   %-3s %s', this.constructor.name, 'onStateChange()', 'no spec', stateId, dateStr(ts), (ack ? '' : 'cmd'), valStr(val));

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


	/* Schedules cb under the shared mutex, serialized with state-change dispatch. */
	public setTimeoutAsync(cb: () => Promise<void>, ms: number): ioBroker.Timeout {
		return this.setTimeout(() => {
			this.mutex.runExclusive(async () => {
				await cb();
			}).catch((err: unknown) => {
				const msg = (err instanceof Error) ? (err.stack ?? err.message) : String(err);
				this.logf.error('%-15s %-15s %-10s\n%s', this.constructor.name, 'setTimeoutAsync()', 'error', msg);
			});
		}, ms) ?? null;
	}

	/* Schedules a recurring cb under the shared mutex, serialized with state-change dispatch. */
	public setIntervalAsync(cb: () => Promise<void>, ms: number): ioBroker.Interval {
		return this.setInterval(() => {
			this.mutex.runExclusive(async () => {
				await cb();
			}).catch((err: unknown) => {
				const msg = (err instanceof Error) ? (err.stack ?? err.message) : String(err);
				this.logf.error('%-15s %-15s %-10s\n%s', this.constructor.name, 'setIntervalAsync()', 'error', msg);
			});
		}, ms) ?? null;
	}
}
